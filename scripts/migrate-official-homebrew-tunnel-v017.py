#!/usr/bin/env python3
"""Owner-approved migration of Theo's exact existing tunnel LaunchAgent to OpenAI Homebrew.

Source-only owner operations script. Never edits credentials, health files, Core or Gatekeeper.
"""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import time
import uuid

HOME=Path.home()
LABEL="tech.oppstudio.theosynapse.tunnel.readonly"
PLIST=HOME/"Library/LaunchAgents"/(LABEL+".plist")
OLD=HOME/".local/bin/tunnel-client"
NEW=Path("/opt/homebrew/opt/tunnel-client/libexec/tunnel-client")
BASE=HOME/"Library/Application Support/Theo Synapse"
AUDIT=BASE/"upgrade-audit"
NATIVE=HOME/"Applications/Theo Synapse.app/Contents/MacOS/TheoSynapse"
DOMAIN=f"gui/{os.getuid()}"
os.umask(0o077)

def require(value,code):
 if not value:raise RuntimeError(code)

def sha(data):return hashlib.sha256(data).hexdigest()

def command(args,timeout=20):
 return subprocess.run([str(x) for x in args],text=True,capture_output=True,
                       stdin=subprocess.DEVNULL,timeout=timeout)

def owned_dir(p):
 s=p.lstat();return p.is_dir() and not p.is_symlink() and s.st_uid==os.getuid() and (s.st_mode&0o077)==0

def file_safe(p,mode=None):
 s=p.lstat()
 require(stat.S_ISREG(s.st_mode) and not p.is_symlink() and s.st_uid==os.getuid() and s.st_nlink==1,"TUNNEL_FILE_UNSAFE")
 if mode is not None:require((s.st_mode&0o777)==mode,"TUNNEL_FILE_MODE_UNSAFE")

def native_idle():
 p=command([NATIVE,"--manage","status"],timeout=27)
 require(p.returncode==0,"TUNNEL_NATIVE_STATUS_UNAVAILABLE")
 try:j=json.loads(p.stdout)
 except ValueError:raise RuntimeError("TUNNEL_NATIVE_STATUS_INVALID")
 require(j.get("appVersion")=="0.1.7" and j.get("hostState")=="READONLY(8)" and
  j.get("launchAgentLoaded") is True and j.get("activeTasks")==0 and
  j.get("directActiveRuns")==0 and j.get("writeEnabled") is False,
  "TUNNEL_NATIVE_NOT_IDLE")

def verify_new():
 require(NEW.is_file() and not NEW.is_symlink() and str(NEW).startswith("/opt/homebrew/opt/"),"TUNNEL_HOMEBREW_NOT_INSTALLED")
 assert NEW.name=="tunnel-client"
 v=command([NEW,"--version"])
 require(v.returncode==0 and v.stdout.startswith("0.0.19+"),"TUNNEL_HOMEBREW_VERSION_MISMATCH")
 sig=command(["/usr/bin/codesign","--verify","--strict",NEW])
 require(sig.returncode==0,"TUNNEL_HOMEBREW_CODE_INVALID")
 q=command(["/usr/bin/xattr",NEW])
 require(q.returncode==0 and "com.apple.quarantine" not in q.stdout.splitlines(),"TUNNEL_HOMEBREW_QUARANTINED")
 return sha(NEW.read_bytes())

def agent_loaded():
 r=command(["/bin/launchctl","print",f"{DOMAIN}/{LABEL}"],timeout=15)
 require(r.returncode==0,"TUNNEL_AGENT_NOT_REGISTERED")
 require("state = running" not in r.stdout,"TUNNEL_AGENT_CURRENTLY_RUNNING")
 return r

def snapshot():
 require(sys.platform=="darwin","TUNNEL_MACOS_ONLY")
 native_idle()
 require(owned_dir(BASE) and owned_dir(AUDIT),"TUNNEL_AUDIT_DIR_UNSAFE")
 file_safe(PLIST,0o600)
 file_safe(OLD)
 original=PLIST.read_bytes()
 cfg=plistlib.loads(original)
 expected_keys={"Label","ProgramArguments","EnvironmentVariables","WorkingDirectory",
                "RunAtLoad","KeepAlive","ThrottleInterval","Umask","StandardOutPath","StandardErrorPath"}
 require(set(cfg)==expected_keys and cfg["Label"]==LABEL,"TUNNEL_AGENT_UNRECOGNIZED")
 args=cfg["ProgramArguments"]
 require(isinstance(args,list) and len(args)==4 and args==[str(OLD),"run","--profile-file",args[3]],"TUNNEL_AGENT_ARGUMENTS_CHANGED")
 profile=Path(args[3])
 file_safe(profile,0o600)
 require(profile.is_relative_to(HOME/"Documents"),"TUNNEL_PROFILE_ROOT_UNEXPECTED")
 require(cfg["RunAtLoad"] is True and isinstance(cfg["KeepAlive"],dict),"TUNNEL_AGENT_POLICY_CHANGED")
 agent_loaded()
 new_sha=verify_new()
 facts={"oldPlistSHA256":sha(original),"newExecutableSHA256":new_sha,
        "oldExecutableSHA256":sha(OLD.read_bytes()),"label":LABEL,
        "old":"v0.0.11","new":"v0.0.19","ownerUid":os.getuid()}
 review=sha(json.dumps(facts,sort_keys=True).encode())[:20]
 return cfg,original,facts,review

