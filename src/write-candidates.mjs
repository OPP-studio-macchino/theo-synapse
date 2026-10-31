// Quarantined, private candidate edit staging. Never writes to source snapshots.
import {createHash} from 'node:crypto';
import {
  lstatSync,realpathSync,openSync,readSync,fstatSync,closeSync,readdirSync,
  mkdirSync,writeFileSync,existsSync,rmSync,constants
} from 'node:fs';
import {resolve,join,relative,dirname,sep,extname,basename} from 'node:path';

const sha=b=>createHash('sha256').update(b).digest('hex');
const MAX_FILES=180,MAX_FILE_BYTES=131072,MAX_TOTAL=10485760;
const uid=()=>process.getuid();
const privateDir=p=>{
 const s=lstatSync(p);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid()||(s.mode&0o077)!==0||
   realpathSync.native(p)!==p)throw Error('WRITE_DIRECTORY_UNSAFE');
};
function safeRead(p){
 const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const st=fstatSync(fd);
  if(!st.isFile()||st.nlink!==1||st.uid!==uid()||
    (st.mode&0o077)!==0||st.size<0||st.size>MAX_FILE_BYTES)
   throw Error('WRITE_SOURCE_FILE_UNSAFE');
  const data=Buffer.alloc(st.size);
  let pos=0;
  while(pos<data.length){
   const n=readSync(fd,data,pos,data.length-pos,pos);
   if(n<=0)throw Error('WRITE_SOURCE_CHANGED');
   pos+=n;
  }
  const again=fstatSync(fd);
  if(again.size!==st.size||again.ino!==st.ino)throw Error('WRITE_SOURCE_CHANGED');
  return data;
 }finally{closeSync(fd);}
}
function safeRel(name){
 if(typeof name!=='string'||name.length<1||name.length>220||
    name.startsWith('/')||name.includes('\\')||name.includes('\0')||
    name.split('/').some(x=>x===''||x==='.'||x==='..'||x.startsWith('.'))||
    !/^[A-Za-z0-9_./ -]+$/.test(name))
  throw Error('WRITE_PATH_INVALID');
 return name;
}
export function snapshotManifest(directory){
 const root=resolve(directory);
 if(root!==directory)throw Error('WRITE_DIRECTORY_ALIAS');
 privateDir(root);
 const files=[],data=new Map();
 let total=0;
 const walk=(dir,depth)=>{
  if(depth>9)throw Error('WRITE_DEPTH_LIMIT');
  privateDir(dir);
  for(const entry of readdirSync(dir,{withFileTypes:true})){
   const p=join(dir,entry.name),relativeName=relative(root,p);
   if(entry.isSymbolicLink())throw Error('WRITE_SYMLINK_DETECTED');
   if(entry.isDirectory()){safeRel(relativeName);walk(p,depth+1);continue;}
   if(!entry.isFile())throw Error('WRITE_SPECIAL_FILE_DETECTED');
   safeRel(relativeName);
   const b=safeRead(p); total+=b.length;
   if(total>MAX_TOTAL||files.length+1>MAX_FILES)throw Error('WRITE_SNAPSHOT_TOO_LARGE');
   data.set(relativeName,b);
   files.push({path:relativeName,size:b.length,hash:sha(b)});
  }
 };
 walk(root,0);
 files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
 if(files.length===0)throw Error('WRITE_EMPTY_SNAPSHOT');
 return {directory:root,files,data,bytes:total,hash:sha(JSON.stringify(files))};
}
export function prepareWritePlan({projectRoot,id,projectId,instruction,allowedFiles}={}){
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(id))throw Error('WRITE_ID_INVALID');
 if(typeof projectId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(projectId))
  throw Error('WRITE_PROJECT_INVALID');
 if(typeof instruction!=='string'||instruction.length<12||instruction.length>240||
    instruction.trim()!==instruction||/[\x00-\x1f]/.test(instruction))
  throw Error('WRITE_INSTRUCTION_INVALID');
 if(/\bsk-(?:proj-)?[A-Za-z0-9_-]{14,}|\bBearer\s+\S{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(instruction))
  throw Error('WRITE_INSTRUCTION_CONTAINS_SECRET');
 if(!Array.isArray(allowedFiles)||allowedFiles.length<1||allowedFiles.length>3)
  throw Error('WRITE_FILE_SELECTION_INVALID');
 const normalized=[...new Set(allowedFiles.map(safeRel))].sort();
 if(normalized.length!==allowedFiles.length)throw Error('WRITE_FILE_SELECTION_DUPLICATE');
 const manifest=snapshotManifest(projectRoot);
 const indexed=new Map(manifest.files.map(x=>[x.path,x]));
 const fileHashes={};
 for(const name of normalized){
  const item=indexed.get(name);
  if(!item)throw Error('WRITE_FILE_NOT_PRESENT');
  if(!['.js','.mjs','.cjs','.ts','.tsx','.css','.html','.json','.md','.py','.swift'].includes(extname(name)))
   throw Error('WRITE_UNSUPPORTED_FILE_TYPE');
  fileHashes[name]=item.hash;
 }
 return {id,projectId,instruction,allowedFiles:normalized,
   snapshotHash:manifest.hash,fileHashes};
}
function ensureCandidateParent(root){
 const runtime=resolve(root);
 privateDir(runtime);
 const dir=join(runtime,'write-candidates');
 if(!existsSync(dir))mkdirSync(dir,{mode:0o700});
 privateDir(dir);
 return dir;
}
export function stageApprovedCandidate({runtime,projectRoot,request}={}){
 if(!request||typeof request.id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(request.id))
  throw Error('WRITE_SCOPE_MISSING');
 const snapshot=snapshotManifest(projectRoot);
 if(snapshot.hash!==request.snapshotHash)throw Error('WRITE_SNAPSHOT_HASH_CHANGED');
 const indexes=new Map(snapshot.files.map(x=>[x.path,x.hash]));
 for(const f of request.allowedFiles){
  if(indexes.get(f)!==request.fileHashes[f])throw Error('WRITE_FILE_HASH_CHANGED');
 }
 const parent=ensureCandidateParent(runtime);
 const dest=join(parent,request.id);
 if(existsSync(dest))throw Error('WRITE_CANDIDATE_ALREADY_EXISTS');
 mkdirSync(dest,{mode:0o700});
 let success=false;
 try{
  for(const file of snapshot.files){
   const p=join(dest,file.path);
   const parentDir=dirname(p);
   mkdirSync(parentDir,{recursive:true,mode:0o700});
   writeFileSync(p,snapshot.data.get(file.path),{flag:'wx',mode:0o600});
  }
  const cloned=snapshotManifest(dest);
  if(cloned.hash!==snapshot.hash)throw Error('WRITE_STAGING_HASH_MISMATCH');
  success=true;
  return {candidateDir:dest,before:snapshot};
 }finally{if(!success)rmSync(dest,{recursive:true,force:true});}
}
function validResultText(b){
 try{
  const txt=new TextDecoder('utf-8',{fatal:true}).decode(b);
  if(txt.includes('\0')||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(txt)||
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{14,}/.test(txt)||
    /\b(?:github_pat_|ghp_)[A-Za-z0-9_-]{12,}/.test(txt))return false;
  return true;
 }catch{return false;}
}
export function verifyCandidateChanges({candidateDir,before,allowedFiles}={}){
 const after=snapshotManifest(candidateDir);
 if(after.files.length!==before.files.length||
    after.files.some((f,i)=>f.path!==before.files[i].path))
  throw Error('WRITE_UNAPPROVED_PATH_OR_DELETE');
 const allowed=new Set(allowedFiles);
 const changed=[];
 for(let i=0;i<before.files.length;i++){
  const prev=before.files[i],curr=after.files[i];
  if(prev.hash===curr.hash)continue;
  if(!allowed.has(curr.path))throw Error('WRITE_UNAPPROVED_FILE_MODIFIED');
  if(!validResultText(after.data.get(curr.path)))throw Error('WRITE_OUTPUT_NOT_SAFE_TEXT');
  changed.push({path:curr.path,beforeSha256:prev.hash,afterSha256:curr.hash,
   beforeBytes:prev.size,afterBytes:curr.size});
 }
 if(changed.length===0)throw Error('WRITE_NO_CHANGES');
 return {changedFiles:changed,manifestHash:after.hash,filesCount:after.files.length,
  originalSnapshotUnmodified:true};
}
export function discardCandidate(directory,runtime){
 if(typeof directory!=='string'||typeof runtime!=='string'||resolve(directory)!==directory||
    resolve(runtime)!==runtime)throw Error('WRITE_DISCARD_PATH_INVALID');
 const parent=join(runtime,'write-candidates');
 privateDir(runtime);
 if(dirname(directory)!==parent||!/^[A-Za-z0-9_-]{8,80}$/.test(basename(directory)))
  throw Error('WRITE_DISCARD_OUTSIDE_STAGE');
 if(!existsSync(directory))return;
 privateDir(parent);
 privateDir(directory);
 rmSync(directory,{recursive:true,force:true});
}
