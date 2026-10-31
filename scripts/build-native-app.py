#!/usr/bin/env python3
"""Build native Mac app from accepted read-only core; no credential/runtime copying."""
from pathlib import Path
import hashlib,json,os,plistlib,shutil,subprocess,tarfile,datetime
ROOT=Path(__file__).resolve().parents[1]
os.umask(0o077)
OUT=ROOT/'.local/native-macos-20261028'
OUT.mkdir(mode=0o700,exist_ok=True)
APP=OUT/'Theo Synapse.app'
if APP.exists():raise SystemExit('BUILD_DESTINATION_EXISTS')
CONT=APP/'Contents';MAC=CONT/'MacOS';RES=CONT/'Resources'
MAC.mkdir(parents=True,mode=0o755);RES.mkdir(mode=0o755)
CORE=RES/'Core';CORE.mkdir(mode=0o755)
archive=ROOT/'.local/releases/theo-synapse-readonly-preview-0.0.5-2026-10-28T05-32-43-760Z.tar.gz'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='7a5c52086d735ba9ee21548e37e9d02c0ca0664fae3c778ed5c25ea636d77089'
with tarfile.open(archive) as t:
 for entry in t.getmembers():
  parts=Path(entry.name).parts[1:]
  if not parts:continue
  assert '..' not in parts and '.local' not in parts
  path=CORE.joinpath(*parts)
  if entry.isdir():path.mkdir(parents=True,exist_ok=True,mode=0o755)
  elif entry.isfile():
   path.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
   path.write_bytes(t.extractfile(entry).read());path.chmod(0o644)
  else:raise SystemExit('UNEXPECTED_ARCHIVE_LINK')
# No install scripts or network fetch. Keep npm licenses and exact accepted versions.
shutil.copytree(ROOT/'node_modules',CORE/'node_modules',ignore=shutil.ignore_patterns('.bin'))
for name in ['desktop-inspect.mjs','desktop-smoke.mjs']:
 shutil.copyfile(ROOT/'scripts'/name,CORE/'scripts'/name)
# Native app uses a signed outer manifest for its complete offline core.
(CORE/'release-manifest.json').unlink()
entries=[]
for p in sorted(CORE.rglob('*')):
 assert not p.is_symlink(),str(p)
 if p.is_file():
  assert p.suffix not in {'.node','.dylib','.so','.key','.pem','.sqlite'},str(p)
  data=p.read_bytes()
  assert data[:4] not in [bytes.fromhex('cffaedfe'),bytes.fromhex('feedfacf'),bytes.fromhex('cafebabe')],str(p)
  p.chmod(0o644)
  entries.append({'path':p.relative_to(CORE).as_posix(),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
 elif p.is_dir():p.chmod(0o755)
(RES/'core-manifest.json').write_text(json.dumps({'schema':1,'version':'0.0.5','files':entries},indent=2)+'\n')
iconset=OUT/'TheoSynapse.iconset';iconset.mkdir(mode=0o700)
svg=ROOT/'assets/theo-synapse-icon.svg'
for size in [16,32,128,256,512]:
 for scale in [1,2]:
  out=iconset/f'icon_{size}x{size}{"@2x" if scale==2 else ""}.png'
  subprocess.run(['/opt/homebrew/bin/rsvg-convert','-w',str(size*scale),'-h',str(size*scale),str(svg),'-o',str(out)],check=True)
subprocess.run(['/usr/bin/iconutil','-c','icns',str(iconset),'-o',str(RES/'AppIcon.icns')],check=True)
info={'CFBundleIdentifier':'tech.oppstudio.theosynapse.desktop','CFBundleName':'Theo Synapse','CFBundleDisplayName':'Theo Synapse','CFBundleExecutable':'TheoSynapse','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','CFBundleVersion':'2','CFBundleIconFile':'AppIcon','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True,'NSPrincipalClass':'NSApplication','NSHumanReadableCopyright':'Copyright © 2026 O.P.P Studio. All rights reserved.','CFBundleDevelopmentRegion':'ja'}
(CONT/'Info.plist').write_bytes(plistlib.dumps(info))
(RES/'START_HERE_JA.txt').write_text('''Theo Synapse for Mac 0.1.0\n\n1. 「初期設定」を押すと、このMac専用の実行環境と無害なデモを作ります。\n2. 「起動」で読み取り専用サービスを開始します。次回ログイン時も起動します。\n3. 「接続診断」でMCPの8ツールを確認します。モデルの作業実行はしません。\n4. 「停止」「再起動」はこのアプリ専用のサービスだけを操作します。作業中は停止しません。\n\n必要条件：macOS 14以上／Apple Silicon／Node.js 24以上／Codex CLI。Codexのモデル利用にはログインと利用枠が必要です。\nNode.js・Codex・APIキーは自動導入しません。依存npmモジュールは同梱済みです。\n\n実行フォルダ：~/Library/Application Support/Theo Synapse/core\n自動起動：~/Library/LaunchAgents/tech.oppstudio.theosynapse.desktop.readonly.plist\n\n重要：現在のChatGPTプラグインへの接続は、既存のStandalone領域を引き続き使います。本MacアプリへTunnel・秘密キー・プロジェクト履歴は自動移行しません。\n書き込み機能は無効です。正式版の全機能完成を意味しません。\n\nO.P.P Studio\n''')
subprocess.run(['/usr/bin/xcrun','swiftc','-swift-version','5','-O','-whole-module-optimization','-target','arm64-apple-macos14.0','-framework','SwiftUI','-framework','AppKit',str(ROOT/'macos/DesktopHost.swift'),str(ROOT/'macos/TheoSynapse.swift'),'-o',str(MAC/'TheoSynapse')],check=True)
for p in [APP,CONT,MAC,RES,CORE]:p.chmod(0o755)
(MAC/'TheoSynapse').chmod(0o755)
print(json.dumps({'status':'BUILT_UNSIGNED','app':str(APP),'bundledFiles':len(entries),'version':'0.1.0','readOnly':True,'nodeBundled':False,'credentialsBundled':False}))
