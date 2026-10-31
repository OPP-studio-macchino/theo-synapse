#!/usr/bin/env python3
"""Produce an unsigned, signing-ready v0.1.5 Theo Synapse candidate only in source-private staging."""
import datetime,hashlib,json,os,plistlib,shutil,subprocess,sys,tarfile,uuid
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
APP_VERSION="0.1.5"; CORE_VERSION="0.0.5"; NAME="Theo Synapse.app"
PRIVATE_BUILD=ROOT/".local"/"native-macos-20261029"/"native-build"
RELEASES=ROOT/".local"/"releases"
ICON=Path.home()/"Applications"/"Theo Synapse.app"/"Contents"/"Resources"/"AppIcon.icns"
REQUIRED_DIRECT_SOURCE={"src/direct-coordinator.mjs","src/direct-native-factory.mjs","src/direct-workspace-registry.mjs","src/direct-owner-approval.mjs","scripts/theo-direct-workspaces.mjs","scripts/theo-direct-daemon-entry.mjs","scripts/theo-task-entry.mjs"}
DIAGNOSTIC_CODE=("error_code TEXT","ALTER TABLE direct_runs ADD COLUMN error_code TEXT","reasonCode:storedDiagnosisCode(r.error_code)","providerFinished:['COMPLETED','FAILED'].includes(r.state)","state='UNKNOWN',error_code='DIRECT_EXECUTION_UNVERIFIED'")

def fail(reason): raise RuntimeError(reason)
def digest(data): return hashlib.sha256(data).hexdigest()
def safe_file(path,max_bytes=250_000):
 s=path.lstat()
 if not path.is_file() or path.is_symlink() or s.st_uid!=os.getuid() or s.st_size>max_bytes or s.st_nlink!=1: fail("UNTRUSTED_SOURCE_FILE")
 return path.read_bytes()
def allow_path(parts): return tuple(parts)==(".gitignore",) or all(p not in ("",".","..",".local",".git","node_modules") and not p.startswith(".") and len(p)<160 for p in parts)
def run(args,timeout=180):
 p=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=timeout)
 if p.returncode: fail("NATIVE_BUILD_COMMAND_FAILED:"+str(args[0])+":"+str(p.returncode)+":"+p.stderr[-320:])
 return p
def verify_diagnostic(core):
 source=(core/"src/direct-coordinator.mjs").read_text(encoding="utf-8")
 if any(token not in source for token in DIAGNOSTIC_CODE): fail("DIRECT_DIAGNOSTIC_FIX_MISSING")

