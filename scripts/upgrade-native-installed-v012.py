#!/usr/bin/env python3
"""Owner-requested v0.1.2 upgrade of the separate signed Theo Synapse Mac app.

No changes to the legacy ChatGPT tunnel or any other service.
Requires a signed/notarized v0.1.2 candidate, no active native tasks, and an
exact 20-hex review digest. Never reads or changes legacy/Tunnel/Keychain data.
"""
from pathlib import Path
import datetime,hashlib,json,os,plistlib,shutil,subprocess,sys,time,uuid

ROOT=Path(__file__).resolve().parents[1]
HOME=Path.home()
BASE=HOME/"Library/Application Support/Theo Synapse"
CORE=BASE/"core"
INSTALLED=HOME/"Applications"/"Theo Synapse.app"
LABEL="tech.oppstudio.theosynapse.desktop.readonly"
BUILD_ROOT=ROOT/".local/native-macos-20261029/native-build"
AUDIT=BASE/"upgrade-audit"
os.umask(0o077)

def sha(data):return hashlib.sha256(data).hexdigest()
def filehash(path):return sha(path.read_bytes())
def check(cond,reason):
 if not cond:raise RuntimeError(reason)
def subprocess_safe(args,timeout=25,allow_failure=False):
 p=subprocess.run([str(a) for a in args],capture_output=True,text=True,
                  stdin=subprocess.DEVNULL,timeout=timeout)
 if p.returncode and not allow_failure:
  raise RuntimeError("COMMAND_FAILED_"+Path(str(args[0])).name.upper().replace("-","_"))
 return p

def bundle_meta(app):
 with (app/"Contents/Info.plist").open("rb") as f:d=plistlib.load(f)
 return d.get("CFBundleIdentifier"),d.get("CFBundleShortVersionString")

def owned_dir(path):
 s=path.lstat()
 return path.is_dir() and not path.is_symlink() and s.st_uid==os.getuid() and not s.st_mode&0o077

def candidate_path(raw):
 path=Path(raw)
 check(path.is_absolute(),"CANDIDATE_PATH_NOT_ABSOLUTE")
 check(BUILD_ROOT.is_dir() and owned_dir(BUILD_ROOT),"NATIVE_BUILD_DIRECTORY_UNSAFE")
 check(path.name=="Theo Synapse.app" and path.parent.parent==BUILD_ROOT and owned_dir(path.parent),"CANDIDATE_PATH_UNAUTHORIZED")
 check(path.is_dir() and not path.is_symlink() and path.resolve()==path,"CANDIDATE_PATH_UNSAFE")
 return path

def sha_arg(value):
 check(isinstance(value,str) and len(value)==64 and all(c in "0123456789abcdef" for c in value),"CANDIDATE_SHA256_INVALID")
 return value

def registry_snapshot(registry):
 check(registry.is_file() and not registry.is_symlink() and registry.stat().st_size<=8192,"EXISTING_REGISTRY_UNSAFE")
 try:data=json.loads(registry.read_text())
 except:raise RuntimeError("EXISTING_REGISTRY_INVALID")
 check(isinstance(data,dict) and data.get("schema")==1 and isinstance(data.get("projects"),dict),"EXISTING_REGISTRY_INVALID")
 check("chappy-signal" not in data["projects"],"FORBIDDEN_NATIVE_PROJECT_REGISTERED")
 return filehash(registry),sorted(data["projects"])

def native(action,app=INSTALLED,timeout=25):
 p=subprocess_safe([app/"Contents/MacOS/TheoSynapse","--manage",action],timeout)
 try:data=json.loads(p.stdout)
 except:raise RuntimeError("NATIVE_MANAGER_BAD_JSON")
 check(isinstance(data,dict) and "error" not in data,
       "NATIVE_MANAGER_OPERATION_FAILED")
 return data

def verify_signed(app):
 check(app.is_dir() and not app.is_symlink(),"APP_DIR_UNSAFE")
 check(bundle_meta(app)[0]=="tech.oppstudio.theosynapse.desktop",
       "BUNDLE_ID_MISMATCH")
 subprocess_safe(["/usr/bin/codesign","--verify","--deep","--strict",app],timeout=40)
 subprocess_safe(["/usr/bin/xcrun","stapler","validate",app],timeout=40)
 subprocess_safe(["/usr/sbin/spctl","--assess","--type","execute",app],timeout=40)

def verify_manifest(source,folder):
 m=json.loads((source/"Contents/Resources/core-manifest.json").read_text())
 check(m.get("schema")==1 and len(m.get("files",[]))>3000,
       "CORE_MANIFEST_INVALID")
 for it in m["files"]:
  p=folder/it["path"]
  check(p.is_file() and not p.is_symlink() and
        filehash(p)==it["sha256"] and p.stat().st_size==it["bytes"],
        "CORE_MANIFEST_HASH_MISMATCH")
 return len(m["files"])

