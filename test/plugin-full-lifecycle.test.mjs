import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CandidateWriteCoordinator} from '../src/candidate-write-coordinator.mjs';
import {CodexCandidateWriteAdapter} from '../src/codex-write-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';
import {snapshotManifest} from '../src/write-candidates.mjs';
import {previewPromotion,applyPromotion,previewRestore,restorePromotion} from '../src/owner-promotion.mjs';

const fake=resolve('test/fake-write-app-server.mjs');
const digest=value=>createHash('sha256').update(value).digest('hex');
const before='export const LABEL = "BEFORE";\n';
const after='export const LABEL = "AFTER";\n';
const file='extension/popup.js';

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-plugin-lifecycle-');
 const source=mkdtempSync('/private/tmp/theo-plugin-source-');
 const runtime=join(root,'.local','theo-runtime');
 const snapshot=join(runtime,'projects','owner-demo');
 for(const path of [join(root,'.local'),runtime,join(runtime,'projects'),snapshot,
  join(snapshot,'extension'),join(source,'extension')])mkdirSync(path,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({
  schema:1,projects:{'owner-demo':snapshot}
 }),{mode:0o600});
 for(const project of [snapshot,source]){
  writeFileSync(join(project,'README.md'),'Offline lifecycle fixture\n',{mode:0o600});
  writeFileSync(join(project,file),before,{mode:0o600});
 }
 return {root,runtime,snapshot,source,
  readSource:()=>readFileSync(join(source,file),'utf8'),
  readSnapshot:()=>readFileSync(join(snapshot,file),'utf8'),
  cleanup:()=>{rmSync(root,{recursive:true,force:true});rmSync(source,{recursive:true,force:true});}
 };
}

function bridgeFor(writer){
 return {
  listProjects:()=>[{id:'owner-demo'}],
  start:()=>({id:'synthetic-read-task',created:true,state:'QUEUED'}),
  status:()=>({id:'synthetic-read-task',projectId:'owner-demo',state:'COMPLETED'}),
  events:()=>[],result:()=>({state:'COMPLETED'}),stop:()=>({state:'STOPPED'}),
  writePropose:request=>writer.request(request),
  writeStatus:id=>writer.status(id),
  writeEvents:(id,after)=>writer.events(id,after),
  writeResult:id=>writer.result(id),
  writeCancel:id=>writer.cancel(id)
 };
}

async function invoke(client,name,args={}){
 const result=await client.callTool({name,arguments:args});
 const value=JSON.parse(result.content?.[0]?.text??'null');
 if(result.isError)throw Error(value?.error??'MCP_ERROR');
 return value;
}

async function completedWrite(client,id){
 for(let attempt=0;attempt<140;attempt++){
  const status=await invoke(client,'standalone_write_status',{id});
  if(['COMPLETED','DENIED','REJECTED','UNKNOWN','EXPIRED'].includes(status.state))return status;
  await pause(12);
 }
 throw Error('WRITE_DID_NOT_SETTLE');
}

test('offline MCP candidate lifecycle requires separate local Owner approvals to apply and restore',async()=>{
 const f=fixture();
 let client,server,writer;
 let candidateApprovals=0,promotionApprovals=0,restoreApprovals=0;
 try{
  writer=new CandidateWriteCoordinator({
   root:f.root,enabled:true,maxDurationMs:1000,
   approval:async context=>{
    candidateApprovals++;
    assert.equal(context.projectId,'owner-demo');
    assert.deepEqual(context.allowedFiles,[file]);
    return {approved:true,reason:'APPROVED'};
   },
   adapterFactory:({projectRoot,allowedFiles})=>new CodexCandidateWriteAdapter(
    process.execPath,projectRoot,{allowedFiles,args:[fake,'allowed'],rpcTimeoutMs:650}
   )
  });
  const bridge=bridgeFor(writer);
  server=makeServer({workspace:f.root,codexPath:'/missing/codex',
   remoteCoordinator:bridge,writeCoordinator:bridge});
  client=new Client({name:'plugin-full-lifecycle-test',version:'1'});
  const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);

  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,13);
  assert.deepEqual(tools.map(tool=>tool.name).sort(),[
   'standalone_capabilities','standalone_codex_probe','standalone_list_projects',
   'standalone_task_events','standalone_task_result','standalone_task_start',
   'standalone_task_status','standalone_task_stop','standalone_write_cancel',
   'standalone_write_events','standalone_write_request','standalone_write_result',
   'standalone_write_status'
  ]);

  const request={
   id:'owner-demo-request-01',projectId:'owner-demo',
   instruction:'Change only extension/popup.js LABEL text from BEFORE to AFTER.',
   allowedFiles:[file]
  };
  const started=await invoke(client,'standalone_write_request',request);
  assert.equal(started.created,true);
  assert.equal((await completedWrite(client,request.id)).state,'COMPLETED');
  const result=await invoke(client,'standalone_write_result',{id:request.id});
  const candidate=join(f.runtime,'write-candidates',request.id,file);
  assert.equal(candidateApprovals,1);
  assert.equal(result.grantConsumed,true);
  assert.equal(result.sourceModified,false);
  assert.deepEqual(result.candidate.changedFiles,[file]);
  assert.equal(readFileSync(candidate,'utf8'),after);
  assert.equal(result.candidate.changedHashes[0].after,digest(after));
  assert.equal(result.candidate.changedHashes[0].before,digest(before));
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  const snapshotHash=snapshotManifest(f.snapshot).hash;
  const replay=await invoke(client,'standalone_write_request',request);
  assert.equal(replay.created,false);
  assert.equal(candidateApprovals,1);
  assert.deepEqual(await invoke(client,'standalone_write_result',{id:request.id}),result);

  const promotionArgs={standaloneRoot:f.root,requestId:request.id,sourceRoot:f.source};
  const plan=previewPromotion(promotionArgs);
  await assert.rejects(()=>applyPromotion({...promotionArgs,confirm:'invalid-fingerprint',
   approveOwner:async()=>{promotionApprovals++;return true;}}),/PROMOTION_OWNER_REVIEW_REQUIRED/);
  assert.equal(promotionApprovals,0);
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  assert.equal(snapshotManifest(f.snapshot).hash,snapshotHash);

  const applied=await applyPromotion({...promotionArgs,confirm:plan.reviewCode,
   approveOwner:async context=>{
    promotionApprovals++;
    assert.equal(context.action,'APPLY');
    assert.equal(context.projectId,'owner-demo');
    assert.equal(context.file,file);
    return {approved:true,reason:'APPROVED'};
   }});
  assert.equal(applied.state,'APPLIED');
  assert.equal(promotionApprovals,1);
  assert.equal(f.readSource(),after);
  assert.equal(f.readSnapshot(),before);
  assert.equal(snapshotManifest(f.snapshot).hash,snapshotHash);

  const restoring=previewRestore({standaloneRoot:f.root,requestId:request.id});
  const restored=await restorePromotion({standaloneRoot:f.root,requestId:request.id,
   confirm:restoring.reviewCode,approveOwner:async context=>{
    restoreApprovals++;
    assert.equal(context.action,'RESTORE');
    assert.equal(context.file,file);
    return {approved:true,reason:'APPROVED'};
   }});
  assert.equal(restored.state,'RESTORED');
  assert.equal(restoreApprovals,1);
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  assert.equal(snapshotManifest(f.snapshot).hash,snapshotHash);
 }finally{
  await client?.close();
  await server?.close();
  await writer?.close();
  f.cleanup();
 }
});
