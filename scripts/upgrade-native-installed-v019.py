#!/usr/bin/env python3
"""Owner-reviewed, fail-closed v0.1.8 to v0.1.9 native upgrade. Never run in source tests."""
from pathlib import Path
import datetime,hashlib,json,os,plistlib,re,shutil,sqlite3,subprocess,sys,time,uuid

ROOT=Path(__file__).resolve().parents[1]; HOME=Path.home(); BASE=HOME/'Library/Application Support/Theo Synapse'; CORE=BASE/'core'; INSTALLED=HOME/'Applications'/'Theo Synapse.app'
BUILD_ROOT=ROOT/'.local'/'native-macos-20261029'/'native-build'; AUDIT=BASE/'upgrade-audit'; READONLY='tech.oppstudio.theosynapse.desktop.readonly'; os.umask(0o077)
REQUIRED={'src/direct-action-review.mjs','src/direct-coordinator.mjs','src/codex-adapter.mjs','src/mcp.mjs','scripts/desktop-smoke.mjs','scripts/theo-direct-daemon-entry.mjs'}; HISTORICAL_STATES="'UNKNOWN','DENIED','COMPLETED'"
def check(v,c):
 if not v: raise RuntimeError(c)
def sha(b): return hashlib.sha256(b).hexdigest()
def filehash(p): return sha(p.read_bytes())
def code_for(e):
 v=str(e); return v if re.fullmatch(r'[A-Z0-9_]{3,90}',v) else 'UPGRADE_INTERNAL_FAILURE'
def move(src,dst):
 check(src.exists() and not dst.exists(),'UPGRADE_PATH_COLLISION'); src.rename(dst)
def command(a,timeout=30,fail=True):
 p=subprocess.run([str(x) for x in a],capture_output=True,text=True,stdin=subprocess.DEVNULL,timeout=timeout)
 if fail and p.returncode: raise RuntimeError('COMMAND_FAILED_'+Path(str(a[0])).name.upper().replace('-','_'))
 return p
def owned_dir(p):
 s=p.lstat(); return p.is_dir() and not p.is_symlink() and s.st_uid==os.getuid() and not s.st_mode&0o077
def meta(app):
 with (app/'Contents/Info.plist').open('rb') as f:return plistlib.load(f)
def verify_signed(app):
 check(app.is_dir() and not app.is_symlink(),'APP_DIR_UNSAFE'); check(meta(app).get('CFBundleIdentifier')=='tech.oppstudio.theosynapse.desktop','BUNDLE_ID_MISMATCH')
 command(['/usr/bin/codesign','--verify','--deep','--strict',app],40); d=command(['/usr/bin/codesign','-dvv',app],40,False); check(d.returncode==0 and 'Authority=Developer ID Application:' in d.stderr,'DEVELOPER_ID_SIGNATURE_REQUIRED')
 command(['/usr/bin/xcrun','stapler','validate',app],40); command(['/usr/sbin/spctl','--assess','--type','execute',app],40)
def candidate_path(raw):
 p=Path(raw); check(p.is_absolute() and p.name=='Theo Synapse.app','CANDIDATE_PATH_UNAUTHORIZED'); check(BUILD_ROOT.is_dir() and owned_dir(BUILD_ROOT) and p.parent.parent==BUILD_ROOT and owned_dir(p.parent),'NATIVE_BUILD_DIRECTORY_UNSAFE'); check(p.is_dir() and not p.is_symlink() and p.resolve()==p,'CANDIDATE_PATH_UNSAFE'); return p
def native(action,timeout=35):
 p=command([INSTALLED/'Contents/MacOS/TheoSynapse','--manage',action],timeout)
 try:d=json.loads(p.stdout)
 except:raise RuntimeError('NATIVE_MANAGER_BAD_JSON')
 check(isinstance(d,dict) and 'error' not in d,'NATIVE_MANAGER_OPERATION_FAILED'); return d
def direct_host_active(): return any('theo-direct-daemon-entry.mjs' in x for x in command(['/bin/ps','-axo','pid=,command='],fail=False).stdout.splitlines())
def readonly_managed(state):
 # v0.1.8 exposes authenticated hostState and owned LaunchAgent booleans, not serviceLabel.
 # Require a live, byte-for-byte-owned READONLY(8) service and zero active work.
 return (state.get('appVersion')=='0.1.8' and state.get('hostState')=='READONLY(8)' and state.get('mode')=='read_only' and
  state.get('running') is True and state.get('launchAgentLoaded') is True and
  state.get('readonlyLaunchAgentLoaded') is True and state.get('directLaunchAgentLoaded') is False and
  state.get('readOnly') is True and state.get('writeEnabled') is False and
  state.get('activeTasks')==0 and state.get('directActiveRuns')==0)