def candidate_plan(raw_candidate,expected_candidate_sha):
 check(INSTALLED.is_dir() and CORE.is_dir(),"CURRENT_MAC_APP_NOT_INSTALLED")
 candidate=candidate_path(raw_candidate);expected_candidate_sha=sha_arg(expected_candidate_sha)
 check(filehash(candidate/"Contents/MacOS/TheoSynapse")==expected_candidate_sha,"CANDIDATE_SHA256_MISMATCH")
 verify_signed(INSTALLED);verify_signed(candidate)
 check(bundle_meta(INSTALLED)[1]=="0.1.1","CURRENT_APP_VERSION_UNEXPECTED")
 check(bundle_meta(candidate)[1]=="0.1.2","CANDIDATE_VERSION_UNEXPECTED")
 current=native("status")
 check(current.get("installed") and current.get("running") and
       current.get("launchAgentLoaded") and current.get("readOnly") and
       current.get("writeEnabled") is False and current.get("activeTasks")==0,
       "NATIVE_SERVICE_NOT_IDLE")
 verify=native("verify")
 check(verify.get("verdict")=="PASS","OLD_CORE_VERIFY_FAILED")
 check((CORE/".local").is_dir() and owned_dir(CORE/".local"),"EXISTING_PRIVATE_RUNTIME_MISSING")
 registry=CORE/".local/theo-runtime/projects.json"
 registry_hash,native_projects=registry_snapshot(registry)
 files_new=verify_manifest(candidate,candidate/"Contents/Resources/Core")
 oldbytes=filehash(CORE/"package.json")
 facts={
  "kind":"THEO_NATIVE_UPGRADE_0_1_2",
  "oldApp":str(INSTALLED),"newApp":str(candidate),
  "oldVersion":"0.1.1","newVersion":"0.1.2",
  "newExecutableSHA256":filehash(candidate/"Contents/MacOS/TheoSynapse"),
  "newManifestSHA256":filehash(candidate/"Contents/Resources/core-manifest.json"),
  "currentExecutableSHA256":filehash(INSTALLED/"Contents/MacOS/TheoSynapse"),
  "currentPackageSHA256":oldbytes,
  "currentRegistrySHA256":registry_hash,
  "nativePid":current.get("pid"),
  "nativeProjects":native_projects,
  "newCoreFiles":files_new
 }
 review=sha(json.dumps(facts,ensure_ascii=False,sort_keys=True).encode())[:20]
 return facts,review

