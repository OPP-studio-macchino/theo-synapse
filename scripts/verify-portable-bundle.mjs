// Standalone preview integrity verifier. No network, model turn or mutation.
// Hash list is not a signature; signed distribution requires a separate gate.
import {readFileSync,lstatSync,realpathSync,readdirSync,existsSync} from 'node:fs';
import {join,resolve,relative,sep,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const sha=b=>createHash('sha256').update(b).digest('hex');
const safeRel=s=>typeof s==='string'&&s.length>0&&s.length<240&&
 !s.startsWith('/')&&!s.includes('\\')&&!s.includes('\0')&&
 s.split('/').every(n=>n!=='.'&&n!=='..'&&n.length>0);
export function verifyPortableBundle(root,{ignoreRuntime=true}={}){
 if(typeof root!=='string'||resolve(root)!==root||realpathSync.native(root)!==root)
  throw Error('PORTABLE_ROOT_NOT_CANONICAL');
 const file=join(root,'release-manifest.json');
 const stat=lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)
  throw Error('PORTABLE_MANIFEST_UNSAFE');
 let manifest;
 try{manifest=JSON.parse(readFileSync(file,'utf8'));}catch{throw Error('PORTABLE_MANIFEST_INVALID');}
 if(!manifest||manifest.schema!==1||manifest.product!=='Theo Synapse'||
    manifest.releaseType!=='READONLY_PREVIEW'||
    typeof manifest.version!=='string'||!Array.isArray(manifest.files)||
    manifest.files.length<12||manifest.files.length>160)
  throw Error('PORTABLE_MANIFEST_INVALID');
 const names=new Set(),failures=[];
 for(const item of manifest.files){
  if(!item||!safeRel(item.path)||!/^([a-f0-9]{64})$/.test(item.sha256??'')||
     !Number.isSafeInteger(item.bytes)||item.bytes<0||item.bytes>250000)
   throw Error('PORTABLE_MANIFEST_ENTRY_INVALID');
  if(names.has(item.path))throw Error('PORTABLE_MANIFEST_DUPLICATE');
  names.add(item.path);
  if(item.path.startsWith('.local/')||item.path.startsWith('node_modules/')||
     item.path.startsWith('.git/')||item.path.includes('/.env')||
     /\.(?:pem|p8|p12|key|sqlite|sqlite-wal|sqlite-shm)$/.test(item.path))
   throw Error('PORTABLE_MANIFEST_SECRET_PATH');
  const path=join(root,item.path);
  try{
   const s=lstatSync(path);
   if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||
      s.size!==item.bytes||sha(readFileSync(path))!==item.sha256)
    failures.push({path:item.path,code:'MISMATCH'});
  }catch{failures.push({path:item.path,code:'UNAVAILABLE'});}
 }
 const required=['package.json','package-lock.json','README.md',
  'src/mcp.mjs','src/native-core.mjs','src/task-daemon.mjs','src/direct-action-review.mjs','scripts/setup-readonly-lab.mjs',
  'scripts/theo-task-entry.mjs','scripts/mcp-schema-parity-smoke.mjs','scripts/theo-native-plugin-doctor.mjs',
  'scripts/theo-direct-workspaces.mjs','scripts/theo-direct-daemon-entry.mjs',
  'assets/theo-synapse-icon-64.png'];
 if(required.some(x=>!names.has(x)))throw Error('PORTABLE_REQUIRED_FILE_MISSING');
 const tree=[];
 const walk=(dir)=>{
  for(const ent of readdirSync(dir,{withFileTypes:true})){
   if(ent.name==='.local'||ent.name==='node_modules'||ent.name==='.DS_Store')continue;
   const p=join(dir,ent.name),rel=relative(root,p);
   if(ent.isSymbolicLink()){failures.push({path:rel,code:'UNEXPECTED_SYMLINK'});continue;}
   if(ent.isDirectory()){walk(p);continue;}
   if(ent.isFile()&&rel!=='release-manifest.json'&&!names.has(rel))
    failures.push({path:rel,code:'UNEXPECTED_FILE'});
  }
 };
 walk(root);
 return {
  verdict:failures.length?'FAIL':'PASS',
  releaseType:manifest.releaseType,
  version:manifest.version,
  filesVerified:manifest.files.length-failures.length,
  fileCount:manifest.files.length,
  failures
 };
}

if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const report=verifyPortableBundle(root);
 console.log(JSON.stringify(report,null,2));
 if(report.verdict!=='PASS')process.exitCode=1;
}
