import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {CandidateWriteCoordinator} from '../src/candidate-write-coordinator.mjs';
import {CodexCandidateWriteAdapter} from '../src/codex-write-adapter.mjs';
import {snapshotManifest} from '../src/write-candidates.mjs';
import {writeNativeApprovalScript} from '../src/write-owner-approval.mjs';
import {spawnSync} from 'node:child_process';
const fake=resolve('test/fake-write-app-server.mjs');

function makeDemo(){
 const root=mkdtempSync('/private/tmp/theo-write-coordinator-');
 const local=join(root,'.local'),runtime=join(local,'theo-runtime'),
  parent=join(runtime,'projects'),source=join(parent,'owner-fixture');
 for(const d of [local,runtime,parent,source,join(source,'extension')])
  mkdirSync(d,{mode:0o700});
 const ownerText='export const LABEL = "BEFORE";\n';
 writeFileSync(join(source,'extension','popup.js'),ownerText,{mode:0o600});
 writeFileSync(join(source,'extension','watch.js'),'export const KEEP = 7;\n',{mode:0o600});
 writeFileSync(join(source,'README.md'),'An isolated owner-fixture snapshot.\n',{mode:0o600});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:{'owner-fixture':source}}),
  {mode:0o600});
 const instruction='Change the LABEL value in extension/popup.js to AFTER; do not touch other files.';
 const args=(id='theo-write-0001')=>({
  id,projectId:'owner-fixture',instruction,allowedFiles:['extension/popup.js']
 });
 const create=(mode='allowed',approval=async()=>true)=>new CandidateWriteCoordinator({
  root,enabled:true,approval,maxDurationMs:1000,
  adapterFactory:({projectRoot,allowedFiles})=>new CodexCandidateWriteAdapter(process.execPath,
   projectRoot,{allowedFiles,args:[fake,mode],rpcTimeoutMs:650})
 });
 const oldDigest=()=>snapshotManifest(source).hash;
 return {root,source,runtime,args,create,oldDigest,ownerText,
  cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
async function wait(coordinator,id,ms=2500){
 const until=Date.now()+ms;
 while(Date.now()<until){
  const s=coordinator.status(id);
  if(['COMPLETED','DENIED','EXPIRED','UNKNOWN','REJECTED'].includes(s.state))return s;
  await pause(18);
 }
 throw Error('WRITE_TEST_TIMEOUT');
}
test('synthetic Owner approval burns one grant before a candidate-only change',async()=>{
 const x=makeDemo();const coordinator=x.create();let approvalCalls=0;
 // No real macOS dialog occurs; approval callback is the isolated synthetic fixture.
 coordinator.approval=async ctx=>{
  approvalCalls++;
  assert.equal(ctx.projectId,'owner-fixture');
  assert.deepEqual(ctx.allowedFiles,['extension/popup.js']);
  return true;
 };
 try{
  const sourceDigest=x.oldDigest();
  const started=coordinator.request(x.args());
  assert.equal(started.created,true);
  assert.equal(started.ownerApprovalRequired,true);
  assert.equal(started.writeToOriginal,false);
  const done=await wait(coordinator,started.id);
  assert.equal(done.state,'COMPLETED');
  assert.equal(done.grantConsumed,true);
  assert.equal(approvalCalls,1);
  const result=coordinator.result(started.id);
  assert.equal(result.candidate.candidateVerified,true);
  assert.equal(result.candidate.artifactsApplied,undefined);
  assert.equal(result.artifactsApplied,false);
  assert.deepEqual(result.candidate.changedFiles,['extension/popup.js']);
  assert.equal(x.oldDigest(),sourceDigest);
  assert.equal(readFileSync(join(x.source,'extension','popup.js'),'utf8'),x.ownerText);
  const candidate=join(x.runtime,'write-candidates',started.id);
  assert.equal(readFileSync(join(candidate,'extension','popup.js'),'utf8'),
   'export const LABEL = "AFTER";\n');
  assert.equal(coordinator.request(x.args()).created,false);
  assert.equal(approvalCalls,1);
  const ledger=coordinator.grants;
  const consumed=ledger.get(started.id);
  assert.equal(consumed.grant_hash,null);
  assert.ok(consumed.consumed_ms!==null);
  assert.ok(coordinator.events(started.id).some(e=>e.kind==='RUNNING'));
  assert.ok(coordinator.events(started.id).some(e=>e.kind==='COMPLETED'));
 }finally{await coordinator.close();x.cleanup();}
});
test('synthetic denial does not execute Codex and does not create candidate',async()=>{
 const x=makeDemo(),coordinator=x.create('allowed',async()=>false);
 try{
  const before=x.oldDigest();
  const req=coordinator.request(x.args('theo-write-deny-1'));
  const final=await wait(coordinator,req.id);
  assert.equal(final.state,'DENIED');
  assert.equal(final.grantConsumed,false);
  assert.equal(coordinator.result(req.id).candidate,null);
  assert.equal(x.oldDigest(),before);
  assert.equal(existsSync(join(x.runtime,'write-candidates')),false);
 }finally{await coordinator.close();x.cleanup();}
});
test('synthetic unauthorized change rejected; private stage discarded',async()=>{
 const x=makeDemo(),coordinator=x.create('foreign-file');
 try{
  const sourceDigest=x.oldDigest();
  const req=coordinator.request(x.args('theo-write-foreign'));
  const terminal=await wait(coordinator,req.id);
  assert.equal(terminal.state,'REJECTED');
  assert.equal(terminal.grantConsumed,true);
  assert.equal(coordinator.result(req.id).artifactsApplied,false);
  assert.equal(existsSync(join(x.runtime,'write-candidates',req.id)),false);
  assert.equal(x.oldDigest(),sourceDigest);
 }finally{await coordinator.close();x.cleanup();}
});
test('fake policy escalation and fake approval request fail closed',async()=>{
 for(const mode of ['bad-policy','approval-request','missing-terminal']){
  const x=makeDemo(),coordinator=x.create(mode);
  try{
   const before=x.oldDigest();
   const req=coordinator.request(x.args('theo-write-'+mode.replace(/[^A-Za-z0-9_-]/g,'-')));
   const result=await wait(coordinator,req.id,2200);
   assert.equal(result.state,'UNKNOWN',mode);
   assert.equal(result.grantConsumed,true);
   assert.equal(x.oldDigest(),before);
   assert.equal(existsSync(join(x.runtime,'write-candidates',req.id)),false);
  }finally{await coordinator.close();x.cleanup();}
 }
});
test('single pending write, no unregistered projects and no arbitrary project roots',async()=>{
 const x=makeDemo();
 let release;
 const blocking=new Promise(resolve=>{release=resolve;});
 const coordinator=x.create('allowed',async()=>blocking);
 try{
  const first=coordinator.request(x.args());
  assert.equal(first.state,'APPROVAL_PENDING');
  assert.throws(()=>coordinator.request(x.args('theo-write-0002')),/WRITE_REQUEST_BUSY/);
  assert.throws(()=>coordinator.request({...x.args('theo-write-0003'),projectId:'chappy-signal'}),
   /WRITE_FORBIDDEN_NATIVE_PROJECT/);
  assert.throws(()=>coordinator.request({...x.args('theo-write-0003b'),projectId:'theo-lab'}),
   /WRITE_NATIVE_PROJECT_REFUSED/);
  assert.throws(()=>coordinator.request({...x.args('theo-write-0004'),allowedFiles:['../bad.js']}),
   /WRITE_PATH_INVALID/);
  release(false);
  assert.equal((await wait(coordinator,first.id)).state,'DENIED');
 }finally{release(false);await coordinator.close();x.cleanup();}
});
test('a local release revocation after Owner approval prevents staging and burns no grant',async()=>{
 const x=makeDemo();let allow=true;let release;
 const approval=new Promise(resolve=>{release=resolve;});
 const coordinator=new CandidateWriteCoordinator({
  root:x.root,enabled:true,approval:async()=>approval,maxDurationMs:1000,
  reauthorize:()=>{
   if(!allow)throw Error('WRITE_RELEASE_NOT_AUTHORIZED');
   return {enabled:true,projectIds:['owner-fixture'],maxFiles:1};
  },
  adapterFactory:()=>{throw Error('ADAPTER_MUST_NOT_START');}
 });
 try{
  const before=x.oldDigest();
  const request=coordinator.request(x.args('theo-write-revoked'));
  allow=false;
  release(true);
  const status=await wait(coordinator,request.id);
  assert.equal(status.state,'DENIED');
  assert.equal(status.grantConsumed,false);
  assert.equal(coordinator.result(request.id).candidate,null);
  assert.equal(x.oldDigest(),before);
  assert.equal(existsSync(join(x.runtime,'write-candidates')),false);
  assert.equal(coordinator.events(request.id).at(-1)?.text,'WRITE_RELEASE_NOT_AUTHORIZED');
 }finally{release?.(false);await coordinator.close();x.cleanup();}
});
test('native consent AppleScript compiled; No native dialog in automated tests',()=>{
 const script=writeNativeApprovalScript({
  id:'theo-owner-0001',projectId:'chappy-signal',
  instruction:'Change only the test popup label for an isolated trial.',
  allowedFiles:['extension/popup.js'],
  planHash:'f'.repeat(64)
 });
 assert.match(script,/コード変更を１回だけ許可しますか/);
 assert.match(script,/default button "拒否する"/);
 assert.match(script,/giving up after 90/);
 assert.match(script,/元のChappy Signal/);
 assert.match(script,/extension\/popup.js/);
 assert.doesNotMatch(script,/do shell script/);
 if(process.platform==='darwin'){
  const dir=mkdtempSync('/private/tmp/theo-write-dialog-');
  try{
   const p=join(dir,'compile.scpt');
   const r=spawnSync('/usr/bin/osacompile',['-o',p,'-e',script],
    {encoding:'utf8',timeout:7000,stdio:['ignore','pipe','pipe']});
   assert.equal(r.status,0,String(r.stderr).slice(0,300));
  }finally{rmSync(dir,{recursive:true,force:true});}
 }
});

test('native UI failure is classified separately from user denial and no grant is issued',async()=>{
 const x=makeDemo(),coordinator=x.create('allowed',async()=>({approved:false,reason:'SCRIPT_ERROR'}));
 try{
  const task=coordinator.request(x.args('theo-write-script-error'));
  const finish=await wait(coordinator,task.id);
  assert.equal(finish.state,'DENIED');
  assert.equal(finish.grantConsumed,false);
  const history=coordinator.events(task.id);
  assert.equal(history.at(-1)?.kind,'DENIED');
  assert.equal(history.at(-1)?.text,'SCRIPT_ERROR');
  assert.equal(existsSync(join(x.runtime,'write-candidates')),false);
 }finally{await coordinator.close();x.cleanup();}
});
