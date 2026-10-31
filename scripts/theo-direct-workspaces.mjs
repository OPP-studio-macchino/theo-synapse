// Owner-only registration of canonical real source directories. Never MCP.
import {spawnSync} from 'node:child_process';
import {existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {planDirectWorkspace,registerDirectWorkspace,publicDirectWorkspaceIds,directRegistryPath} from '../src/direct-workspace-registry.mjs';
import {requestDirectRegistrationApproval} from '../src/direct-owner-approval.mjs';

const root=realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const [command,id,path,confirmation,createdAt]=process.argv.slice(2);
const choose=()=>{
 if(process.platform!=='darwin')throw Error('MACOS_ONLY');
 const r=spawnSync('/usr/bin/osascript',['-e','try\nset p to choose folder with prompt "Theo Synapse: choose the real source folder for one-time direct work"\nreturn POSIX path of p\non error\nreturn ""\nend try'],{encoding:'utf8',timeout:60000,maxBuffer:8192,stdio:['ignore','pipe','ignore']});
 if(r.status!==0||!r.stdout.trim())throw Error('FOLDER_SELECTION_CANCELLED');return r.stdout.trim().replace(/\/$/,'');
};
const assertIdle=()=>{
 const runtime=join(root,'.local','theo-runtime');
 for(const [file,table,states] of [[join(runtime,'tasks.sqlite'),'standalone_tasks',"'QUEUED','RUNNING','STOP_REQUESTED'"],[join(runtime,'direct.sqlite'),'direct_runs',"'APPROVAL_PENDING','QUEUED','RUNNING'"],[join(runtime,'writes.sqlite'),'theo_write_requests',"'APPROVAL_PENDING','AUTHORIZED','RUNNING'"]]){
  if(!existsSync(file))continue;const db=new DatabaseSync(file,{readOnly:true});try{if(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE state IN (${states})`).get().n)throw Error('ACTIVE_JOBS_BLOCK_DIRECT_REGISTRATION');}finally{db.close();}
 }
};
try{
 if(command==='list')console.log(JSON.stringify({projects:publicDirectWorkspaceIds({standaloneRoot:root}),note:'IDs only; real paths are never exposed to MCP.'},null,2));
 else if(command==='plan'||command==='choose'){
  const plan=planDirectWorkspace({standaloneRoot:root,id,sourcePath:command==='choose'?choose():path});
  console.log(JSON.stringify({operation:'OWNER_DIRECT_WORKSPACE_REVIEW',...plan,sourceChanged:false},null,2));
 }else if(command==='register'){
  if(!id||!path||!confirmation)throw Error('DIRECT_REGISTRATION_ARGUMENTS_REQUIRED');
  const plan=planDirectWorkspace({standaloneRoot:root,id,sourcePath:path,createdAt:Number(createdAt)});
  // The confirmation binds the fresh, local plan; it is deliberately not a remote input API.
  if(confirmation!==plan.confirmation)throw Error('DIRECT_OWNER_CONFIRMATION_REQUIRED');
  console.log(JSON.stringify(registerDirectWorkspace({standaloneRoot:root,plan,confirm:confirmation,approveOwner:requestDirectRegistrationApproval,assertIdle}),null,2));
 }else console.log('Theo Synapse owner-only direct workspace commands:\n  node scripts/theo-direct-workspaces.mjs list\n  node scripts/theo-direct-workspaces.mjs choose PROJECT_ID\n  node scripts/theo-direct-workspaces.mjs plan PROJECT_ID /absolute/source\n  node scripts/theo-direct-workspaces.mjs register PROJECT_ID /absolute/source FINGERPRINT CREATED_AT');
}catch(e){console.error('THEO_DIRECT_WORKSPACE_ERROR',/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)?e.message:'DIRECT_WORKSPACE_OPERATION_FAILED');process.exitCode=1;}
