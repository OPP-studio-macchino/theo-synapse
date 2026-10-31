// Theo Synapse READONLY PREVIEW packager. Zero credentials and zero live configuration.
// Distribution requires separate developer signing/notarization and Owner acceptance.
import {
 lstatSync,realpathSync,readdirSync,readFileSync,writeFileSync,
 mkdirSync,mkdtempSync,rmSync,existsSync
} from 'node:fs';
import {join,resolve,dirname,relative,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyPortableBundle} from './verify-portable-bundle.mjs';

process.umask(0o077);
const root=realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const main=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const label='theo-synapse-readonly-preview-'+main.version;
const archiveBase=join(root,'.local','releases');
const privateFolder=path=>{
 const s=lstatSync(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
    (s.mode&0o077)!==0||realpathSync.native(path)!==path)
  throw Error('RELEASE_DIRECTORY_NOT_PRIVATE');
};
privateFolder(join(root,'.local'));
try{mkdirSync(archiveBase,{mode:0o700});}
catch(e){if(e.code!=='EEXIST')throw e;}
privateFolder(archiveBase);

const scriptNames=[
 'setup-readonly-lab.mjs',
 'task-daemon-entry.mjs',
 'theo-task-entry.mjs',
 'tunnel-entry.mjs',
 'theo-projects.mjs',
 'portable-doctor.mjs',
 'portable-smoke.mjs',
 'mcp-schema-parity-smoke.mjs',
 'theo-native-plugin-doctor.mjs',
 'theo-direct-workspaces.mjs',
 'theo-direct-daemon-entry.mjs',
 'verify-portable-bundle.mjs',
 'stage-launchagent.mjs'
];
const sourceNames=[
 ...readdirSync(join(root,'src')).filter(name=>name.endsWith('.mjs')).map(name=>'src/'+name),
 ...scriptNames.map(name=>'scripts/'+name),
 'assets/theo-synapse-icon-64.png','.gitignore','package-lock.json'
];
const generatedPackage={
 name:main.name,version:main.version,private:true,type:'module',engines:main.engines,
 scripts:{
  'setup:readonly':'node scripts/setup-readonly-lab.mjs',
  'doctor':'node scripts/portable-doctor.mjs',
  'doctor:native-plugin':'node scripts/theo-native-plugin-doctor.mjs',
  'verify:bundle':'node scripts/verify-portable-bundle.mjs',
  'smoke:portable':'node scripts/portable-smoke.mjs',
  'smoke:mcp-parity':'node scripts/mcp-schema-parity-smoke.mjs',
  'launchagent:stage':'node scripts/stage-launchagent.mjs',
  'projects:owner':'node scripts/theo-projects.mjs',
  'direct-workspaces:owner':'node scripts/theo-direct-workspaces.mjs',
  'daemon:run':'node scripts/task-daemon-entry.mjs'
 },
 dependencies:main.dependencies
};
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const archive=join(archiveBase,label+'-'+stamp+'.tar.gz');
const temp=mkdtempSync('/private/tmp/theo-portable-build-');
const stage=join(temp,label);
mkdirSync(stage,{mode:0o700});
const manifestFiles=[];
const sha=b=>createHash('sha256').update(b).digest('hex');
const unsafe=path=>path.startsWith('/')||path.includes('\\')||path.includes('\0')||
 path.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.local'))||
 path==='node_modules'||path.includes('/node_modules/')||
 /\.(?:pem|p8|p12|key|sqlite|log)$/.test(path);