def readonly_launchagent(state):
 directory=HOME/'Library/LaunchAgents'; check(directory.is_dir() and not directory.is_symlink(),'UNRECOGNIZED_LAUNCHAGENT')
 files=list(directory.glob('tech.oppstudio.theosynapse.desktop.*.plist')); check([p.name for p in files]==[READONLY+'.plist'],'UNRECOGNIZED_LAUNCHAGENT')
 p=files[0]; check(p.is_file() and not p.is_symlink() and p.stat().st_uid==os.getuid() and p.stat().st_mode&0o077==0,'UNRECOGNIZED_LAUNCHAGENT')
 try:d=plistlib.loads(p.read_bytes())
 except:raise RuntimeError('UNRECOGNIZED_LAUNCHAGENT')
 expected={'Label','ProgramArguments','WorkingDirectory','RunAtLoad','KeepAlive','ThrottleInterval','Umask','EnvironmentVariables','StandardOutPath','StandardErrorPath'}; env={'HOME':str(HOME),'PATH':str(HOME/'.local/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin','LANG':'ja_JP.UTF-8'}
 check(set(d)==expected and d.get('Label')==READONLY and d.get('ProgramArguments',[None,None])[1]==str(CORE/'scripts/task-daemon-entry.mjs') and d.get('WorkingDirectory')==str(CORE) and d.get('RunAtLoad') is True and d.get('KeepAlive') is False and d.get('ThrottleInterval')==20 and d.get('Umask')==63 and d.get('EnvironmentVariables')==env and d.get('StandardOutPath')==str(CORE/'.local/theo-runtime/desktop.stdout.log') and d.get('StandardErrorPath')==str(CORE/'.local/theo-runtime/desktop.stderr.log'),'UNRECOGNIZED_LAUNCHAGENT')
 # launchAgentLoaded is true only when v0.1.8 DesktopHost's byte-for-byte ownedAgent check passes.
 check(readonly_managed(state),'ORIGINAL_READONLY_LAUNCHAGENT_NOT_RUNNING')
def active(path,table,states):
 if not path.exists(): return 0
 check(path.is_file() and not path.is_symlink() and path.stat().st_size<=64_000_000,'EXISTING_JOURNAL_UNSAFE')
 try:
  db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True); n=int(db.execute('SELECT COUNT(*) FROM '+table+' WHERE state IN ('+states+')').fetchone()[0]); db.close(); return n
 except sqlite3.Error: raise RuntimeError('EXISTING_JOURNAL_UNREADABLE')
def inventory(local):
 check(local.is_dir() and owned_dir(local),'EXISTING_PRIVATE_RUNTIME_MISSING'); a=[]
 for p in sorted(local.rglob('*')):
  s=p.lstat()
  if p.is_symlink(): raise RuntimeError('EXISTING_PRIVATE_RUNTIME_SYMLINK')
  check(s.st_uid==os.getuid() and not s.st_mode&0o077,'EXISTING_PRIVATE_RUNTIME_UNSAFE')
  if p.is_file(): a.append((p.relative_to(local).as_posix(),s.st_size,filehash(p)))
 return sha(json.dumps(a,separators=(',',':')).encode())
def stable_direct_records(path):
 check(path.is_file() and not path.is_symlink(),'EXISTING_JOURNAL_UNSAFE')
 try:
  db=sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True); rows=db.execute('SELECT task_id,iteration,workspace_id,mode,digest,state,result,error_code,created_at,updated_at FROM direct_runs WHERE state IN ('+HISTORICAL_STATES+') ORDER BY task_id,iteration').fetchall(); db.close()
 except sqlite3.Error: raise RuntimeError('EXISTING_JOURNAL_UNREADABLE')
 return sha(json.dumps(rows,separators=(',',':'),ensure_ascii=False).encode())
