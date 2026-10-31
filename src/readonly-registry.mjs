import {lstatSync,realpathSync,readFileSync} from 'node:fs';
import {resolve,join,sep,dirname} from 'node:path';
import {assertNativeProjectAllowed} from './native-core.mjs';

const privateDirectory=(p)=>{
 const s=lstatSync(p);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||
    realpathSync.native(p)!==p)throw Error('PRIVATE_DIRECTORY_REQUIRED');
};
const privateFile=(p)=>{
 const s=lstatSync(p);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||
   (s.mode&0o077)!==0)throw Error('PRIVATE_REGISTRY_REQUIRED');
};
export function loadReadOnlyRegistry(root){
 const full=resolve(root),local=join(full,'.local'),runtime=join(local,'theo-runtime'),
       allowed=join(runtime,'projects'),config=join(runtime,'projects.json');
 if(realpathSync.native(full)!==full)throw Error('NONCANONICAL_STANDALONE_ROOT');
 for(const p of [local,runtime,allowed])privateDirectory(p);
 privateFile(config);
 const file=readFileSync(config);
 if(file.length>8192)throw Error('REGISTRY_TOO_LARGE');
 let registry;
 try{registry=JSON.parse(file.toString('utf8'));}catch{throw Error('REGISTRY_INVALID_JSON');}
 if(!registry||typeof registry!=='object'||Array.isArray(registry)||
    registry.schema!==1||!registry.projects||typeof registry.projects!=='object'||
    Array.isArray(registry.projects)||Object.keys(registry).sort().join(',')!=='projects,schema')
   throw Error('REGISTRY_INVALID');
 const ids=Object.keys(registry.projects);
 if(ids.length===0||ids.length>12)throw Error('REGISTRY_SIZE_INVALID');
 const projects={};
 for(const id of ids){
  // This applies only to the account-bound installed Core. Legacy standalone
  // roots keep their historical registry independent and readable.
  assertNativeProjectAllowed(full,id);
  const path=registry.projects[id];
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(id)||typeof path!=='string')throw Error('REGISTRY_PROJECT_INVALID');
  if(resolve(path)!==path||!path.startsWith(allowed+sep))throw Error('REGISTRY_OUTSIDE_ALLOWED_BASE');
  // Each allowlisted root must be its own direct child, not an ancestor/alias.
  if(dirname(path)!==allowed)throw Error('REGISTRY_NESTED_PATH_DENIED');
  privateDirectory(path);
  projects[id]=path;
 }
 return {runtime,projects,socketPath:join(local,'theo.sock'),
    journalPath:join(runtime,'tasks.sqlite'),configPath:config};
}
