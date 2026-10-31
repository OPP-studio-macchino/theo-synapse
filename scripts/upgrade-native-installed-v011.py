#!/usr/bin/env python3
"""Owner-requested upgrade of the separate signed Theo Synapse Mac app.

No changes to the legacy ChatGPT tunnel or any other service.
Requires a notarized v0.1.1 app, no active native tasks, and an exact review hash.
Keeps old signed app & Core backups for rollback. Never copies legacy credentials.
"""
from pathlib import Path
import datetime,hashlib,json,os,plistlib,shutil,subprocess,sys,time,uuid

ROOT=Path(__file__).resolve().parents[1]
HOME=Path.home()
BASE=HOME/"Library/Application Support/Theo Synapse"
CORE=BASE/"core"
INSTALLED=HOME/"Applications"/"Theo Synapse.app"
LABEL="tech.oppstudio.theosynapse.desktop.readonly"
ALLOWED=ROOT/".local/native-macos-20261028/unsigned-candidates/v0.1.1-20261028T122636Z/Theo Synapse.app"
AUDIT=ROOT/".local/evidence/macos-native-20261028"
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

def candidate_plan():
 check(INSTALLED.is_dir() and CORE.is_dir(),"CURRENT_MAC_APP_NOT_INSTALLED")
 check(ALLOWED.is_dir() and ALLOWED.parent.parent==ROOT/".local/native-macos-20261028/unsigned-candidates",
       "CANDIDATE_PATH_UNAUTHORIZED")
 verify_signed(INSTALLED);verify_signed(ALLOWED)
 check(bundle_meta(INSTALLED)[1]=="0.1.0","OLD_APP_VERSION_CHANGED")
 check(bundle_meta(ALLOWED)[1]=="0.1.1","CANDIDATE_VERSION_UNEXPECTED")
 current=native("status")
 check(current.get("installed") and current.get("running") and
       current.get("launchAgentLoaded") and current.get("readOnly") and
       current.get("writeEnabled") is False and current.get("activeTasks")==0,
       "NATIVE_SERVICE_NOT_IDLE")
 verify=native("verify")
 check(verify.get("verdict")=="PASS","OLD_CORE_VERIFY_FAILED")
 check(CORE/".local" in list(CORE.iterdir()) or (CORE/".local").is_dir(),
       "EXISTING_PRIVATE_RUNTIME_MISSING")
 registry=CORE/".local/theo-runtime/projects.json"
 check(registry.is_file(),"EXISTING_REGISTRY_MISSING")
 files_new=verify_manifest(ALLOWED,ALLOWED/"Contents/Resources/Core")
 oldbytes=filehash(CORE/"package.json")
 facts={
  "kind":"THEO_NATIVE_UPGRADE_0_1_1",
  "oldApp":str(INSTALLED),"newApp":str(ALLOWED),
  "oldVersion":"0.1.0","newVersion":"0.1.1",
  "newExecutableSHA256":filehash(ALLOWED/"Contents/MacOS/TheoSynapse"),
  "newManifestSHA256":filehash(ALLOWED/"Contents/Resources/core-manifest.json"),
  "currentExecutableSHA256":filehash(INSTALLED/"Contents/MacOS/TheoSynapse"),
  "currentPackageSHA256":oldbytes,
  "currentRegistrySHA256":filehash(registry),
  "nativePid":current.get("pid"),
  "nativeProjects":current.get("registeredProjects"),
  "newCoreFiles":files_new
 }
 review=sha(json.dumps(facts,ensure_ascii=False,sort_keys=True).encode())[:20]
 return facts,review

