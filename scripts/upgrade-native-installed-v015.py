#!/usr/bin/env python3
"""Owner-reviewed v0.1.4 to v0.1.5 upgrade. It fails closed around any direct host."""
from pathlib import Path
import datetime,hashlib,json,os,plistlib,re,shutil,sqlite3,subprocess,sys,time,uuid
ROOT=Path(__file__).resolve().parents[1]; HOME=Path.home(); BASE=HOME/"Library/Application Support/Theo Synapse"; CORE=BASE/"core"; INSTALLED=HOME/"Applications"/"Theo Synapse.app"
BUILD_ROOT=ROOT/".local"/"native-macos-20261029"/"native-build"; AUDIT=BASE/"upgrade-audit"
REQUIRED_DIRECT_SOURCE={"src/direct-coordinator.mjs","src/direct-native-factory.mjs","src/direct-workspace-registry.mjs","src/direct-owner-approval.mjs","scripts/theo-direct-workspaces.mjs","scripts/theo-direct-daemon-entry.mjs","scripts/theo-task-entry.mjs"}
DIAGNOSTIC_CODE=("error_code TEXT","ALTER TABLE direct_runs ADD COLUMN error_code TEXT","reasonCode:storedDiagnosisCode(r.error_code)","providerFinished:['COMPLETED','FAILED'].includes(r.state)","state='UNKNOWN',error_code='DIRECT_EXECUTION_UNVERIFIED'")
ABORT_FORWARDING="ownerAuthorization:(context,options)=>ownerApproval(context,options)"; os.umask(0o077)
def sha(data): return hashlib.sha256(data).hexdigest()
def filehash(path): return sha(path.read_bytes())
def check(value,reason):
 if not value: raise RuntimeError(reason)
def command(args,timeout=25,allow_failure=False):
 p=subprocess.run([str(a) for a in args],capture_output=True,text=True,stdin=subprocess.DEVNULL,timeout=timeout)
 if p.returncode and not allow_failure: raise RuntimeError("COMMAND_FAILED_"+Path(str(args[0])).name.upper().replace("-","_"))
 return p
def meta(app):
 with (app/"Contents/Info.plist").open("rb") as f: return plistlib.load(f)
def bundle_meta(app):
 d=meta(app); return d.get("CFBundleIdentifier"),d.get("CFBundleShortVersionString")
def owned_dir(path):
 s=path.lstat(); return path.is_dir() and not path.is_symlink() and s.st_uid==os.getuid() and not s.st_mode&0o077
def candidate_path(raw):
 path=Path(raw); check(path.is_absolute(),"CANDIDATE_PATH_NOT_ABSOLUTE"); check(BUILD_ROOT.is_dir() and owned_dir(BUILD_ROOT),"NATIVE_BUILD_DIRECTORY_UNSAFE")
 check(path.name=="Theo Synapse.app" and path.parent.parent==BUILD_ROOT and owned_dir(path.parent),"CANDIDATE_PATH_UNAUTHORIZED")
 check(path.is_dir() and not path.is_symlink() and path.resolve()==path,"CANDIDATE_PATH_UNSAFE"); return path
def sha_arg(value):
 check(isinstance(value,str) and len(value)==64 and all(c in "0123456789abcdef" for c in value),"CANDIDATE_SHA256_INVALID"); return value
def native(action,app=INSTALLED,timeout=25):
 p=command([app/"Contents/MacOS/TheoSynapse","--manage",action],timeout)
 try: data=json.loads(p.stdout)
 except: raise RuntimeError("NATIVE_MANAGER_BAD_JSON")
 check(isinstance(data,dict) and "error" not in data,"NATIVE_MANAGER_OPERATION_FAILED"); return data
def verify_signed(app):
 check(app.is_dir() and not app.is_symlink(),"APP_DIR_UNSAFE"); check(bundle_meta(app)[0]=="tech.oppstudio.theosynapse.desktop","BUNDLE_ID_MISMATCH")
 command(["/usr/bin/codesign","--verify","--deep","--strict",app],40); details=command(["/usr/bin/codesign","-dvv",app],40,True)
 check(details.returncode==0 and "Authority=Developer ID Application:" in details.stderr,"DEVELOPER_ID_SIGNATURE_REQUIRED")
 command(["/usr/bin/xcrun","stapler","validate",app],40); command(["/usr/sbin/spctl","--assess","--type","execute",app],40)