function insert(path,data){
 if(unsafe(path))throw Error('UNSAFE_RELEASE_PATH');
 if(data.length>250000)throw Error('RELEASE_FILE_TOO_LARGE');
 const output=join(stage,path);
 const parent=dirname(output);
 mkdirSync(parent,{recursive:true,mode:0o700});
 writeFileSync(output,data,{flag:'wx',mode:0o600});
 manifestFiles.push({path,bytes:data.length,sha256:sha(data)});
}
let built=false;
try{
 for(const rel of sourceNames){
  if(unsafe(rel))throw Error('UNSAFE_SOURCE_PATH');
  const file=join(root,rel),s=lstatSync(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||
     s.uid!==process.getuid()||s.size>250000)
   throw Error('UNSAFE_RELEASE_SOURCE_FILE');
  const bytes=readFileSync(file);
  if(rel.endsWith('.mjs')){
   const content=bytes.toString('utf8');
   if(/\/Users\/opp-studio\//.test(content))
    throw Error('SOURCE_CONTAINS_MAC_SPECIFIC_PATH');
   if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content))
    throw Error('SOURCE_CONTAINS_PRIVATE_KEY');
  }
  insert(rel,bytes);
 }
 insert('package.json',Buffer.from(JSON.stringify(generatedPackage,null,2)+'\n'));
 insert('README.md',readFileSync(join(root,'docs','PUBLIC_READONLY_PREVIEW_20261028.md')));
 insert('docs/THEO_PLUGIN_FIRST_USE_20261029.md',readFileSync(join(root,'docs','THEO_PLUGIN_FIRST_USE_20261029.md')));
 insert('docs/REAL_WORKSPACE_REGISTRATION_STATUS_20261029.md',readFileSync(join(root,'docs','REAL_WORKSPACE_REGISTRATION_STATUS_20261029.md')));
 manifestFiles.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 const manifest={
  schema:1,product:'Theo Synapse',version:main.version,
  releaseType:'READONLY_PREVIEW',signature:'NOT_SIGNED',
  license:'PRIVATE_PREVIEW_NO_PUBLIC_LICENSE',
  existingCredentialsIncluded:false,existingProjectDataIncluded:false,
  nodeModulesIncluded:false,runtimeIncluded:false,
  generatedAt:new Date().toISOString(),
  files:manifestFiles
 };
 writeFileSync(join(stage,'release-manifest.json'),
  JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
 const checked=verifyPortableBundle(stage);
 if(checked.verdict!=='PASS')throw Error('RELEASE_SELF_INTEGRITY_FAIL');
 const tar=spawnSync('/usr/bin/tar',['-C',temp,'-czf',archive,label],{
  encoding:'utf8',timeout:30000,maxBuffer:8192,stdio:['ignore','pipe','pipe']
 });
 if(tar.status!==0||tar.error)throw Error('RELEASE_TAR_FAILED');
 const listing=spawnSync('/usr/bin/tar',['-tf',archive],{
  encoding:'utf8',timeout:12000,maxBuffer:120000
 });
 if(listing.status!==0)throw Error('RELEASE_TAR_INDEX_FAILED');
 const files=listing.stdout.split('\n').filter(Boolean);
 if(files.some(x=>x.includes('/.local/')||x.includes('/node_modules/')||
    x.includes('/.env')||x.includes('/.git/')||
    x.startsWith('/')||x.includes('../')))throw Error('RELEASE_TAR_ENTRY_UNSAFE');
 const digest=sha(readFileSync(archive));
 const checksum=archive+'.sha256';
 writeFileSync(checksum,digest+'  '+basename(archive)+'\n',{flag:'wx',mode:0o600});
 built=true;
 console.log(JSON.stringify({
  verdict:'PASS_STAGED_ARCHIVE',archive,sha256:digest,
  checksumFile:checksum,fileCount:manifestFiles.length,
  sizeBytes:lstatSync(archive).size,signature:'NOT_SIGNED',notarized:false,
  includesRuntime:false,includesNodeModules:false,
  includesCredentials:false,modelTurnStarted:false,
  liveServiceChanged:false
 },null,2));
}finally{
 rmSync(temp,{recursive:true,force:true});
 if(!built)console.error('RELEASE_BUILD_NOT_COMPLETED');
}
