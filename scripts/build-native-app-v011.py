#!/usr/bin/env python3
"""Produce a new, unsigned, versioned Theo Synapse app beside the existing install.
Never modifies an installed app, Keychain, LaunchAgent, Tunnel or .local runtime.
"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
APP_VERSION = "0.1.1"
CORE_VERSION = "0.0.5"
NAME = "Theo Synapse.app"
PRIVATE_BUILD = ROOT / ".local" / "native-macos-20261028" / "unsigned-candidates"
RELEASES = ROOT / ".local" / "releases"
ICON = Path.home() / "Applications" / "Theo Synapse.app" / "Contents" / "Resources" / "AppIcon.icns"

def fail(reason):
    raise RuntimeError(reason)

def digest(data):
    return hashlib.sha256(data).hexdigest()

def safe_file(path, max_bytes=250_000):
    s = path.lstat()
    if not path.is_file() or path.is_symlink() or s.st_uid != os.getuid() or \
       s.st_size > max_bytes or s.st_nlink != 1:
        fail("UNTRUSTED_SOURCE_FILE")
    return path.read_bytes()

def allow_path(parts):
    if tuple(parts) == (".gitignore",): return True
    return all(p not in ("", ".", "..", ".local", ".git", "node_modules") and
               not p.startswith(".") and len(p)<160 for p in parts)

def run(args, timeout=180):
    result=subprocess.run(args,cwd=ROOT,capture_output=True,text=True,timeout=timeout)
    if result.returncode:
        fail("NATIVE_BUILD_COMMAND_FAILED:"+str(args[0])+":"+str(result.returncode)+":"+
             result.stderr[-320:])
    return result

def build(archive, expected_sha):
    os.umask(0o077)
    if not archive.is_absolute() or archive.parent != RELEASES or \
       not archive.name.startswith("theo-synapse-readonly-preview-") or \
       archive.suffixes[-2:] != [".tar", ".gz"]:
        fail("RELEASE_PATH_UNAUTHORIZED")
    if digest(safe_file(archive, 2_000_000)) != expected_sha:
        fail("RELEASE_ARCHIVE_HASH_MISMATCH")
    if not ICON.is_file() or not (ROOT/"macos"/"TheoSynapse.swift").is_file():
        fail("REQUIRED_ICON_OR_NATIVE_SOURCE_MISSING")
    base = PRIVATE_BUILD
    base.mkdir(parents=True,mode=0o700,exist_ok=True)
    s=base.stat()
    if s.st_uid!=os.getuid() or s.st_mode & 0o077:
        fail("BUILD_PARENT_NOT_PRIVATE")
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    release=base/("v"+APP_VERSION+"-"+stamp)
    release.mkdir(mode=0o700)
    app=release/NAME
    cont=app/"Contents"
    res=cont/"Resources"
    mac=cont/"MacOS"
    core=res/"Core"
    for d in (mac,res,core):
        d.mkdir(parents=True,mode=0o755,exist_ok=True)
    with tarfile.open(archive,mode="r:gz") as pkg:
        entries=pkg.getmembers()
        if len(entries)>200:fail("TOO_MANY_ARCHIVE_ENTRIES")
        root_name = "theo-synapse-readonly-preview-"+CORE_VERSION
        manifest=None
        for ent in entries:
            ps=Path(ent.name).parts
            if len(ps)<2:
                if ent.isdir() and ps==(root_name,):continue
                fail("UNEXPECTED_ARCHIVE_ROOT")
            if ps[0] != root_name or not allow_path(ps[1:]) or \
               ent.issym() or ent.islnk() or ent.isdev() or ent.size>250_000:
                fail("UNSAFE_ARCHIVE_ENTRY")
            target=core.joinpath(*ps[1:])
            if ent.isdir():
                target.mkdir(parents=True,exist_ok=True,mode=0o755)
                continue
            if not ent.isfile():fail("UNEXPECTED_ARCHIVE_ENTRY")
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
            if target.exists():fail("DUPLICATE_ARCHIVE_MEMBER")
            source=pkg.extractfile(ent)
            if source is None:fail("ARCHIVE_MEMBER_UNREADABLE")
            target.write_bytes(source.read())
            target.chmod(0o644)
        manifest_path=core/"release-manifest.json"
        if not manifest_path.is_file():fail("PORTABLE_MANIFEST_MISSING")
        manifest=json.loads(manifest_path.read_text())
        if manifest.get("releaseType") != "READONLY_PREVIEW" or \
           manifest.get("version") != CORE_VERSION or \
           manifest.get("schema") != 1:
            fail("PORTABLE_MANIFEST_MISMATCH")
        names=set()
        for f in manifest.get("files",[]):
            rel=f.get("path")
            if not isinstance(rel,str) or not allow_path(Path(rel).parts) or rel in names:
                fail("PORTABLE_MANIFEST_ENTRY_UNSAFE")
            names.add(rel)
            p=core/rel
            if not p.is_file() or len(p.read_bytes())!=f.get("bytes") or \
               digest(p.read_bytes())!=f.get("sha256"):
                fail("PORTABLE_SOURCE_HASH_MISMATCH")
        for p in core.rglob("*"):
            if p.is_file() and p.name != "release-manifest.json" and \
               str(p.relative_to(core)) not in names:
                fail("UNEXPECTED_PORTABLE_FILE")
        manifest_path.unlink()
    # The app bundles the already-pinned local npm dependencies; no network.
    shutil.copytree(ROOT/"node_modules",core/"node_modules",
                    ignore=shutil.ignore_patterns(".bin"),symlinks=False)
    for fn in ("desktop-inspect.mjs","desktop-smoke.mjs"):
        p=ROOT/"scripts"/fn
        (core/"scripts"/fn).write_bytes(safe_file(p))
    records=[]
    for p in sorted(core.rglob("*")):
        if p.is_symlink():fail("BUNDLED_SYMLINK_UNSAFE")
        if p.is_file():
            data=p.read_bytes()
            if p.suffix in (".node",".so",".dylib",".p8",".p12",".pem",".key",".sqlite"):
                fail("BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE")
            if data[:4] in (bytes.fromhex("cffaedfe"),bytes.fromhex("feedfacf"),bytes.fromhex("cafebabe")):
                fail("BUNDLED_MACHO_UNSAFE")
            p.chmod(0o644)
            records.append({"path":p.relative_to(core).as_posix(),
                            "bytes":len(data),"sha256":digest(data)})
        elif p.is_dir():
            p.chmod(0o755)
    (res/"core-manifest.json").write_text(json.dumps({
        "schema":1,"version":CORE_VERSION,"files":records
    },indent=2,ensure_ascii=False)+"\n")
    shutil.copyfile(ICON,res/"AppIcon.icns")
    info={
      "CFBundleIdentifier":"tech.oppstudio.theosynapse.desktop",
      "CFBundleName":"Theo Synapse","CFBundleDisplayName":"Theo Synapse",
      "CFBundleExecutable":"TheoSynapse","CFBundlePackageType":"APPL",
      "CFBundleShortVersionString":APP_VERSION,"CFBundleVersion":"3",
      "CFBundleIconFile":"AppIcon","LSMinimumSystemVersion":"14.0",
      "NSHighResolutionCapable":True,"NSPrincipalClass":"NSApplication",
      "NSHumanReadableCopyright":"Copyright © 2026 O.P.P Studio. All rights reserved.",
      "CFBundleDevelopmentRegion":"ja"
    }
    (cont/"Info.plist").write_bytes(plistlib.dumps(info))
    (res/"START_HERE_JA.txt").write_text(
        "Theo Synapse for Mac "+APP_VERSION+"\n\n"+
        "1. 「初期設定」でMac内の読み取り専用環境を作ります。\n"+
        "2. 「起動」→「接続診断」で8ツールを確認します。\n"+
        "3. 「プロジェクトを追加」でIDを入力しフォルダを選び、対象ファイルをプレビューします。\n"+
        "4. 元フォルダを変えずにコピーしてよければ「Owner確認へ」→Macの承認画面で許可します。\n\n"+
        "ChatGPT接続はまだ旧Standalone側です。新アプリへ秘密情報・履歴を自動移行しません。\n"+
        "書き込み機能は無効。Node 24+、Codex CLIの導入・ログインが必要です。\n"
        "O.P.P Studio\n",encoding="utf-8"
    )
    swift=str(ROOT/"macos"/"TheoSynapse.swift")
    swift_text=(ROOT/"macos"/"TheoSynapse.swift").read_text()
    if ("Macアプリ "+APP_VERSION) not in swift_text:
        fail("NATIVE_DISPLAY_VERSION_MISMATCH")
    executable=mac/"TheoSynapse"
    run(["/usr/bin/xcrun","swiftc","-swift-version","5","-O",
         "-whole-module-optimization","-target","arm64-apple-macos14.0",
         "-framework","SwiftUI","-framework","AppKit",
         str(ROOT/"macos"/"DesktopHost.swift"),swift,"-o",str(executable)],
        timeout=180)
    for p in (app,cont,res,mac,core):p.chmod(0o755)
    executable.chmod(0o755)
    report={
      "status":"BUILT_UNSIGNED","app":str(app),"version":APP_VERSION,
      "coreVersion":CORE_VERSION,"files":len(records),"credentialIncluded":False,
      "existingAppModified":False,"tunnelModified":False,
      "signed":False,"notarized":False
    }
    (release/"build-report.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report))
    return app

if __name__=="__main__":
    if len(sys.argv)!=3:fail("USAGE: build-native-app-v011.py ARCHIVE_PATH SHA256")
    archive=Path(sys.argv[1])
    if not isinstance(sys.argv[2],str) or len(sys.argv[2])!=64:fail("SHA256_INVALID")
    build(archive,sys.argv[2])