def install(expected):
 facts,review=candidate_plan()
 check(expected==review,"OWNER_REVIEW_FINGERPRINT_MISMATCH")
 uid=uuid.uuid4().hex[:12]
 stage_app=INSTALLED.parent/(".TheoSynapse-staged-"+uid+".app")
 backup_app=INSTALLED.parent/(".TheoSynapse-backup-0.1.0-"+uid+".app")
 failed_app=INSTALLED.parent/(".TheoSynapse-failed-0.1.1-"+uid+".app")
 stage_core=BASE/("core-staged-"+uid)
 backup_core=BASE/("core-backup-0.1.0-"+uid)
 failed_core=BASE/("core-failed-0.1.1-"+uid)
 for p in (stage_app,backup_app,failed_app,stage_core,backup_core,failed_core):
  check(not p.exists(),"UPGRADE_PATH_COLLISION")
 report={"startedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
         "previousVersion":"0.1.0","candidateVersion":"0.1.1",
         "reviewCode":review,"status":"STARTED",
         "backupApp":str(backup_app),"backupCore":str(backup_core),
         "steps":[],"legacyTunnelModified":False,"modelTurnStarted":False}
 stopped=False;app_swapped=False;core_swapped=False
 def mark(step):
  report["steps"].append(step)
  print("UPGRADE_STEP",step,flush=True)
 def save(status,error=None):
  report["status"]=status;report["error"]=error
  p=AUDIT/("native-upgrade-v011-"+uid+".json")
  with p.open("x",encoding="utf-8") as f:
   json.dump(report,f,ensure_ascii=False,indent=2)
  print("UPGRADE_AUDIT",p.name,"STATUS",status,flush=True)
 try:
  # Signed/notarized candidate is staged before service changes.
  subprocess_safe(["/usr/bin/ditto",ALLOWED,stage_app],timeout=90)
  verify_signed(stage_app)
  mark("STAGED_NOTARIZED_APP")
  shutil.copytree(ALLOWED/"Contents/Resources/Core",stage_core,symlinks=False)
  for p in stage_core.rglob("*"):
   if p.is_symlink():raise RuntimeError("UNEXPECTED_STAGING_SYMLINK")
   p.chmod(0o700 if p.is_dir() else 0o600)
  stage_core.chmod(0o700)
  verify_manifest(ALLOWED,stage_core)
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
  # Copy private native-only journal and project snapshots AFTER daemon exits.
  # Historical old Standalone's private keys, Tunnel and DB are not touched.
  shutil.copytree(CORE/".local",stage_core/".local",symlinks=False)
  for p in (stage_core/".local").rglob("*"):
   if p.is_symlink():raise RuntimeError("NATIVE_RUNTIME_SYMLINK")
  check(filehash(stage_core/".local/theo-runtime/projects.json")==
        facts["currentRegistrySHA256"],"NATIVE_REGISTRY_CHANGED")
  mark("PRIVATE_NATIVE_STATE_PRESERVED")
  CORE.rename(backup_core)
  core_swapped=True
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
  check(after.get("running") and after.get("writeEnabled") is False and
        after.get("chatGPTConnection")=="UNVERIFIED",
        "NEW_GUI_STATUS_UNVERIFIED")
  check(filehash(CORE/".local/theo-runtime/projects.json")==
        facts["currentRegistrySHA256"],"NEW_REGISTRY_CHANGED")
  mark("NEW_NATIVE_CORE_RUNNING_AND_VERIFIED")
  report["finalPid"]=after.get("pid")
  report["nativeProjectIds"]=after.get("registeredProjects")
  report["newAppVersion"]=bundle_meta(INSTALLED)[1]
  save("PASS_INSTALLED_V011")
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
 if len(sys.argv)==2 and sys.argv[1]=="plan":
  facts,review=candidate_plan()
  print(json.dumps({"status":"READY_TO_UPGRADE","reviewCode":review,
    "oldVersion":facts["oldVersion"],"newVersion":facts["newVersion"],
    "nativeProjects":facts["nativeProjects"],
    "noLegacyTunnelMigration":True,
    "newCoreFiles":facts["newCoreFiles"]},ensure_ascii=False))
 elif len(sys.argv)==3 and sys.argv[1]=="execute":
  install(sys.argv[2])
 else:
  print("Usage: python3 scripts/upgrade-native-installed-v011.py plan|execute 20_HEX_REVIEW_CODE")
  sys.exit(2)