def install(raw_candidate,candidate_sha,expected):
 facts,review=candidate_plan(raw_candidate,candidate_sha)
 check(expected==review,"OWNER_REVIEW_FINGERPRINT_MISMATCH")
 candidate=candidate_path(raw_candidate)
 uid=uuid.uuid4().hex[:12]
 stage_app=INSTALLED.parent/(".TheoSynapse-staged-"+uid+".app")
 backup_app=INSTALLED.parent/(".TheoSynapse-backup-0.1.1-"+uid+".app")
 failed_app=INSTALLED.parent/(".TheoSynapse-failed-0.1.2-"+uid+".app")
 stage_core=BASE/("core-staged-"+uid)
 backup_core=BASE/("core-backup-0.1.1-"+uid)
 failed_core=BASE/("core-failed-0.1.2-"+uid)
 for p in (stage_app,backup_app,failed_app,stage_core,backup_core,failed_core):
  check(not p.exists(),"UPGRADE_PATH_COLLISION")
 report={"startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
         "previousVersion":"0.1.1","candidateVersion":"0.1.2",
         "reviewCode":review,"status":"STARTED",
         "backupApp":str(backup_app),"backupCore":str(backup_core),
         "steps":[],"legacyTunnelModified":False,"modelTurnStarted":False}
 stopped=False;app_swapped=False;core_swapped=False;runtime_moved=False
 def mark(step):
  report["steps"].append(step)
  print("UPGRADE_STEP",step,flush=True)
 def save(status,error=None):
  report["status"]=status;report["error"]=error
  AUDIT.mkdir(parents=True,mode=0o700,exist_ok=True)
  check(owned_dir(AUDIT),"UPGRADE_AUDIT_DIRECTORY_UNSAFE")
  p=AUDIT/("native-upgrade-v012-"+uid+".json")
  with p.open("x",encoding="utf-8") as f:
   json.dump(report,f,ensure_ascii=False,indent=2)
  print("UPGRADE_AUDIT",p.name,"STATUS",status,flush=True)
 try:
  # Signed/notarized candidate is staged before service changes.
  subprocess_safe(["/usr/bin/ditto",candidate,stage_app],timeout=90)
  verify_signed(stage_app)
  mark("STAGED_NOTARIZED_APP")
  shutil.copytree(candidate/"Contents/Resources/Core",stage_core,symlinks=False)
  for p in stage_core.rglob("*"):
   if p.is_symlink():raise RuntimeError("UNEXPECTED_STAGING_SYMLINK")
   p.chmod(0o700 if p.is_dir() else 0o600)
  stage_core.chmod(0o700)
  verify_manifest(candidate,stage_core)
  mark("STAGED_PRIVATE_CORE")
  # The GUI process must quit normally, never kill it or the old Tunnel.
  gui=subprocess_safe(["/usr/bin/osascript","-e",
                       'tell application id "tech.oppstudio.theosynapse.desktop" to quit'],
                      timeout=12,allow_failure=True)
  check(gui.returncode==0,"GUI_QUIT_NOT_GRANTED")
  time.sleep(1)
  ps=subprocess_safe(["/bin/ps","-axo","pid,command"])
  active=[line for line in ps.stdout.splitlines() if
          "/Applications/Theo Synapse.app/Contents/MacOS/TheoSynapse" in line and
          "ps -axo" not in line and "/bin/zsh" not in line]
  check(not active,"GUI_STILL_RUNNING")
  mark("GUI_QUIT_GRACEFULLY")
  native("stop")
  stopped=True
  check(not native("status").get("running"),"SERVICE_STOP_UNVERIFIED")
  mark("NATIVE_LAUNCHAGENT_STOPPED")
  CORE.rename(backup_core)
  core_swapped=True
  # Preserve the installed native state by rename only; source .local, legacy,
  # Tunnel configuration and credentials are never read or copied.
  (backup_core/".local").rename(stage_core/".local")
  runtime_moved=True
  check(filehash(stage_core/".local/theo-runtime/projects.json")==facts["currentRegistrySHA256"],"NATIVE_REGISTRY_CHANGED")
  mark("PRIVATE_NATIVE_STATE_PRESERVED_BY_RENAME")
  stage_core.rename(CORE)
  mark("CORE_SWAPPED_WITH_BACKUP")
  INSTALLED.rename(backup_app)
  app_swapped=True
  stage_app.rename(INSTALLED)
  verify_signed(INSTALLED)
  mark("NOTARIZED_APP_SWAPPED_WITH_BACKUP")
  native("verify")
  started=native("start",timeout=35)
  check(started.get("running") is True and started.get("activeTasks")==0,
        "NEW_SERVICE_START_UNVERIFIED")
  smoke=native("smoke",timeout=35)
  check(smoke.get("verdict")=="PASS" and smoke.get("toolCount")==8 and
        smoke.get("writeEnabled") is False,"NEW_MCP_SMOKE_FAILED")
  after=native("status")
  check(after.get("running") and after.get("writeEnabled") is False and after.get("activeTasks")==0 and
        after.get("chatGPTConnection")=="UNVERIFIED",
        "NEW_GUI_STATUS_UNVERIFIED")
  check(filehash(CORE/".local/theo-runtime/projects.json")==
        facts["currentRegistrySHA256"],"NEW_REGISTRY_CHANGED")
  mark("NEW_NATIVE_CORE_RUNNING_AND_VERIFIED")
  report["finalPid"]=after.get("pid")
  report["nativeProjectIds"]=after.get("registeredProjects")
  report["newAppVersion"]=bundle_meta(INSTALLED)[1]
  save("PASS_INSTALLED_V012")
 except Exception as e:
  code=str(e)[:90] if re.match(r'^[A-Z0-9_]{3,90}$',str(e)) else type(e).__name__
  print("UPGRADE_ERROR",code,flush=True)
  rollback_good=True
  try:
   if app_swapped:
    try:native("stop")
    except Exception:pass
    if INSTALLED.exists():INSTALLED.rename(failed_app)
    if backup_app.exists():backup_app.rename(INSTALLED)
   if core_swapped:
    if CORE.exists():CORE.rename(failed_core)
    if runtime_moved:
     # A failed stage-to-core rename leaves state in stage_core; after a later
     # failure it is in failed_core. Restore it before reinstating old Core.
     for holder in (failed_core,stage_core):
      if (holder/".local").exists():
       check(not (backup_core/".local").exists(),"ROLLBACK_RUNTIME_COLLISION")
       (holder/".local").rename(backup_core/".local")
       break
     else:raise RuntimeError("ROLLBACK_RUNTIME_MISSING")
    if backup_core.exists():backup_core.rename(CORE)
   if stopped and INSTALLED.exists():
    old=native("start",timeout=35)
    rollback_good=old.get("running") is True and old.get("writeEnabled") is False
  except Exception:
   rollback_good=False
  save("FAIL_ROLLED_BACK" if rollback_good else "UNKNOWN_MANUAL_RECOVERY_REQUIRED",code)
  raise
 # Old signed app+core remain in backup locations for Owner-requested rollback.
 return report

if __name__=="__main__":
 import re
 if len(sys.argv)==4 and sys.argv[1]=="plan":
  facts,review=candidate_plan(sys.argv[2],sys.argv[3])
  print(json.dumps({"status":"READY_TO_UPGRADE","reviewCode":review,
    "oldVersion":facts["oldVersion"],"newVersion":facts["newVersion"],
    "nativeProjects":facts["nativeProjects"],
    "noLegacyTunnelMigration":True,
    "newCoreFiles":facts["newCoreFiles"]},ensure_ascii=False))
 elif len(sys.argv)==5 and sys.argv[1]=="execute":
  install(sys.argv[2],sys.argv[3],sys.argv[4])
 else:
  print("Usage: python3 scripts/upgrade-native-installed-v012.py plan CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 | execute CANDIDATE_APP_ABSOLUTE_PATH CANDIDATE_EXECUTABLE_SHA256 20_HEX_REVIEW_CODE")
  sys.exit(2)