def verify_diagnostic(folder):
 source=(folder/"src/direct-coordinator.mjs").read_text(encoding="utf-8")
 check(all(token in source for token in DIAGNOSTIC_CODE),"CORE_DIRECT_DIAGNOSTIC_FIX_MISSING")
def verify_manifest(source,folder):
 m=json.loads((source/"Contents/Resources/core-manifest.json").read_text()); check(m.get("schema")==1 and len(m.get("files",[]))>3000,"CORE_MANIFEST_INVALID")
 names={it.get("path") for it in m["files"] if isinstance(it,dict)}; check(REQUIRED_DIRECT_SOURCE.issubset(names),"CORE_DIRECT_SOURCE_MISSING")
 for it in m["files"]:
  p=folder/it["path"]; check(p.is_file() and not p.is_symlink() and filehash(p)==it["sha256"] and p.stat().st_size==it["bytes"],"CORE_MANIFEST_HASH_MISMATCH")
 check(ABORT_FORWARDING in (folder/"src/direct-native-factory.mjs").read_text(encoding="utf-8"),"CORE_ABORT_SIGNAL_FORWARDING_MISSING"); verify_diagnostic(folder); return len(m["files"])
def direct_host_active():
 p=command(["/bin/ps","-axo","pid=,command="],allow_failure=True)
 return any("theo-direct-daemon-entry.mjs" in line for line in p.stdout.splitlines())
def active_sqlite(path,table,states):
 if not path.exists(): return 0
 check(path.is_file() and not path.is_symlink() and path.stat().st_size<=64_000_000,"EXISTING_JOURNAL_UNSAFE")
 try:
  db=sqlite3.connect("file:"+str(path)+"?mode=ro",uri=True); row=db.execute("SELECT COUNT(*) FROM "+table+" WHERE state IN ("+states+")").fetchone(); db.close(); return int(row[0])
 except sqlite3.Error: raise RuntimeError("EXISTING_JOURNAL_UNREADABLE")
def runtime_inventory(local):
 check(local.is_dir() and owned_dir(local),"EXISTING_PRIVATE_RUNTIME_MISSING")
 records=[]
 for p in sorted(local.rglob("*")):
  if p.is_symlink(): raise RuntimeError("EXISTING_PRIVATE_RUNTIME_SYMLINK")
  if p.is_file(): records.append((p.relative_to(local).as_posix(),p.stat().st_size,filehash(p)))
 return sha(json.dumps(records,separators=(",",":"),ensure_ascii=False).encode())
def safe_preflight():
 check(not direct_host_active(),"DIRECT_HOST_ACTIVE_UPGRADE_DENIED")
 local=CORE/".local"; active=active_sqlite(local/"direct.sqlite","direct_runs","'APPROVAL_PENDING','QUEUED','RUNNING'")+active_sqlite(local/"writes.sqlite","theo_write_requests","'APPROVAL_PENDING','AUTHORIZED','RUNNING'")
 check(active==0,"ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED"); return runtime_inventory(local)
def candidate_plan(raw_candidate,expected_candidate_sha):
 check(INSTALLED.is_dir() and CORE.is_dir(),"CURRENT_MAC_APP_NOT_INSTALLED"); candidate=candidate_path(raw_candidate); expected_candidate_sha=sha_arg(expected_candidate_sha)
 check(filehash(candidate/"Contents/MacOS/TheoSynapse")==expected_candidate_sha,"CANDIDATE_SHA256_MISMATCH"); verify_signed(INSTALLED); verify_signed(candidate)
 check(bundle_meta(INSTALLED)[1]=="0.1.4","CURRENT_APP_VERSION_UNEXPECTED"); check(bundle_meta(candidate)[1]=="0.1.5","CANDIDATE_VERSION_UNEXPECTED"); check(meta(candidate).get("CFBundleVersion")=="7","CANDIDATE_BUILD_VERSION_UNEXPECTED")
 private_hash=safe_preflight(); current=native("status")
 check(current.get("installed") and current.get("running") and current.get("launchAgentLoaded") is True and current.get("readOnly") is True and current.get("writeEnabled") is False and current.get("activeTasks")==0,"NATIVE_SERVICE_NOT_IDLE")
 check(isinstance(current.get("historyCount"),int) and current["historyCount"]>=0,"NATIVE_TASK_STATE_INVALID"); check(native("verify").get("verdict")=="PASS","OLD_CORE_VERIFY_FAILED")
 files_new=verify_manifest(candidate,candidate/"Contents/Resources/Core")
 facts={"kind":"THEO_NATIVE_UPGRADE_0_1_5","oldApp":str(INSTALLED),"newApp":str(candidate),"oldVersion":"0.1.4","newVersion":"0.1.5","newExecutableSHA256":filehash(candidate/"Contents/MacOS/TheoSynapse"),"newManifestSHA256":filehash(candidate/"Contents/Resources/core-manifest.json"),"currentExecutableSHA256":filehash(INSTALLED/"Contents/MacOS/TheoSynapse"),"privateRuntimeInventorySHA256":private_hash,"readonlyRegistrySHA256":filehash(CORE/".local/theo-runtime/projects.json"),"nativePid":current.get("pid"),"currentHistoryCount":current["historyCount"],"newCoreFiles":files_new,"directHostInactive":True}
 return facts,sha(json.dumps(facts,ensure_ascii=False,sort_keys=True).encode())[:20]
