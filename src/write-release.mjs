// Explicit Owner-local release gate for ChatGPT-triggered candidate-only edits.
// No request from MCP may set or override this policy. Fail closed.
import {lstatSync,realpathSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';

export const WRITE_RELEASE_CONFIG='write-release.json';
const validIds=ids=>Array.isArray(ids)&&ids.length>=1&&ids.length<=6&&
 ids.every(x=>typeof x==='string'&&/^[A-Za-z][A-Za-z0-9_-]{2,63}$/.test(x)&&x!=='theo-lab')&&
 new Set(ids).size===ids.length;

export function readWriteRelease(root,{required=false}={}){
 const reg=loadReadOnlyRegistry(root);
 const path=join(reg.runtime,WRITE_RELEASE_CONFIG);
 if(!existsSync(path)){
  if(required)throw Error('WRITE_RELEASE_NOT_CONFIGURED');
  return {enabled:false,candidateOnly:true,projectIds:[],maxFiles:0,version:1};
 }
 const meta=lstatSync(path);
 if(!meta.isFile()||meta.isSymbolicLink()||meta.nlink!==1||
   meta.uid!==process.getuid()||(meta.mode&0o077)!==0||meta.size>2048)
  throw Error('WRITE_RELEASE_CONFIG_UNSAFE');
 if(realpathSync.native(path)!==path)throw Error('WRITE_RELEASE_CONFIG_ALIAS');
 let config;
 try{config=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('WRITE_RELEASE_CONFIG_INVALID');}
 if(!config||typeof config!=='object'||Array.isArray(config)||
   Object.keys(config).sort().join(',')!=='candidateOnly,enabled,maxFiles,projectIds,schema,sourceWriteEnabled'||
   config.schema!==1||typeof config.enabled!=='boolean'||
   config.candidateOnly!==true||config.sourceWriteEnabled!==false||
   !validIds(config.projectIds)||config.maxFiles!==1)
  throw Error('WRITE_RELEASE_CONFIG_INVALID');
 for(const project of config.projectIds)
  if(!Object.hasOwn(reg.projects,project))throw Error('WRITE_RELEASE_PROJECT_NOT_REGISTERED');
 return Object.freeze({...config,projectIds:Object.freeze([...config.projectIds]),version:1});
}
export function assertHostWriteGate(root,policy){
 const expected=readWriteRelease(root,{required:true});
 if(!expected.enabled||!policy||policy.enabled!==true||
    policy.candidateOnly!==true||policy.sourceWriteEnabled!==false||
    policy.maxFiles!==expected.maxFiles||
    JSON.stringify(policy.projectIds)!==JSON.stringify(expected.projectIds))
  throw Error('WRITE_RELEASE_NOT_AUTHORIZED');
 return expected;
}
