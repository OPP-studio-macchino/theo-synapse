#!/usr/bin/env python3
"""Produce an unsigned, signing-ready v0.1.9 candidate in private staging only."""
import datetime,hashlib,json,os,plistlib,shutil,subprocess,sys,tarfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
APP_VERSION="0.1.9"; CORE_VERSION="0.0.5"; NAME="Theo Synapse.app"
PRIVATE_BUILD=ROOT/".local"/"native-macos-20261029"/"native-build"; RELEASES=ROOT/".local"/"releases"
ICON=Path.home()/"Applications"/"Theo Synapse.app"/"Contents"/"Resources"/"AppIcon.icns"
REQUIRED={'src/direct-action-review.mjs',"src/direct-coordinator.mjs","src/direct-native-factory.mjs","src/direct-workspace-registry.mjs","src/direct-owner-approval.mjs","src/task-daemon.mjs","scripts/theo-direct-workspaces.mjs","scripts/theo-direct-daemon-entry.mjs","scripts/theo-task-entry.mjs"}
def fail(x):raise RuntimeError(x)
def digest(x):return hashlib.sha256(x).hexdigest()
def safe(p,n=250000):
 s=p.lstat()
 if not p.is_file() or p.is_symlink() or s.st_uid!=os.getuid() or s.st_size>n or s.st_nlink!=1:fail("UNTRUSTED_SOURCE_FILE")
 return p.read_bytes()
def allowed(parts):return tuple(parts)==(".gitignore",) or all(x not in ("",".","..",".local",".git","node_modules") and not x.startswith(".") and len(x)<160 for x in parts)
def run(a):
 p=subprocess.run(a,cwd=ROOT,capture_output=True,text=True,timeout=180)
 if p.returncode:fail("NATIVE_BUILD_COMMAND_FAILED:"+str(p.returncode)+":"+p.stderr[-320:])
