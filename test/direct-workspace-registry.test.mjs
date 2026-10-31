import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {planDirectWorkspace,registerDirectWorkspace,loadDirectWorkspaceRegistry,publicDirectWorkspaceIds,directRegistryPath} from '../src/direct-workspace-registry.mjs';
import {createOwnerApprovedDirectCoordinator} from '../src/direct-native-factory.mjs';

function fixture(){
 const base=mkdtempSync('/private/tmp/theo-real-workspace-');chmodSync(base,0o700);
 const root=join(base,'standalone'),runtime=join(root,'.local','theo-runtime'),source=join(base,'real-source');
 mkdirSync(runtime,{recursive:true,mode:0o700});mkdirSync(source,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:{snapshot:'/not-the-real-source'}}),{mode:0o600});
 return {base,root,runtime,source};
}
function register(t,id='real-project'){
 const plan=planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id});
 return registerDirectWorkspace({standaloneRoot:t.root,plan,confirm:plan.confirmation,approveOwner:()=>true,assertIdle:()=>{}});
}
test('real workspace registration is separate, private, and does not modify source or snapshots',()=>{
 const t=fixture();try{
  const before=readFileSync(join(t.runtime,'projects.json'),'utf8');assert.deepEqual(register(t),{id:'real-project',registered:true,sourceChanged:false});
  assert.equal(readFileSync(join(t.runtime,'projects.json'),'utf8'),before);
  assert.deepEqual(publicDirectWorkspaceIds({standaloneRoot:t.root}),['real-project']);
  assert.deepEqual(loadDirectWorkspaceRegistry({standaloneRoot:t.root}).workspaces,{['real-project']:t.source});
  assert.match(readFileSync(directRegistryPath(t.root),'utf8'),/real-source/);
 }finally{rmSync(t.base,{recursive:true,force:true});}
});
test('registration denies tampering, aliases, broad roots, reserved projects, active work, and Owner refusal',()=>{
 const t=fixture();try{
  const plan=planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id:'real-project'});
  assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan,confirm:'bad',approveOwner:()=>true}),/DIRECT_OWNER_CONFIRMATION_REQUIRED/);
  assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan,confirm:plan.confirmation,approveOwner:()=>false}),/DIRECT_OWNER_APPROVAL_DENIED/);
  assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan,confirm:plan.confirmation,approveOwner:()=>true,assertIdle:()=>{throw Error('ACTIVE_JOBS_BLOCK_DIRECT_REGISTRATION');}}),/ACTIVE_JOBS_BLOCK_DIRECT_REGISTRATION/);
  assert.throws(()=>planDirectWorkspace({standaloneRoot:t.root,sourcePath:'/private/tmp',id:'root-denied'}),/DIRECT_WORKSPACE_ROOT_DENIED/);
  assert.throws(()=>planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id:'chappy-signal'}),/DIRECT_WORKSPACE_ID_DENIED/);
  const link=join(t.base,'linked');symlinkSync(t.source,link);assert.throws(()=>planDirectWorkspace({standaloneRoot:t.root,sourcePath:link,id:'alias-denied'}),/DIRECT_WORKSPACE_ALIAS_DENIED/);
  const changed={...plan,fingerprint:'0'.repeat(64)};assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan:changed,confirm:plan.confirmation,approveOwner:()=>true}),/DIRECT_OWNER_CONFIRMATION_REQUIRED/);
  register(t);const duplicate=planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id:'second-project'});assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan:duplicate,confirm:duplicate.confirmation,approveOwner:()=>true}),/DIRECT_WORKSPACE_ALIAS_ALREADY_REGISTERED/);
 }finally{rmSync(t.base,{recursive:true,force:true});}
});
test('explicit native factory loads the independent real registry, never projects snapshots',()=>{
 const t=fixture();try{
  register(t);const direct=createOwnerApprovedDirectCoordinator({root:t.root,journalPath:join(t.runtime,'direct.sqlite'),codexExecutable:'/usr/bin/false',ownerApproval:()=>false});
  assert.deepEqual([...direct.workspaces],[['real-project',t.source]]);direct.close();
 }finally{rmSync(t.base,{recursive:true,force:true});}
});
test('native factory confines fake write execution to its separately approved real root',async()=>{
 const t=fixture();try{
  register(t);const direct=createOwnerApprovedDirectCoordinator({root:t.root,journalPath:join(t.runtime,'direct.sqlite'),ownerApproval:()=>true,
   adapterFactory:({projectRoot})=>({async execute({onEvent}){writeFileSync(join(projectRoot,'approved.txt'),'only here\n');onEvent({kind:'terminal',status:'completed',output:'synthetic'});},async disconnect(){}})});
  const started=direct.start({task_id:'factory-write-0001',iteration:1,instruction:'synthetic approved write',workspace_id:'real-project',execution_mode:'workspace_write'});
  for(let i=0;i<30&&direct.wait({task_id:started.task_id,run_id:started.run_id}).state!=='COMPLETED';i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(readFileSync(join(t.source,'approved.txt'),'utf8'),'only here\n');assert.equal(existsSync(join(t.runtime,'approved.txt')),false);direct.close();
 }finally{rmSync(t.base,{recursive:true,force:true});}
});

test('native factory forwards approval AbortSignal and never starts Codex after close',async()=>{
 const t=fixture();let signal,executed=0;
 try{
  register(t);const direct=createOwnerApprovedDirectCoordinator({root:t.root,journalPath:join(t.runtime,'direct.sqlite'),
   ownerApproval:(_context,options)=>new Promise(resolve=>{
    signal=options?.signal;
    signal?.addEventListener('abort',()=>resolve(false),{once:true});
   }),
   adapterFactory:()=>({async execute(){executed++;},async disconnect(){}})
  });
  const started=direct.start({task_id:'factory-close-0001',iteration:1,instruction:'synthetic pending approval',workspace_id:'real-project',execution_mode:'workspace_write'});
  assert.equal(started.state,'APPROVAL_PENDING');assert.ok(signal instanceof AbortSignal);
  direct.close();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(signal.aborted,true);assert.equal(executed,0);
  const recovered=createOwnerApprovedDirectCoordinator({root:t.root,journalPath:join(t.runtime,'direct.sqlite'),codexExecutable:'/usr/bin/false',ownerApproval:()=>false});
  try{assert.equal(recovered.wait({task_id:started.task_id,run_id:started.run_id}).state,'UNKNOWN');}
  finally{recovered.close();}
 }finally{rmSync(t.base,{recursive:true,force:true});}
});

test('expired or future-dated plans and oversized registry are rejected',()=>{
 const t=fixture();
 try{
  const future=Date.now()+30_000;
  assert.throws(()=>planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id:'future-plan',createdAt:future}),/DIRECT_PLAN_INVALID/);
  const plan=planDirectWorkspace({standaloneRoot:t.root,sourcePath:t.source,id:'old-plan'});
  const bad={...plan,createdAt:plan.createdAt+3600000,expiresAt:plan.expiresAt+3600000};
  assert.throws(()=>registerDirectWorkspace({standaloneRoot:t.root,plan:bad,confirm:'bad',approveOwner:()=>true}),/DIRECT_PLAN_EXPIRED/);
  writeFileSync(directRegistryPath(t.root),' '.repeat(8193),{mode:0o600});
  assert.throws(()=>loadDirectWorkspaceRegistry({standaloneRoot:t.root}),/DIRECT_REGISTRY_TOO_LARGE/);
 }finally{rmSync(t.base,{recursive:true,force:true});}
});