def install(raw_candidate,candidate_sha,expected):
 facts,review=candidate_plan(raw_candidate,candidate_sha); check(expected==review,"OWNER_REVIEW_FINGERPRINT_MISMATCH"); check(not direct_host_active(),"DIRECT_HOST_ACTIVE_UPGRADE_DENIED"); candidate=candidate_path(raw_candidate); uid=uuid.uuid4().hex[:12]
 stage_app=INSTALLED.parent/(".TheoSynapse-staged-"+uid+".app"); backup_app=INSTALLED.parent/(".TheoSynapse-backup-0.1.4-"+uid+".app"); failed_app=INSTALLED.parent/(".TheoSynapse-failed-0.1.5-"+uid+".app")
 stage_core=BASE/("core-staged-"+uid); backup_core=BASE/("core-backup-0.1.4-"+uid); failed_core=BASE/("core-failed-0.1.5-"+uid)
 for p in (stage_app,backup_app,failed_app,stage_core,backup_core,failed_core): check(not p.exists(),"UPGRADE_PATH_COLLISION")
 report={"startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"previousVersion":"0.1.4","candidateVersion":"0.1.5","reviewCode":review,"status":"STARTED","backupApp":str(backup_app),"backupCore":str(backup_core),"steps":[],"legacyTunnelModified":False,"directHostTouched":False,"modelTurnStarted":False}; stopped=app_swapped=core_swapped=runtime_moved=False
 def mark(step): report["steps"].append(step); print("UPGRADE_STEP",step,flush=True)
 def save(status,error=None):
  report["status"]=status; report["error"]=error; AUDIT.mkdir(parents=True,mode=0o700,exist_ok=True); check(owned_dir(AUDIT),"UPGRADE_AUDIT_DIRECTORY_UNSAFE"); p=AUDIT/("native-upgrade-v015-"+uid+".json")
  with p.open("x",encoding="utf-8") as f: json.dump(report,f,ensure_ascii=False,indent=2)
  print("UPGRADE_AUDIT",p.name,"STATUS",status,flush=True)
 try:
  command(["/usr/bin/ditto",candidate,stage_app],90); verify_signed(stage_app); mark("STAGED_NOTARIZED_APP")
  shutil.copytree(candidate/"Contents/Resources/Core",stage_core,symlinks=False)
  for p in stage_core.rglob("*"):
   if p.is_symlink(): raise RuntimeError("UNEXPECTED_STAGING_SYMLINK")
   p.chmod(0o700 if p.is_dir() else 0o600)
  stage_core.chmod(0o700); verify_manifest(candidate,stage_core); mark("STAGED_PRIVATE_CORE")
  gui=command(["/usr/bin/osascript","-e",'tell application id "tech.oppstudio.theosynapse.desktop" to quit'],12,True); check(gui.returncode==0,"GUI_QUIT_NOT_GRANTED"); time.sleep(1)
  check(safe_preflight()==facts["privateRuntimeInventorySHA256"],"PRIVATE_RUNTIME_CHANGED_BEFORE_STOP"); current=native("status"); check(current.get("running") and current.get("launchAgentLoaded") is True and current.get("readOnly") is True and current.get("writeEnabled") is False and current.get("activeTasks")==0,"NATIVE_SERVICE_NOT_IDLE")
  native("stop"); stopped=True; check(not native("status").get("running"),"SERVICE_STOP_UNVERIFIED"); mark("NATIVE_READONLY_LAUNCHAGENT_STOPPED")
  check(not direct_host_active(),"DIRECT_HOST_ACTIVE_UPGRADE_DENIED")
  # A clean SQLite daemon stop may checkpoint/remove its WAL or SHM files.
  # Bind the plan before stop, then fingerprint the *quiescent* private runtime
  # and verify its byte-exact preservation across the directory rename.
  check(filehash(CORE/".local/theo-runtime/projects.json")==facts["readonlyRegistrySHA256"],"READONLY_REGISTRY_CHANGED_BEFORE_SWAP")
  quiescent_runtime_sha=runtime_inventory(CORE/".local")
  CORE.rename(backup_core); core_swapped=True; (backup_core/".local").rename(stage_core/".local"); runtime_moved=True; check(runtime_inventory(stage_core/".local")==quiescent_runtime_sha,"PRIVATE_RUNTIME_CHANGED"); mark("PRIVATE_NATIVE_STATE_PRESERVED_BY_RENAME")
  stage_core.rename(CORE); mark("CORE_SWAPPED_WITH_BACKUP"); INSTALLED.rename(backup_app); app_swapped=True; stage_app.rename(INSTALLED); verify_signed(INSTALLED); verify_manifest(INSTALLED,CORE); mark("NOTARIZED_APP_SWAPPED_WITH_BACKUP")
  check(native("verify").get("verdict")=="PASS","NEW_CORE_VERIFY_FAILED"); started=native("start",timeout=35); check(started.get("running") is True and started.get("activeTasks")==0,"NEW_SERVICE_START_UNVERIFIED")
  smoke=native("smoke",timeout=35); check(smoke.get("verdict")=="PASS" and smoke.get("toolCount")==8 and smoke.get("writeEnabled") is False,"NEW_MCP_SMOKE_FAILED")
  after=native("status"); check(after.get("running") and after.get("readOnly") is True and after.get("writeEnabled") is False and after.get("activeTasks")==0 and after.get("chatGPTConnection")=="UNVERIFIED","NEW_GUI_STATUS_UNVERIFIED"); check(filehash(CORE/".local/theo-runtime/projects.json")==facts["readonlyRegistrySHA256"],"NEW_READONLY_REGISTRY_CHANGED")
  mark("NEW_NATIVE_CORE_RUNNING_AND_VERIFIED"); report["finalPid"]=after.get("pid"); report["newAppVersion"]=bundle_meta(INSTALLED)[1]; save("PASS_INSTALLED_V015")
 except Exception as e:
  code=str(e)[:90] if re.match(r'^[A-Z0-9_]{3,90}$',str(e)) else type(e).__name__; print("UPGRADE_ERROR",code,flush=True); rollback_good=True
  try:
   if app_swapped:
    try: native("stop")
    except Exception: pass
    if INSTALLED.exists(): INSTALLED.rename(failed_app)
    if backup_app.exists(): backup_app.rename(INSTALLED)
   if core_swapped:
    if CORE.exists(): CORE.rename(failed_core)
    if runtime_moved:
     for holder in (failed_core,stage_core):
      if (holder/".local").exists(): check(not (backup_core/".local").exists(),"ROLLBACK_RUNTIME_COLLISION"); (holder/".local").rename(backup_core/".local"); break
     else: raise RuntimeError("ROLLBACK_RUNTIME_MISSING")
    if backup_core.exists(): backup_core.rename(CORE)
   if stopped and INSTALLED.exists(): rollback_good=native("start",timeout=35).get("running") is True and native("status").get("writeEnabled") is False
  except Exception: rollback_good=False
  save("FAIL_ROLLED_BACK" if rollback_good else "UNKNOWN_MANUAL_RECOVERY_REQUIRED",code); raise
 return report
if __name__=="__main__":
 if len(sys.argv)==4 and sys.argv[1]=="plan":
  facts,review=candidate_plan(sys.argv[2],sys.argv[3]); print(json.dumps({"status":"READY_TO_UPGRADE","reviewCode":review,"oldVersion":facts["oldVersion"],"newVersion":facts["newVersion"],"directHostInactive":True,"noLegacyTunnelMigration":True,"newCoreFiles":facts["newCoreFiles"]},ensure_ascii=False))
 elif len(sys.argv)==5 and sys.argv[1]=="execute": install(sys.argv[2],sys.argv[3],sys.argv[4])
 else: print("Usage: python3 scripts/upgrade-native-installed-v015.py plan CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 | execute CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 20_HEX_REVIEW_CODE"); sys.exit(2)
