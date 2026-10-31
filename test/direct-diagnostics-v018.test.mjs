import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CodexAppServer} from '../src/codex-adapter.mjs';
import {DirectCoordinator} from '../src/direct-coordinator.mjs';

function testFixture(){
 const base=mkdtempSync('/private/tmp/theo-direct-diagnosis-v018-');
 chmodSync(base,0o700);
 const dir=join(base,'workspace');
 mkdirSync(dir,{mode:0o700});
 return {base,dir,journal:join(base,'direct.sqlite')};
}
async function resultOf(c,taskId){
 for(let i=0;i<70;i++){
  const x=c.wait({task_id:taskId,run_id:taskId+':1'});
  if(!['QUEUED','RUNNING','APPROVAL_PENDING'].includes(x.state))return x;
  await new Promise(r=>setTimeout(r,10));
 }
 throw Error('SYNTHETIC_TEST_DID_NOT_SETTLE');
}

test('Codex App Server only reveals fixed stage labels, never remote RPC errors',async()=>{
 for(const [method,expected] of [
  ['initialize','CODEX_RPC_INITIALIZE_REJECTED'],
  ['thread/start','CODEX_RPC_THREAD_START_REJECTED'],
  ['turn/start','CODEX_RPC_TURN_START_REJECTED'],
 ]){
  const f=testFixture();
  try{
   const adapter=new CodexAppServer('/usr/bin/false',f.dir);
   let payload='';
   adapter.child={stdin:{writable:true,write:x=>{payload+=x;}},kill:()=>{}};
   const promise=adapter.rpc(method,{},2000);
   const id=JSON.parse(payload).id;
   const payloadWithSecret=JSON.stringify({id,error:{code:-32001,message:'private-secret-credential file:///private/path'}})+'\n';
   adapter.ingest(payloadWithSecret);
   await assert.rejects(promise,new RegExp('^Error: '+expected+'$'));
   assert.equal(adapter.pending.size,0);
  }finally{rmSync(f.base,{recursive:true,force:true});}
 }
});

test('approved task reports static approval denial rather than generic UNKNOWN without leaking secrets',async()=>{
 const f=testFixture();
 const c=new DirectCoordinator({workspaces:{'theo-acceptance':f.dir},journalPath:f.journal,
  ownerAuthorization:()=>true,
  adapterFactory:()=>({async execute(){throw Error('APPROVAL_REQUEST_DENIED');},async disconnect(){}})
 });
 try{
  const x=c.start({task_id:'diag_v018_approval_001',iteration:1,workspace_id:'theo-acceptance',
   execution_mode:'workspace_write',instruction:'synthetic only'});
  const s=await resultOf(c,x.task_id);
  assert.equal(s.state,'UNKNOWN');
  assert.equal(s.reasonCode,'APPROVAL_REQUEST_DENIED');
  assert.equal(s.providerFinished,false);
  assert.equal(s.result,null);
  assert.doesNotMatch(JSON.stringify(s),/private|secret|credential|file:\/\//);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('interrupted Codex turn is explicit UNKNOWN, not falsely completed',async()=>{
 const f=testFixture();
 const c=new DirectCoordinator({workspaces:{'theo-acceptance':f.dir},journalPath:f.journal,
  adapterFactory:()=>({async execute({onEvent}){onEvent({kind:'terminal',status:'interrupted',output:'should never become result'});},async disconnect(){}})
 });
 try{
  const x=c.start({task_id:'diag_v018_interrupt_01',iteration:1,workspace_id:'theo-acceptance',instruction:'fixture'});
  const s=await resultOf(c,x.task_id);
  assert.equal(s.state,'UNKNOWN');
  assert.equal(s.reasonCode,'CODEX_TURN_INTERRUPTED');
  assert.equal(s.providerFinished,false);
  assert.equal(s.result,null);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('untrusted arbitrary error text still maps to generic safe diagnostic',async()=>{
 const f=testFixture();
 const c=new DirectCoordinator({workspaces:{'theo-acceptance':f.dir},journalPath:f.journal,
  adapterFactory:()=>({async execute(){throw Error('secret actual payload /Users/private credential');},async disconnect(){}})
 });
 try{
  const x=c.start({task_id:'diag_v018_redaction_01',iteration:1,instruction:'fixture'});
  const s=await resultOf(c,x.task_id);
  assert.equal(s.reasonCode,'DIRECT_EXECUTION_UNVERIFIED');
  assert.equal(s.providerFinished,false);
  assert.doesNotMatch(JSON.stringify(s),/secret|credential|\/Users/);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});