def build(archive,expected_sha):
 os.umask(0o077)
 if not archive.is_absolute() or archive.parent!=RELEASES or not archive.name.startswith("theo-synapse-readonly-preview-") or archive.suffixes[-2:]!=[".tar",".gz"]: fail("RELEASE_PATH_UNAUTHORIZED")
 if digest(safe_file(archive,2_000_000))!=expected_sha: fail("RELEASE_ARCHIVE_HASH_MISMATCH")
 if not ICON.is_file() or not (ROOT/"macos"/"TheoSynapse.swift").is_file(): fail("REQUIRED_ICON_OR_NATIVE_SOURCE_MISSING")
 for rel in REQUIRED_DIRECT_SOURCE:
  if not (ROOT/rel).is_file(): fail("REQUIRED_DIRECT_SOURCE_MISSING")
  safe_file(ROOT/rel)
 verify_diagnostic(ROOT)
 if not PRIVATE_BUILD.is_dir(): fail("BUILD_PARENT_MISSING")
 s=PRIVATE_BUILD.stat()
 if s.st_uid!=os.getuid() or s.st_mode&0o077: fail("BUILD_PARENT_NOT_PRIVATE")
 release=PRIVATE_BUILD/("v"+APP_VERSION+"-"+datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")+"-"+uuid.uuid4().hex)
 if release.exists(): fail("BUILD_STAGE_COLLISION")
 release.mkdir(mode=0o700); app=release/NAME; cont=app/"Contents"; res=cont/"Resources"; mac=cont/"MacOS"; core=res/"Core"
 for d in (mac,res,core): d.mkdir(parents=True,mode=0o755,exist_ok=True)
 with tarfile.open(archive,"r:gz") as pkg:
  entries=pkg.getmembers(); root_name="theo-synapse-readonly-preview-"+CORE_VERSION
  if len(entries)>200: fail("TOO_MANY_ARCHIVE_ENTRIES")
  for ent in entries:
   parts=Path(ent.name).parts
   if len(parts)<2:
    if ent.isdir() and parts==(root_name,): continue
    fail("UNEXPECTED_ARCHIVE_ROOT")
   if parts[0]!=root_name or not allow_path(parts[1:]) or ent.issym() or ent.islnk() or ent.isdev() or ent.size>250_000: fail("UNSAFE_ARCHIVE_ENTRY")
   target=core.joinpath(*parts[1:])
   if ent.isdir(): target.mkdir(parents=True,exist_ok=True,mode=0o755); continue
   if not ent.isfile() or target.exists(): fail("UNEXPECTED_ARCHIVE_ENTRY")
   target.parent.mkdir(parents=True,exist_ok=True,mode=0o755); source=pkg.extractfile(ent)
   if source is None: fail("ARCHIVE_MEMBER_UNREADABLE")
   target.write_bytes(source.read()); target.chmod(0o644)
  manifest_path=core/"release-manifest.json"
  if not manifest_path.is_file(): fail("PORTABLE_MANIFEST_MISSING")
  manifest=json.loads(manifest_path.read_text())
  if manifest.get("releaseType")!="READONLY_PREVIEW" or manifest.get("version")!=CORE_VERSION or manifest.get("schema")!=1: fail("PORTABLE_MANIFEST_MISMATCH")
  required={"src/native-core.mjs","scripts/mcp-schema-parity-smoke.mjs"}|REQUIRED_DIRECT_SOURCE
  names={f.get("path") for f in manifest.get("files",[]) if isinstance(f,dict)}
  if not required.issubset(names): fail("PORTABLE_NATIVE_PARITY_SOURCE_MISSING")
  seen=set()
  for f in manifest.get("files",[]):
   rel=f.get("path")
   if not isinstance(rel,str) or not allow_path(Path(rel).parts) or rel in seen: fail("PORTABLE_MANIFEST_ENTRY_UNSAFE")
   seen.add(rel); p=core/rel
   if not p.is_file() or len(p.read_bytes())!=f.get("bytes") or digest(p.read_bytes())!=f.get("sha256"): fail("PORTABLE_SOURCE_HASH_MISMATCH")
  for p in core.rglob("*"):
   if p.is_file() and p.name!="release-manifest.json" and p.relative_to(core).as_posix() not in seen: fail("UNEXPECTED_PORTABLE_FILE")
  verify_diagnostic(core); manifest_path.unlink()
 shutil.copytree(ROOT/"node_modules",core/"node_modules",ignore=shutil.ignore_patterns(".bin"),symlinks=False)
 for fn in ("desktop-inspect.mjs","desktop-smoke.mjs"): (core/"scripts"/fn).write_bytes(safe_file(ROOT/"scripts"/fn))
 records=[]
 for p in sorted(core.rglob("*")):
  if p.is_symlink(): fail("BUNDLED_SYMLINK_UNSAFE")
  if p.is_file():
   data=p.read_bytes()
   if p.suffix in (".node",".so",".dylib",".p8",".p12",".pem",".key",".sqlite") or data[:4] in (bytes.fromhex("cffaedfe"),bytes.fromhex("feedfacf"),bytes.fromhex("cafebabe")): fail("BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE")
   p.chmod(0o644); records.append({"path":p.relative_to(core).as_posix(),"bytes":len(data),"sha256":digest(data)})
  elif p.is_dir(): p.chmod(0o755)
 (res/"core-manifest.json").write_text(json.dumps({"schema":1,"version":CORE_VERSION,"files":records},indent=2,ensure_ascii=False)+"\n")
 shutil.copyfile(ICON,res/"AppIcon.icns")
 info={"CFBundleIdentifier":"tech.oppstudio.theosynapse.desktop","CFBundleName":"Theo Synapse","CFBundleDisplayName":"Theo Synapse","CFBundleExecutable":"TheoSynapse","CFBundlePackageType":"APPL","CFBundleShortVersionString":APP_VERSION,"CFBundleVersion":"7","CFBundleIconFile":"AppIcon","LSMinimumSystemVersion":"14.0","NSHighResolutionCapable":True,"NSPrincipalClass":"NSApplication","NSHumanReadableCopyright":"Copyright © 2026 O.P.P Studio. All rights reserved.","CFBundleDevelopmentRegion":"ja"}
 (cont/"Info.plist").write_bytes(plistlib.dumps(info))
 (res/"START_HERE_JA.txt").write_text("Theo Synapse for Mac "+APP_VERSION+"\n\n1. 「初期設定」でMac内の読み取り専用環境を作ります。\n2. 「起動」→「接続診断」で8ツールを確認します。\n\n既定は読み取り専用です。direct書き込みは恒久無効ではありませんが、native Ownerの明示承認と公開済みツール・host認可が必要です。ChatGPTへの実接続はこの画面だけでは証明できません。Tunnel・秘密情報・履歴は移行しません。Node 24+、Codex CLIの導入・ログインが必要です。\nO.P.P Studio\n",encoding="utf-8")
 if "Macアプリ "+APP_VERSION not in (ROOT/"macos"/"TheoSynapse.swift").read_text(): fail("NATIVE_DISPLAY_VERSION_MISMATCH")
 executable=mac/"TheoSynapse"; run(["/usr/bin/xcrun","swiftc","-swift-version","5","-O","-whole-module-optimization","-target","arm64-apple-macos14.0","-framework","SwiftUI","-framework","AppKit",str(ROOT/"macos"/"DesktopHost.swift"),str(ROOT/"macos"/"TheoSynapse.swift"),"-o",str(executable)])
 for p in (app,cont,res,mac,core): p.chmod(0o755)
 executable.chmod(0o755)
 report={"status":"BUILT_UNSIGNED","app":str(app),"version":APP_VERSION,"coreVersion":CORE_VERSION,"files":len(records),"diagnosticMigrationIncluded":True,"credentialIncluded":False,"existingAppModified":False,"tunnelModified":False,"signed":False,"notarized":False}
 (release/"build-report.json").write_text(json.dumps(report,indent=2)+"\n"); print(json.dumps(report)); return app
if __name__=="__main__":
 if len(sys.argv)!=3: fail("USAGE: build-native-app-v015.py ARCHIVE_PATH SHA256")
 if not isinstance(sys.argv[2],str) or len(sys.argv[2])!=64: fail("SHA256_INVALID")
 build(Path(sys.argv[1]),sys.argv[2])
