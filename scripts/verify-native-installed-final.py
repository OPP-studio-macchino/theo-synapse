#!/usr/bin/env python3
"""Read-only signed/native installed Theo Synapse acceptance. No launchctl actions."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
APP = Path.home() / "Applications" / "Theo Synapse.app"
NATIVE = ROOT / ".local" / "native-macos-20261028"
DMG = NATIVE / "Theo-Synapse-0.1.0-arm64-build2.dmg"
EV = ROOT / ".local" / "evidence" / "macos-native-20261028"
LABEL = "tech.oppstudio.theosynapse.desktop.readonly"
checks = []

def record(name, passed, detail=None):
    checks.append({"name": name, "status": "PASS" if passed else "FAIL",
                   "detail": detail or ("VERIFIED" if passed else "NOT_VERIFIED")})
    print(("PASS " if passed else "FAIL ") + name, flush=True)

def command(args, timeout=20):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None

def good(args, timeout=20):
    r = command(args, timeout)
    return bool(r and r.returncode == 0)

def json_file(path):
    return json.loads(path.read_text(encoding="utf-8"))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

record("installed_native_app_path", APP.is_dir() and (APP/"Contents/MacOS/TheoSynapse").is_file())
record("app_codesign_valid", good(["/usr/bin/codesign","--verify","--deep","--strict",str(APP)]))
record("app_notarization_ticket", good(["/usr/bin/xcrun","stapler","validate",str(APP)]))
record("app_gatekeeper_notarized", good(["/usr/sbin/spctl","--assess","--type","execute",str(APP)]))
bundle = command(["/usr/libexec/PlistBuddy","-c","Print :CFBundleIdentifier",
                  str(APP/"Contents/Info.plist")])
version = command(["/usr/libexec/PlistBuddy","-c","Print :CFBundleShortVersionString",
                   str(APP/"Contents/Info.plist")])
record("installed_app_bundle_identity", bool(bundle and version and
    bundle.returncode == 0 and version.returncode == 0 and
    bundle.stdout.strip() == "tech.oppstudio.theosynapse.desktop" and
    version.stdout.strip() in ("0.1.0","0.1.1")))
signature = command(["/usr/bin/codesign","-dv","--verbose=4",str(APP)])
signature_text = (signature.stderr if signature else "")
record("developer_id_hardened_runtime_with_timestamp",
       "flags=0x10000(runtime)" in signature_text and
       "Timestamp=" in signature_text and "Authority=Developer ID Application:" in signature_text)

record("signed_dmg_present", DMG.is_file())
record("signed_dmg_codesign_valid", good(["/usr/bin/codesign","--verify",str(DMG)]))
record("signed_dmg_notary_ticket", good(["/usr/bin/xcrun","stapler","validate",str(DMG)]))
record("dmg_disk_image_checksum", good(["/usr/bin/hdiutil","verify",str(DMG)],timeout=40))
sidecar=DMG.with_name(DMG.name+".sha256")
if sidecar.is_file() and DMG.is_file():
    own=sha(DMG)
    record("dmg_sha256_sidecar", own in sidecar.read_text(encoding="utf-8") and
           DMG.name in sidecar.read_text(encoding="utf-8"))
else:
    record("dmg_sha256_sidecar",False)

for name in ("notary-app-build2-result.json","notary-dmg-build2-result.json"):
    path=EV/name
    try:
        data=json_file(path)
        record(name+"_accepted",data.get("status")=="Accepted")
    except (OSError,ValueError):
        record(name+"_accepted",False)

plist = Path.home()/"Library/LaunchAgents"/(LABEL+".plist")
record("launchagent_plist_exists",plist.is_file())
plist_label=command(["/usr/libexec/PlistBuddy","-c","Print :Label",str(plist)])
record("launchagent_label_isolated",
       bool(plist_label and plist_label.returncode==0 and plist_label.stdout.strip()==LABEL))
record("launchagent_plutil_valid",good(["/usr/bin/plutil","-lint",str(plist)]))
launch=command(["/bin/launchctl","print",f"gui/{os.getuid()}/{LABEL}"])
loaded=bool(launch and launch.returncode==0 and "state = running" in launch.stdout)
record("launchagent_loaded_and_running",loaded)
app_exe=APP/"Contents/MacOS/TheoSynapse"
status=command([str(app_exe),"--manage","status"],timeout=15)
try:
    current=json.loads(status.stdout) if status and status.returncode==0 else {}
except ValueError:
    current={}
record("native_service_status_readonly",bool(current.get("installed") and
    current.get("running") and current.get("launchAgentLoaded") and
    current.get("readOnly") and current.get("writeEnabled") is False and
    current.get("activeTasks")==0 and current.get("pid",0)>0))
record("native_codex_available",current.get("codexInstalled") is True and
       current.get("codexLogin")=="LOGGED_IN")
record("native_demo_allowlisted",current.get("registeredProjects")==["theo-lab"])
record("native_connection_not_silently_migrated",
       current.get("chatGPTConnection")=="UNVERIFIED")

verify=command([str(app_exe),"--manage","verify"],timeout=20)
try:
    verified=json.loads(verify.stdout) if verify and verify.returncode==0 else {}
except ValueError:
    verified={}
record("installed_core_sha256_integrity",verified.get("verdict")=="PASS" and
       verified.get("writeEnabled") is False)
smoke=command([str(app_exe),"--manage","smoke"],timeout=25)
try:
    mcp=json.loads(smoke.stdout) if smoke and smoke.returncode==0 else {}
except ValueError:
    mcp={}
record("installed_core_mcp_tools_without_model",mcp.get("verdict")=="PASS" and
       mcp.get("toolCount")==8 and mcp.get("modelTurnStarted") is False)

earlier=sorted(EV.glob("installed-lifecycle-20*.json"))
lifecycle=None
if earlier:
    try:lifecycle=json_file(earlier[-1])
    except (OSError,ValueError):pass
steps=(lifecycle or {}).get("steps",[])
expected=["status","setup","verify","start","smoke","start",
          "restart","stop","start","smoke"]
record("native_lifecycle_ten_actions_passed",
       (lifecycle or {}).get("verdict")=="PASS_INSTALLED_MAC_LIFECYCLE"
       and [s.get("action") for s in steps]==expected
       and all(s.get("exitCode")==0 for s in steps))
pid_before=steps[3].get("result",{}).get("pid") if len(steps)==10 else None
pid_restarted=steps[6].get("result",{}).get("pid") if len(steps)==10 else None
pid_end=steps[8].get("result",{}).get("pid") if len(steps)==10 else None
record("native_service_stop_and_pid_change",
       bool(pid_before and pid_restarted and pid_end and
            len({pid_before,pid_restarted,pid_end})==3
            and steps[7]["result"].get("running") is False))
record("native_final_pid_still_active",bool(current.get("pid") and
       current["pid"]==pid_end))

# Previously registered read-only plugin and source must remain independent.
standalone=ROOT/".local"/"theo-runtime"
record("standalone_existing_write_gate_off",
       not (standalone/"write-release.json").exists() and
       not (standalone/"writes.sqlite").exists() and
       not (standalone/"promotions.sqlite").exists())
src=Path("/Volumes/OPP_ARCHIVE/O.P.P Studio/Chappy Sound")
snapshot=standalone/"projects"/"chappy-signal"
matches=0
try:
    files=[p for p in snapshot.rglob("*") if p.is_file() and not p.is_symlink()]
    matches=sum((src/p.relative_to(snapshot)).is_file() and
        sha(p)==sha(src/p.relative_to(snapshot)) for p in files)
    source_ok=len(files)==matches==69
except OSError:
    source_ok=False
record("chappy_signal_69_files_intact",source_ok)

results={
    "checkedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "product":"Theo Synapse for Mac",
    "appVersion":version.stdout.strip() if version and version.returncode==0 else None,
    "coreVersion":"0.0.5",
    "verdict":"PASS_NATIVE_INSTALLED" if all(c["status"]=="PASS" for c in checks) else "FAIL",
    "checks":checks,"passed":sum(c["status"]=="PASS" for c in checks),
    "failed":sum(c["status"]=="FAIL" for c in checks),
    "lifecycleEvidence":earlier[-1].name if earlier else None,
    "servicePid":current.get("pid"),
    "modelTurnStarted":False,
    "liveTunnelModified":False,
    "projectSourceModified":False,
    "macOSRebootTested":False,
    "chatGPTConnectionMigrated":False,
    "signedAndNotarized":True if all(c["status"]=="PASS" for c in checks[:4]) else False,
}
os.umask(0o077)
dest=EV/("installed-final-acceptance-"+results["checkedAt"].replace(":","-").replace(".","-")+".json")
with dest.open("x",encoding="utf-8") as f:json.dump(results,f,ensure_ascii=False,indent=2)
print("RESULT",results["verdict"],f"{results['passed']}/{len(checks)}",
      "failed",results["failed"],"evidence",dest.name,flush=True)
if results["failed"]:raise SystemExit(1)
