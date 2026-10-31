// Owner-local, explicit project import CLI. No MCP exposure; no background writes.
import {spawnSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {planReadOnlySnapshot,importReadOnlySnapshot} from '../src/project-snapshots.mjs';
import {requestNativeOwnerApproval} from '../src/owner-approval.mjs';
import {assertNativeProjectAllowed} from '../src/native-core.mjs';

const root=realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const [command,id,path,fingerprint]=process.argv.slice(2);
const planJSON=p=>({
 operation:'OWNER_PROJECT_REVIEW',id:p.id,source:p.source,displayName:basename(p.source),
 eligibleFiles:p.files.length,totalBytes:p.totalBytes,excluded:p.excluded,
 digest:p.digest,fingerprint:p.digest.slice(0,20),sourceChanged:false,
 files:p.files.map(f=>({path:f.relative,bytes:f.bytes}))
});
const assertIdle=()=>{
 const registry=loadReadOnlyRegistry(root);
 if(existsSync(registry.journalPath)){
  const db=new DatabaseSync(registry.journalPath,{readOnly:true});
  try{
   const row=db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").get();
   if(row.n!==0)throw Error('ACTIVE_JOBS_BLOCK_IMPORT');
  }finally{db.close();}
 }
 const directFile=join(registry.runtime,'direct.sqlite');
 if(!existsSync(directFile))return;
 const direct=new DatabaseSync(directFile,{readOnly:true});
 try{
  const row=direct.prepare("SELECT COUNT(*) AS n FROM direct_runs WHERE state IN ('QUEUED','RUNNING')").get();
  if(row.n!==0)throw Error('ACTIVE_JOBS_BLOCK_IMPORT');
 }finally{direct.close();}
};
const choose=()=>{
 if(process.platform!=='darwin')throw Error('MACOS_ONLY');
 const result=spawnSync('/usr/bin/osascript',['-e',
  'try\nset p to choose folder with prompt "Theo Synapse: Choose a source project to REVIEW (not import)"\nreturn POSIX path of p\non error\nreturn ""\nend try'],{
  encoding:'utf8',timeout:60000,maxBuffer:8192,stdio:['ignore','pipe','ignore']
 });
 if(result.status!==0||!result.stdout.trim())throw Error('FOLDER_SELECTION_CANCELLED');
 return result.stdout.trim().replace(/\/$/,'');
};
try{
 if(command==='list'){
  const registry=loadReadOnlyRegistry(root);
  console.log(JSON.stringify({
   projects:Object.keys(registry.projects).map(id=>({id,snapshot:id!=='theo-lab'})),
   note:'ChatGPT can see only registered project IDs, not source paths.'
  },null,2));
}else if(command==='plan'||command==='choose'){
  if(!id)throw Error('PROJECT_ID_REQUIRED');
  assertNativeProjectAllowed(root,id);
  if(Object.hasOwn(loadReadOnlyRegistry(root).projects,id))throw Error('PROJECT_ID_ALREADY_REGISTERED');
  const source=command==='choose'?choose():path;
  if(!source)throw Error('PROJECT_PATH_REQUIRED');
  console.log(JSON.stringify(planJSON(planReadOnlySnapshot({standaloneRoot:root,sourcePath:source,id})),null,2));
}else if(command==='import'){
  if(!id||!path||!fingerprint)throw Error('PROJECT_PATH_OR_CONFIRMATION_REQUIRED');
  assertNativeProjectAllowed(root,id);
  const result=importReadOnlySnapshot({
   standaloneRoot:root,sourcePath:path,id,confirm:fingerprint,
   approveOwner:requestNativeOwnerApproval,assertIdle
  });
  console.log(JSON.stringify({...result,operation:'OWNER_PROJECT_IMPORTED'},null,2));
 }else{
  console.log('Theo Synapse OWNER-ONLY project commands (never callable from ChatGPT MCP):');
  console.log('  node scripts/theo-projects.mjs list');
  console.log('  node scripts/theo-projects.mjs choose PROJECT_ID');
  console.log('  node scripts/theo-projects.mjs plan PROJECT_ID /absolute/path/to/source');
  console.log('  node scripts/theo-projects.mjs import PROJECT_ID /absolute/path/to/source FINGERPRINT');
 }
}catch(e){
 const error=/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)?e.message:'OWNER_PROJECT_OPERATION_FAILED';
 console.error('THEO_PROJECTS_ERROR',error);
 process.exitCode=1;
}