def build(archive,expected):
 os.umask(0o077)
 if not archive.is_absolute() or archive.parent!=RELEASES or not archive.name.startswith("theo-synapse-readonly-preview-") or archive.suffixes[-2:]!=['.tar','.gz']:fail("RELEASE_PATH_UNAUTHORIZED")
 if digest(safe(archive,2000000))!=expected:fail("RELEASE_ARCHIVE_HASH_MISMATCH")
 if not ICON.is_file() or not (ROOT/'macos'/'DesktopHost.swift').is_file():fail("REQUIRED_ICON_OR_NATIVE_SOURCE_MISSING")
 for p in REQUIRED:safe(ROOT/p)
 if not PRIVATE_BUILD.is_dir() or PRIVATE_BUILD.stat().st_uid!=os.getuid() or PRIVATE_BUILD.stat().st_mode&0o077:fail("BUILD_PARENT_MISSING")
 release=PRIVATE_BUILD/("v"+APP_VERSION+"-"+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+uuid.uuid4().hex);release.mkdir(mode=0o700)
 app=release/NAME;cont=app/'Contents';res=cont/'Resources';mac=cont/'MacOS';core=res/'Core'
 for d in (mac,res,core):d.mkdir(parents=True,mode=0o755,exist_ok=True)
 with tarfile.open(archive,'r:gz') as pkg:
  root='theo-synapse-readonly-preview-'+CORE_VERSION;seen=set()
  for e in pkg.getmembers():
   parts=Path(e.name).parts
   if len(parts)<2:
    if e.isdir() and parts==(root,):continue
    fail('UNEXPECTED_ARCHIVE_ROOT')
   if parts[0]!=root or not allowed(parts[1:]) or e.issym() or e.islnk() or e.isdev() or e.size>250000:fail('UNSAFE_ARCHIVE_ENTRY')
   target=core.joinpath(*parts[1:])
   if e.isdir():target.mkdir(parents=True,exist_ok=True,mode=0o755);continue
   if not e.isfile() or target.exists():fail('UNEXPECTED_ARCHIVE_ENTRY')
   target.parent.mkdir(parents=True,exist_ok=True,mode=0o755);target.write_bytes(pkg.extractfile(e).read());target.chmod(0o644)
  manifest=json.loads((core/'release-manifest.json').read_text())
  if manifest.get('releaseType')!='READONLY_PREVIEW' or manifest.get('version')!=CORE_VERSION:fail('PORTABLE_MANIFEST_MISMATCH')
  names={x.get('path') for x in manifest.get('files',[]) if isinstance(x,dict)}
  if not REQUIRED.issubset(names):fail('PORTABLE_NATIVE_PARITY_SOURCE_MISSING')
  for x in manifest['files']:
   p=core/x['path']
   if not p.is_file() or len(p.read_bytes())!=x['bytes'] or digest(p.read_bytes())!=x['sha256']:fail('PORTABLE_SOURCE_HASH_MISMATCH')
 (core/'release-manifest.json').unlink()
 for name in ('desktop-inspect.mjs','desktop-smoke.mjs'):(core/'scripts'/name).write_bytes(safe(ROOT/'scripts'/name))
 shutil.copytree(ROOT/'node_modules',core/'node_modules',ignore=shutil.ignore_patterns('.bin'),symlinks=False)
 records=[]
 for p in sorted(core.rglob('*')):
  if p.is_symlink():fail('BUNDLED_SYMLINK_UNSAFE')
  if p.is_file():
   b=p.read_bytes()
   if p.suffix in ('.node','.so','.dylib','.p8','.p12','.pem','.key','.sqlite'):fail('BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE')
   p.chmod(0o644);records.append({'path':p.relative_to(core).as_posix(),'bytes':len(b),'sha256':digest(b)})
  elif p.is_dir():p.chmod(0o755)
 (res/'core-manifest.json').write_text(json.dumps({'schema':1,'version':CORE_VERSION,'files':records},indent=2)+'\n')
 shutil.copyfile(ICON,res/'AppIcon.icns');info={'CFBundleIdentifier':'tech.oppstudio.theosynapse.desktop','CFBundleName':'Theo Synapse','CFBundleExecutable':'TheoSynapse','CFBundlePackageType':'APPL','CFBundleShortVersionString':APP_VERSION,'CFBundleVersion':'12','CFBundleIconFile':'AppIcon','LSMinimumSystemVersion':'14.0','NSHighResolutionCapable':True}
 (cont/'Info.plist').write_bytes(plistlib.dumps(info));(res/'START_HERE_JA.txt').write_text('Theo Synapse for Mac '+APP_VERSION+'\n\n既定はREADONLY(8)です。DIRECT(10)はOwnerが実フォルダを5分の確認番号と別のmacOS許可で登録し、起動も明示許可した場合だけ有効です。両方は同時起動しません。\n',encoding='utf-8')
 if 'Macアプリ '+APP_VERSION not in (ROOT/'macos'/'TheoSynapse.swift').read_text():fail('NATIVE_DISPLAY_VERSION_MISMATCH')
 exe=mac/'TheoSynapse';run(['/usr/bin/xcrun','swiftc','-swift-version','5','-O','-whole-module-optimization','-target','arm64-apple-macos14.0','-framework','SwiftUI','-framework','AppKit',str(ROOT/'macos'/'DesktopHost.swift'),str(ROOT/'macos'/'TheoSynapse.swift'),'-o',str(exe)])
 for p in (app,cont,res,mac,core):p.chmod(0o755)
 exe.chmod(0o755);report={'status':'BUILT_UNSIGNED','app':str(app),'version':APP_VERSION,'coreVersion':CORE_VERSION,'files':len(records),'existingAppModified':False,'signed':False,'notarized':False};(release/'build-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return app
if __name__=='__main__':
 if len(sys.argv)!=3 or len(sys.argv[2])!=64:fail('USAGE: build-native-app-v019.py ARCHIVE_PATH SHA256')
 build(Path(sys.argv[1]),sys.argv[2])
