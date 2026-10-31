// Owner-local registry for direct execution against a real source directory.
// It is intentionally separate from projects.json, which contains snapshots.
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,lstatSync,openSync,closeSync,renameSync,rmSync,writeFileSync,realpathSync,readFileSync,mkdirSync,rmdirSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {userInfo} from 'node:os';

const ttlMs=5*60*1000;
const idOK=id=>typeof id==='string'&&/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(id);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const privateDir=path=>{const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||realpathSync.native(path)!==path)throw Error('DIRECT_PRIVATE_DIRECTORY_REQUIRED');};
const privateFile=path=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)!==0)throw Error('DIRECT_PRIVATE_REGISTRY_REQUIRED');};
export const directRegistryPath=root=>join(resolve(root),'.local','theo-runtime','direct-workspaces.json');

function workspaceIdentity(path){
 const s=lstatSync(path);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o022)!==0)throw Error('DIRECT_WORKSPACE_UNSAFE');
 const real=realpathSync.native(path);
 if(real!==path)throw Error('DIRECT_WORKSPACE_ALIAS_DENIED');
 return hash({path,dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode&0o777});
}
function rejectPath(path,root){
 const home=userInfo().homedir&&existsSync(userInfo().homedir)?realpathSync.native(userInfo().homedir):'';
 const broad=['/','/Users','/private','/private/tmp','/tmp','/Volumes',home,join(home,'Documents'),join(home,'Desktop'),join(home,'Downloads'),join(home,'Library')].filter(Boolean);
 if(broad.includes(path)||path===root||path.startsWith(root+sep)||root.startsWith(path+sep))throw Error('DIRECT_WORKSPACE_ROOT_DENIED');
 const parts=path.split(sep).filter(Boolean);
 if(parts.some(part=>['chappy-signal','theo-lab'].includes(part.toLowerCase())))throw Error('DIRECT_WORKSPACE_RESERVED_PATH');
}
function checkedSource({standaloneRoot,sourcePath,id}){
 const root=resolve(standaloneRoot);
 if(!idOK(id)||id==='theo-lab'||id==='chappy-signal')throw Error('DIRECT_WORKSPACE_ID_DENIED');
 if(typeof sourcePath!=='string'||!sourcePath.startsWith('/')||resolve(sourcePath)!==sourcePath)throw Error('DIRECT_WORKSPACE_PATH_INVALID');
 const source=realpathSync.native(sourcePath);
 if(source!==sourcePath)throw Error('DIRECT_WORKSPACE_ALIAS_DENIED');
 rejectPath(source,root);
 return {root,source,fingerprint:workspaceIdentity(source)};
}
export function planDirectWorkspace({standaloneRoot,sourcePath,id,createdAt=Date.now()}){
 const {source,fingerprint}=checkedSource({standaloneRoot,sourcePath,id});
 if(!Number.isSafeInteger(createdAt)||createdAt<0||createdAt>Date.now())throw Error('DIRECT_PLAN_INVALID');
 const plan={id,source,fingerprint,createdAt,expiresAt:createdAt+ttlMs};
 return {...plan,confirmation:hash(plan).slice(0,20)};
}
function loadRaw(root){
 const config=directRegistryPath(root);privateDir(join(resolve(root),'.local'));privateDir(join(resolve(root),'.local','theo-runtime'));
 if(!existsSync(config))return {config,registry:{schema:1,workspaces:{}}};
 privateFile(config);if(lstatSync(config).size>8192)throw Error('DIRECT_REGISTRY_TOO_LARGE');const data=JSON.parse(String(readFileSync(config)));
 if(!data||typeof data!=='object'||Array.isArray(data)||data.schema!==1||!data.workspaces||typeof data.workspaces!=='object'||Array.isArray(data.workspaces)||Object.keys(data).sort().join(',')!=='schema,workspaces')throw Error('DIRECT_REGISTRY_INVALID');
 return {config,registry:data};
}
function writeAtomic(config,registry){
 const temp=config+'.'+randomBytes(8).toString('hex')+'.tmp';
 try{writeFileSync(temp,JSON.stringify(registry,null,2)+'\n',{flag:'wx',mode:0o600});renameSync(temp,config);}catch(e){if(existsSync(temp))rmSync(temp,{force:true});throw e;}
}
export function loadDirectWorkspaceRegistry({standaloneRoot}){
 const {registry}=loadRaw(standaloneRoot),workspaces={};
 for(const [id,entry] of Object.entries(registry.workspaces)){
  if(!idOK(id)||!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=='fingerprint,path'||typeof entry.path!=='string'||typeof entry.fingerprint!=='string')throw Error('DIRECT_REGISTRY_INVALID');
  const checked=checkedSource({standaloneRoot,sourcePath:entry.path,id});
  if(checked.fingerprint!==entry.fingerprint)throw Error('DIRECT_WORKSPACE_FINGERPRINT_CHANGED');
  workspaces[id]=checked.source;
 }
 return {ids:Object.keys(workspaces).sort(),workspaces};
}
export function registerDirectWorkspace({standaloneRoot,plan,confirm,approveOwner,assertIdle}={}){
 if(!plan||typeof plan!=='object'||typeof confirm!=='string'||typeof approveOwner!=='function')throw Error('DIRECT_REGISTRATION_ARGUMENTS_INVALID');
 if(!Number.isSafeInteger(plan.createdAt)||!Number.isSafeInteger(plan.expiresAt)||plan.createdAt>Date.now()||Date.now()>plan.expiresAt||plan.expiresAt-plan.createdAt!==ttlMs)throw Error('DIRECT_PLAN_EXPIRED');
 if(confirm!==hash({id:plan.id,source:plan.source,fingerprint:plan.fingerprint,createdAt:plan.createdAt,expiresAt:plan.expiresAt}).slice(0,20))throw Error('DIRECT_OWNER_CONFIRMATION_REQUIRED');
 assertIdle?.();const checked=checkedSource({standaloneRoot,sourcePath:plan.source,id:plan.id});
 if(checked.fingerprint!==plan.fingerprint)throw Error('DIRECT_WORKSPACE_FINGERPRINT_CHANGED');
 const {config,registry}=loadRaw(standaloneRoot);
 if(Object.hasOwn(registry.workspaces,plan.id))throw Error('DIRECT_WORKSPACE_ALREADY_REGISTERED');
 if(Object.values(registry.workspaces).some(entry=>entry?.path===checked.source))throw Error('DIRECT_WORKSPACE_ALIAS_ALREADY_REGISTERED');
 if(approveOwner({id:plan.id,source:checked.source,fingerprint:checked.fingerprint,confirmation:confirm})!==true)throw Error('DIRECT_OWNER_APPROVAL_DENIED');
 const lock=join(resolve(standaloneRoot),'.local','theo-runtime','.direct-workspace-owner-lock');
 mkdirSync(lock,{mode:0o700});
 try{
  assertIdle?.();const latest=loadRaw(standaloneRoot);
  if(Object.hasOwn(latest.registry.workspaces,plan.id))throw Error('DIRECT_WORKSPACE_ALREADY_REGISTERED');
  const again=checkedSource({standaloneRoot,sourcePath:plan.source,id:plan.id});if(again.fingerprint!==plan.fingerprint)throw Error('DIRECT_WORKSPACE_FINGERPRINT_CHANGED');
  if(Object.values(latest.registry.workspaces).some(entry=>entry?.path===again.source))throw Error('DIRECT_WORKSPACE_ALIAS_ALREADY_REGISTERED');
  writeAtomic(config,{schema:1,workspaces:{...latest.registry.workspaces,[plan.id]:{path:again.source,fingerprint:again.fingerprint}}});
 }finally{rmdirSync(lock);}
 return {id:plan.id,registered:true,sourceChanged:false};
}
export const publicDirectWorkspaceIds=({standaloneRoot})=>loadDirectWorkspaceRegistry({standaloneRoot}).ids;