def private_tree(folder):
 s=folder.lstat(); check(folder.is_dir() and not folder.is_symlink() and s.st_uid==os.getuid() and (s.st_mode&0o777)==0o700,'STAGED_CORE_PERMISSIONS_INVALID')
 for p in folder.rglob('*'):
  s=p.lstat(); check(not p.is_symlink() and s.st_uid==os.getuid(),'STAGED_CORE_UNSAFE')
  if p.is_dir(): check((s.st_mode&0o777)==0o700,'STAGED_CORE_PERMISSIONS_INVALID')
  else: check(p.is_file() and s.st_nlink==1 and (s.st_mode&0o777)==0o600,'STAGED_CORE_PERMISSIONS_INVALID')
def verify_manifest(app,folder):
 manifest=app/'Contents/Resources/core-manifest.json'; check(manifest.is_file() and not manifest.is_symlink(),'CORE_MANIFEST_INVALID')
 m=json.loads(manifest.read_text()); names={x.get('path') for x in m.get('files',[]) if isinstance(x,dict)}; check(m.get('schema')==1 and len(m.get('files',[]))>3000 and REQUIRED.issubset(names),'CORE_MANIFEST_INVALID')
 for x in m['files']:
  p=folder/x['path']; check(p.is_file() and not p.is_symlink() and p.stat().st_size==x['bytes'] and filehash(p)==x['sha256'],'CORE_MANIFEST_HASH_MISMATCH')
 return len(m['files']),filehash(manifest)
def preflight(state):
 check(not direct_host_active(),'DIRECT_HOST_ACTIVE_UPGRADE_DENIED'); readonly_launchagent(state); local=CORE/'.local'; check(active(local/'direct.sqlite','direct_runs',"'APPROVAL_PENDING','QUEUED','RUNNING'")+active(local/'writes.sqlite','theo_write_requests',"'APPROVAL_PENDING','AUTHORIZED','RUNNING'")==0,'ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED')
 registry=local/'theo-runtime/projects.json'; direct_registry=local/'theo-runtime/direct-workspaces.json'; journal=local/'theo-runtime/direct.sqlite'
 # SQLite WAL/SHM bytes may change after a clean restart; these records must not.
 return inventory(local),filehash(registry),filehash(direct_registry),stable_direct_records(journal)
def plan(raw,expected_sha):
 candidate=candidate_path(raw); check(re.fullmatch('[0-9a-f]{64}',expected_sha or '') is not None,'CANDIDATE_SHA256_INVALID'); check(filehash(candidate/'Contents/MacOS/TheoSynapse')==expected_sha,'CANDIDATE_SHA256_MISMATCH'); verify_signed(INSTALLED); verify_signed(candidate)
 check(meta(INSTALLED).get('CFBundleShortVersionString')=='0.1.8','CURRENT_APP_VERSION_UNEXPECTED'); check(meta(candidate).get('CFBundleShortVersionString')=='0.1.9' and meta(candidate).get('CFBundleVersion')=='12','CANDIDATE_VERSION_UNEXPECTED')
 state=native('status'); check(readonly_managed(state),'ORIGINAL_READONLY_LAUNCHAGENT_NOT_RUNNING'); runtime,registry,direct_registry,direct_history=preflight(state); files,manifest=verify_manifest(candidate,candidate/'Contents/Resources/Core')
 facts={'kind':'THEO_NATIVE_UPGRADE_0_1_9','oldVersion':'0.1.8','newVersion':'0.1.9','oldApp':str(INSTALLED),'newApp':str(candidate),'candidateExecutableSHA256':expected_sha,'candidateManifestSHA256':manifest,'sourceManifestSHA256':filehash(candidate/'Contents/Resources/core-manifest.json'),'runtimeSHA256':runtime,'readonlyRegistrySHA256':registry,'directRegistrySHA256':direct_registry,'directHistoricalRecordsSHA256':direct_history,'currentHistoryCount':state.get('historyCount'),'newCoreFiles':files,'directHostInactive':True,'directPlistAbsent':True}; return facts,sha(json.dumps(facts,sort_keys=True).encode())[:20]