def native_approval(facts,review):
 msg="\n".join([
 "OpenAI公式Homebrew版Tunnelへの変更を承認しますか？","",
 "対象：Theo Synapse専用の既存Tunnel LaunchAgentのみ",
 "旧: ~/.local/bin/tunnel-client (v0.0.11)",
 "新: /opt/homebrew/opt/tunnel-client/libexec/tunnel-client (v0.0.19)",
 "今回の確認指紋："+review,"",
 "実行ファイル指定１か所だけ変更し、旧設定を保全します。",
 "接続用プロフィール・APIキー・Tunnel IDは変更しません。",
 "macOSのGatekeeperや検疫設定を変更しません。",
 "既存Tunnelを正規LaunchAgentから起動し直します。",
 "許可は今回の１回限りです。"])
 msg=msg.replace("\\","\\\\").replace('"','\\"')
 src=('try\nset d to display dialog "'+msg+'" with title "Theo Synapse — Tunnel実行ファイル更新" '
      'buttons {"許可しない","今回だけ更新を許可"} default button "許可しない" '
      'cancel button "許可しない" giving up after 110\n'
      'if gave up of d then return "DENIED"\n'
      'if button returned of d is "今回だけ更新を許可" then return "APPROVED"\n'
      'return "DENIED"\non error\nreturn "DENIED"\nend try')
 p=command(["/usr/bin/osascript","-e",src],timeout=120)
 return p.returncode==0 and p.stdout.strip()=="APPROVED"

def private_write(path,data):
 fd=os.open(str(path),os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
 with os.fdopen(fd,"wb") as handle:
  handle.write(data);handle.flush();os.fsync(handle.fileno())
 path.chmod(0o600)

def exchange(original,cfg,code):
 audit= AUDIT/("tunnel-brew-migration-old-plist-"+code+".plist")
 temp=PLIST.parent/(".theo-tunnel-migration-"+code+".plist")
 require(not audit.exists() and not temp.exists(),"TUNNEL_MIGRATION_COLLISION")
 # Validate expected sole change, lint staged file, and preserve original bytes.
 candidate=dict(cfg)
 candidate["ProgramArguments"]=list(cfg["ProgramArguments"])
 candidate["ProgramArguments"][0]=str(NEW)
 assert {**candidate,"ProgramArguments":cfg["ProgramArguments"]}==cfg
 data=plistlib.dumps(candidate,sort_keys=False)
 private_write(temp,data)
 lint=command(["/usr/bin/plutil","-lint",temp])
 require(lint.returncode==0,"TUNNEL_NEW_AGENT_INVALID")
 private_write(audit,original)
 print("TUNNEL_OLD_PLIST_BACKUP",audit.name,flush=True)
 old_booted=True
 try:
  stop=command(["/bin/launchctl","bootout",f"{DOMAIN}/{LABEL}"],timeout=18)
  require(stop.returncode==0,"TUNNEL_OLD_BOOTOUT_DENIED")
  old_booted=False
  require(sha(PLIST.read_bytes())==sha(original),"TUNNEL_PLIST_CHANGED_IN_FLIGHT")
  os.replace(temp,PLIST)
  file_safe(PLIST,0o600)
  start=command(["/bin/launchctl","bootstrap",DOMAIN,PLIST],timeout=18)
  require(start.returncode==0,"TUNNEL_NEW_BOOTSTRAP_DENIED")
  print("TUNNEL_OFFICIAL_HOMEBREW_AGENT_BOOTSTRAP_PASS",flush=True)
  return audit
 except Exception:
  print("TUNNEL_MIGRATION_ERROR_ROLLBACK_ATTEMPTED",flush=True)
  if not old_booted:
   try:command(["/bin/launchctl","bootout",f"{DOMAIN}/{LABEL}"],timeout=12)
   except Exception:pass
   try:
    rollback=PLIST.parent/(".theo-tunnel-rollback-"+code+".plist")
    private_write(rollback,original)
    os.replace(rollback,PLIST)
    require(sha(PLIST.read_bytes())==sha(original),"TUNNEL_ROLLBACK_BYTES_MISMATCH")
    boot=command(["/bin/launchctl","bootstrap",DOMAIN,PLIST],timeout=15)
    print("TUNNEL_OLD_PLIST_ROLLBACK",boot.returncode==0,flush=True)
   except Exception:print("TUNNEL_OLD_PLIST_ROLLBACK_UNVERIFIED",flush=True)
  raise
 finally:
  if temp.exists():temp.unlink()

def main():
 require(len(sys.argv)==2 and sys.argv[1] in ("plan","execute"),"TUNNEL_MIGRATION_USAGE")
 cfg,original,facts,review=snapshot()
 print("TUNNEL_MIGRATION_PLAN",json.dumps({"verdict":"READY_FOR_OWNER_APPROVAL","reviewCode":review,
  "oldVersion":"0.0.11","newVersion":"0.0.19","agentCurrentlyRunning":False,
  "agentLabelMatch":True,"credentialsUntouched":True}),flush=True)
 if sys.argv[1]=="plan":return
 print("TUNNEL_MIGRATION_NATIVE_OWNER_DIALOG_PENDING",flush=True)
 require(native_approval(facts,review),"TUNNEL_OWNER_NOT_APPROVED")
 again,prior,current_code,current_review=snapshot()
 require(current_code==facts and current_review==review and prior==original,
         "TUNNEL_OWNER_PLAN_CHANGED")
 print("TUNNEL_MIGRATION_OWNER_APPROVED",flush=True)
 audit=exchange(original,cfg,review)
 print("TUNNEL_MIGRATION_APPLIED",json.dumps({"audit":audit.name,"newPathSelected":True}),flush=True)

if __name__=="__main__":
 try:main()
 except Exception as e:
  c=str(e)
  print("TUNNEL_MIGRATION_STOP",c if re.fullmatch(r"TUNNEL_[A-Z0-9_]{3,90}",c) else "TUNNEL_MIGRATION_UNVERIFIED",flush=True)
  sys.exit(1)
