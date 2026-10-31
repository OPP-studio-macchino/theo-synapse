// Read-only deployment preflight for Theo Synapse.
// Never starts Codex, changes a plugin, or grants write permission.
import {
 lstatSync,realpathSync,existsSync,readFileSync,readdirSync
} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,relative} from 'node:path';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';
import {readWriteRelease} from './write-release.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const checkMode=(path,{file=false}={})=>{
 const s=lstatSync(path);
 return s.uid===process.getuid()&&(s.mode&0o077)===0&&!s.isSymbolicLink()&&
  (file?s.isFile()&&s.nlink===1:s.isDirectory());
};
const record=(checks,name,fn)=>{
 try{
  const data=fn();
  const pass=typeof data==='boolean'?data:data?.pass===true;
  checks.push({name,status:pass?'PASS':'FAIL',detail:pass?'verified':String(data?.code??'FAILED')});
 }catch(e){
  const code=/^[A-Z_]{3,90}$/.test(e?.message??'')?e.message:'CHECK_ERROR';
  checks.push({name,status:'FAIL',detail:code});
 }
};
export function inspectReleaseReadiness({
 root,sourceProject=null,expectedProjectIds=null,expectedFileCount=null,
 checkOriginalHashes=false
}={}){
 if(typeof root!=='string'||!root.startsWith('/'))throw Error('RELEASE_ROOT_INVALID');
 const full=resolve(root);
 const checks=[];
 let reg=null;
 let releaseEnabled=null;
 record(checks,'canonical_private_standalone',()=>{
  if(realpathSync.native(full)!==full)throw Error('ROOT_NOT_CANONICAL');
  return {pass:checkMode(full),code:'ROOT_PERMISSIONS'};
 });
 record(checks,'registered_project_allowlist',()=>{
  reg=loadReadOnlyRegistry(full);
  const ids=Object.keys(reg.projects).sort();
  if(expectedProjectIds&&JSON.stringify(ids)!==JSON.stringify([...expectedProjectIds].sort()))
   throw Error('PROJECT_REGISTRY_MISMATCH');
  return ids.length>=1;
 });
 record(checks,'private_runtime_credentials',()=>{
  const local=join(full,'.local'),runtime=join(local,'theo-runtime');
  if(!checkMode(local)||!checkMode(runtime))throw Error('RUNTIME_PERMISSIONS');
  const secretDir=join(local,'secrets');
  if(existsSync(secretDir)){
   if(!checkMode(secretDir))throw Error('SECRETS_DIR_PERMISSIONS');
   for(const item of readdirSync(secretDir)){
    const path=join(secretDir,item);
    if(!checkMode(path,{file:true}))throw Error('SECRET_FILE_PERMISSIONS');
   }
  }
  return true;
 });
 record(checks,'live_write_release_not_enabled',()=>{
  const value=readWriteRelease(full);
  releaseEnabled=value.enabled;
  return {pass:value.enabled===false,code:'WRITE_RELEASE_ENABLED'};
 });
 record(checks,'no_live_write_journal_or_promotion',()=>{
  if(!reg)throw Error('PROJECT_REGISTRY_UNAVAILABLE');
  return {
   pass:!existsSync(join(reg.runtime,'writes.sqlite'))&&
        !existsSync(join(reg.runtime,'promotions.sqlite')),
   code:'LIVE_WRITE_JOURNAL_PRESENT'
  };
 });
 record(checks,'mcp_entrypoint_not_write_enabled',()=>{
  const entry=readFileSync(join(full,'scripts','theo-task-entry.mjs'),'utf8');
  return {
   pass:entry.includes('remoteCoordinator:client')&&
    !entry.includes('writeCoordinator:')&&
    !entry.includes('enableCandidateWrites:')&&
    !entry.includes('workspace-write'),
   code:'MCP_ENTRYPOINT_CHANGED'
  };
 });
 record(checks,'daemon_entrypoint_not_write_enabled',()=>{
  const entry=readFileSync(join(full,'scripts','task-daemon-entry.mjs'),'utf8');
  return {pass:entry.includes('startTaskDaemon({root,maxDurationMs:60000})')&&
    !entry.includes('enableCandidateWrites:')&&
    !entry.includes('writePolicy:'),
   code:'HOST_ENTRYPOINT_CHANGED'};
 });
 record(checks,'no_unapproved_mcp_write_tool_registration',()=>{
  // The MCP tools exist in source as an opt-in path, but the default entrypoint
  // MUST NOT inject writeCoordinator. This is a structural source check.
  const mcp=readFileSync(join(full,'src','mcp.mjs'),'utf8');
  return {pass:mcp.includes('if(writeCoordinator){')&&
    mcp.includes('standalone_write_request'),
   code:'MCP_WRITE_GUARD_MISSING'};
 });
 record(checks,'snapshot_files_private_and_non_symlink',()=>{
  if(!reg)throw Error('PROJECT_REGISTRY_UNAVAILABLE');
  let count=0;
  for(const dir of Object.values(reg.projects)){
   if(!checkMode(dir))throw Error('SNAPSHOT_DIR_UNSAFE');
   const stack=[dir];
   while(stack.length){
    const d=stack.pop();
    for(const entry of readdirSync(d,{withFileTypes:true})){
     const p=join(d,entry.name);
     if(entry.isSymbolicLink())throw Error('SNAPSHOT_SYMLINK');
     if(entry.isDirectory()){
      if(!checkMode(p))throw Error('SNAPSHOT_DIR_UNSAFE');
      stack.push(p);
     }else if(entry.isFile()){
      if(!checkMode(p,{file:true}))throw Error('SNAPSHOT_FILE_UNSAFE');
      count++;
     }else throw Error('SNAPSHOT_SPECIAL_FILE');
     if(count>3000)throw Error('SNAPSHOT_FILE_LIMIT');
    }
   }
  }
  return count>0;
 });
 if(checkOriginalHashes){
  record(checks,'chappy_original_vs_registered_snapshot',()=>{
   if(!reg?.projects['chappy-signal']||typeof sourceProject!=='string'||
      !sourceProject.startsWith('/'))throw Error('ORIGINAL_CHECK_INPUT_INVALID');
   const copy=reg.projects['chappy-signal'];
   const files=[],stack=[copy];
   while(stack.length){
    const d=stack.pop();
    for(const entry of readdirSync(d,{withFileTypes:true})){
     const path=join(d,entry.name);
     if(entry.isDirectory())stack.push(path);
     else if(entry.isFile())files.push(path);
     else throw Error('SNAPSHOT_SPECIAL_FILE');
    }
   }
   if(expectedFileCount!==null&&files.length!==expectedFileCount)
    throw Error('SNAPSHOT_FILE_COUNT_MISMATCH');
   for(const file of files){
    const rel=relative(copy,file),original=join(sourceProject,rel);
    if(!existsSync(original)||hash(readFileSync(original))!==hash(readFileSync(file)))
     throw Error('ORIGINAL_SNAPSHOT_HASH_MISMATCH');
   }
   return files.length>0;
  });
 }
 const fail=checks.filter(x=>x.status!=='PASS');
 return {
  product:'Theo Synapse',mode:'read-only',
  inspectedAt:new Date().toISOString(),
  verdict:fail.length?'FAIL':'PASS_READONLY_ONLY',
  testOrGrantStarted:false,writeFeatureEnabled:releaseEnabled,
  checked:checks.length,passed:checks.length-fail.length,failed:fail.length,checks,
  releaseBlockers:[
   'NORMAL_CHATGPT_WRITE_TOOL_NOT_RELEASED',
   'REAL_REPOSITORY_PROMOTION_NOT_AUTHORIZED',
   'GENERAL_USER_INSTALLER_NOT_ACCEPTED'
  ]
 };
}