def execute(raw,expected,review):
 facts,code=plan(raw,expected); check(review==code,'OWNER_REVIEW_FINGERPRINT_MISMATCH'); check(not direct_host_active(),'DIRECT_HOST_ACTIVE_UPGRADE_DENIED'); candidate=candidate_path(raw); uid=uuid.uuid4().hex[:12]
 stage_app=INSTALLED.parent/('.TheoSynapse-staged-'+uid+'.app'); backup_app=INSTALLED.parent/('.TheoSynapse-backup-0.1.8-'+uid+'.app'); failed_app=INSTALLED.parent/('.TheoSynapse-failed-0.1.9-'+uid+'.app'); stage_core=BASE/('core-staged-'+uid); backup_core=BASE/('core-backup-0.1.8-'+uid); failed_core=BASE/('core-failed-0.1.9-'+uid)
 for p in (stage_app,backup_app,failed_app,stage_core,backup_core,failed_core): check(not p.exists(),'UPGRADE_PATH_COLLISION')
 report={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousVersion':'0.1.8','candidateVersion':'0.1.9','reviewCode':code,'status':'STARTED','error':None,'steps':[],'backupStatus':'NOT_CREATED','restored':False,'directHostTouched':False,'modelTurnStarted':False,'legacyTunnelModified':False}; stopped=app_swapped=core_swapped=runtime_moved=False
 def mark(step): report['steps'].append(step); print('UPGRADE_STEP',step,flush=True)
 def save(status,error=None):
  report['status']=status; report['error']=error
  if not AUDIT.exists(): AUDIT.mkdir(parents=True,mode=0o700)
  check(owned_dir(AUDIT),'UPGRADE_AUDIT_DIRECTORY_UNSAFE'); p=AUDIT/('native-upgrade-v019-'+uid+'.json')
  with p.open('x',encoding='utf-8') as f: json.dump(report,f,ensure_ascii=False,indent=2)
  p.chmod(0o600); print('UPGRADE_AUDIT',p.name,'STATUS',status,flush=True)
 try:
  command(['/usr/bin/ditto',candidate,stage_app],90); verify_signed(stage_app); mark('STAGED_NOTARIZED_APP'); shutil.copytree(candidate/'Contents/Resources/Core',stage_core,symlinks=False)
  for p in stage_core.rglob('*'): p.chmod(0o700 if p.is_dir() else 0o600)
  stage_core.chmod(0o700); private_tree(stage_core); files,stage_manifest=verify_manifest(candidate,stage_core); check(files==facts['newCoreFiles'] and stage_manifest==facts['candidateManifestSHA256'] and stage_manifest==facts['sourceManifestSHA256'],'CANDIDATE_MANIFEST_CHANGED'); mark('STAGED_PRIVATE_CORE')
  gui=command(['/usr/bin/osascript','-e','tell application id "tech.oppstudio.theosynapse.desktop" to quit'],12,False); check(gui.returncode==0,'GUI_QUIT_NOT_GRANTED'); time.sleep(1); state=native('status'); check(preflight(state)[0]==facts['runtimeSHA256'],'PRIVATE_RUNTIME_CHANGED_BEFORE_STOP'); check(readonly_managed(state),'ORIGINAL_READONLY_LAUNCHAGENT_NOT_RUNNING')
  native('stop'); stopped=True; check(not native('status').get('running'),'SERVICE_STOP_UNVERIFIED'); mark('NATIVE_READONLY_LAUNCHAGENT_STOPPED'); check(not direct_host_active(),'DIRECT_HOST_ACTIVE_UPGRADE_DENIED'); quiet=inventory(CORE/'.local'); check(filehash(CORE/'.local/theo-runtime/projects.json')==facts['readonlyRegistrySHA256'] and filehash(CORE/'.local/theo-runtime/direct-workspaces.json')==facts['directRegistrySHA256'] and stable_direct_records(CORE/'.local/theo-runtime/direct.sqlite')==facts['directHistoricalRecordsSHA256'],'STABLE_PRIVATE_STATE_CHANGED_BEFORE_SWAP')
  move(CORE,backup_core); core_swapped=True; report['backupStatus']='CORE_BACKED_UP'; move(backup_core/'.local',stage_core/'.local'); runtime_moved=True; check(inventory(stage_core/'.local')==quiet,'PRIVATE_RUNTIME_CHANGED'); mark('PRIVATE_NATIVE_STATE_PRESERVED_BY_RENAME'); move(stage_core,CORE); mark('CORE_SWAPPED_WITH_BACKUP'); move(INSTALLED,backup_app); app_swapped=True; report['backupStatus']='APP_AND_CORE_BACKED_UP'; move(stage_app,INSTALLED); verify_signed(INSTALLED); private_tree(CORE); files,installed_manifest=verify_manifest(INSTALLED,CORE); check(files==facts['newCoreFiles'] and installed_manifest==facts['candidateManifestSHA256'] and installed_manifest==facts['sourceManifestSHA256'],'INSTALLED_MANIFEST_CHANGED'); mark('NOTARIZED_APP_SWAPPED_WITH_BACKUP')
  check(native('verify').get('verdict')=='PASS','NEW_CORE_VERIFY_FAILED'); started=native('start',timeout=35); check(started.get('running') is True and started.get('mode')=='read_only' and started.get('launchAgentLoaded') is True,'NEW_SERVICE_START_UNVERIFIED'); smoke=native('smoke',timeout=35); check(smoke.get('verdict')=='PASS' and smoke.get('toolCount')==8 and smoke.get('directEnabled') is False and smoke.get('writeEnabled') is False,'NEW_MCP_SMOKE_FAILED'); after=native('status'); check(after.get('running') and after.get('readOnly') is True and after.get('writeEnabled') is False and after.get('activeTasks')==0 and after.get('historyCount')==facts['currentHistoryCount'],'NEW_GUI_STATUS_UNVERIFIED'); check(filehash(CORE/'.local/theo-runtime/projects.json')==facts['readonlyRegistrySHA256'] and filehash(CORE/'.local/theo-runtime/direct-workspaces.json')==facts['directRegistrySHA256'] and stable_direct_records(CORE/'.local/theo-runtime/direct.sqlite')==facts['directHistoricalRecordsSHA256'],'STABLE_PRIVATE_STATE_CHANGED_AFTER_RESTART'); mark('NEW_NATIVE_CORE_RUNNING_AND_VERIFIED'); report['finalPid']=after.get('pid'); report['newAppVersion']=meta(INSTALLED).get('CFBundleShortVersionString'); save('PASS_INSTALLED_V019')
 except Exception as e:
  error=code_for(e); print('UPGRADE_ERROR',error,flush=True); rollback_good=False
  try:
   if app_swapped:
    try:native('stop')
    except:pass
    if INSTALLED.exists(): move(INSTALLED,failed_app)
    if backup_app.exists(): move(backup_app,INSTALLED)
   if core_swapped:
    if CORE.exists(): move(CORE,failed_core)
    if runtime_moved:
     for holder in (failed_core,stage_core):
      if (holder/'.local').exists(): move(holder/'.local',backup_core/'.local'); break
     else: raise RuntimeError('ROLLBACK_RUNTIME_MISSING')
    if backup_core.exists(): move(backup_core,CORE)
   if stopped and INSTALLED.exists() and CORE.exists():
    old=native('start',timeout=35); restored=native('status'); rollback_good=old.get('running') is True and restored.get('running') is True and restored.get('mode')=='read_only' and restored.get('launchAgentLoaded') is True and restored.get('readOnly') is True and restored.get('writeEnabled') is False and meta(INSTALLED).get('CFBundleShortVersionString')=='0.1.8' and filehash(CORE/'.local/theo-runtime/projects.json')==facts['readonlyRegistrySHA256'] and filehash(CORE/'.local/theo-runtime/direct-workspaces.json')==facts['directRegistrySHA256'] and stable_direct_records(CORE/'.local/theo-runtime/direct.sqlite')==facts['directHistoricalRecordsSHA256']
   report['restored']=rollback_good; report['backupStatus']='ORIGINAL_RESTORED' if rollback_good else report['backupStatus']
  except Exception: rollback_good=False; report['restored']=False
  save('FAIL_ROLLED_BACK' if rollback_good else 'UNKNOWN_MANUAL_RECOVERY_REQUIRED',error); raise
 return report
if __name__=='__main__':
 if len(sys.argv)==4 and sys.argv[1]=='plan':
  f,c=plan(sys.argv[2],sys.argv[3]); print(json.dumps({'status':'READY_TO_UPGRADE','reviewCode':c,'oldVersion':f['oldVersion'],'newVersion':f['newVersion'],'directHostInactive':True,'noLegacyTunnelMigration':True,'newCoreFiles':f['newCoreFiles']}))
 elif len(sys.argv)==5 and sys.argv[1]=='execute': execute(sys.argv[2],sys.argv[3],sys.argv[4])
 else: print('Usage: upgrade-native-installed-v019.py plan CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 | execute CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 20_HEX_REVIEW_CODE'); sys.exit(2)
