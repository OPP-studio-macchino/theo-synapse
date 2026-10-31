import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CandidateWriteCoordinator} from '../src/candidate-write-coordinator.mjs';
import {CodexCandidateWriteAdapter} from '../src/codex-write-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';

const fake=resolve('test/fake-write-app-server.mjs');
const sleep=ms=>pause(ms);
function fixture(){
 const root=mkdtempSync('/private/tmp/theo-write-mcp-');
 const local=join(root,'.local'),runtime=join(local,'theo-runtime');
 const projects=join(runtime,'projects'),dir=join(projects,'owner-snapshot');
 for(const p of [local,runtime,projects,dir,join(dir,'extension')])
  mkdirSync(p,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),
  JSON.stringify({schema:1,projects:{'owner-snapshot':dir}}),{mode:0o600});
 writeFileSync(join(dir,'README.md'),'Private snapshot fixture\n',{mode:0o600});
 writeFileSync(join(dir,'extension','popup.js'),'export const LABEL = "BEFORE";\n',{mode:0o600});
 return {root,dir,runtime,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
async function invoke(client,name,args={}){
 const r=await client.callTool({name,arguments:args});
 const value=JSON.parse(r.content?.[0]?.text??'null');
 if(r.isError)throw Error(value?.error??'MCP_ERROR');
 return value;
}
function inMemoryCoordinator(getWriter){
 return {
  listProjects:()=>[{id:'owner-snapshot'}],
  start:()=>{
   if(getWriter()?.hasActiveRequest())throw Error('WRITE_REQUEST_ACTIVE');
   return {id:'synthetic-read-task',created:true,state:'QUEUED'};
  },
  status:()=>({id:'synthetic-read-task',projectId:'owner-snapshot',state:'COMPLETED'}),
  events:()=>[],result:()=>({state:'COMPLETED'}),stop:()=>({state:'STOPPED'}),
  writePropose:x=>getWriter().request(x),
  writeStatus:id=>getWriter().status(id),
  writeEvents:(id,after)=>getWriter().events(id,after),
  writeResult:id=>getWriter().result(id),
  writeCancel:id=>getWriter().cancel(id)
 };
}
test('default in-memory MCP surface remains the eight live tools with no write bridge',async()=>{
 const t=fixture();let client,server;
 try{
  const readOnly=inMemoryCoordinator(()=>null);
  server=makeServer({workspace:t.root,codexPath:'/missing/codex',remoteCoordinator:readOnly});
  client=new Client({name:'theo-mcp-default-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,8);
  assert.equal(tools.some(x=>x.name.startsWith('standalone_write_')),false);
  const caps=await invoke(client,'standalone_capabilities');
  assert.equal(caps.writeEnabled,false);
  assert.equal(caps.candidateWriteEnabled,false);
  assert.equal(existsSync(join(t.runtime,'writes.sqlite')),false);
  assert.equal(existsSync(join(t.runtime,'write-candidates')),false);
 }finally{await client?.close();await server?.close();t.cleanup();}
});
test('owner-approved synthetic MCP write flow: prepare -> grant-burn -> isolated candidate -> result',async()=>{
 const t=fixture();let client,server,writer;let accepted=0;
 try{
  writer=new CandidateWriteCoordinator({root:t.root,enabled:true,maxDurationMs:1000,
    approval:async ctx=>{
     accepted++;
     assert.equal(ctx.projectId,'owner-snapshot');
     assert.equal(ctx.allowedFiles[0],'extension/popup.js');
     return true;
    },
    adapterFactory:({projectRoot,allowedFiles})=>new CodexCandidateWriteAdapter(
     process.execPath,projectRoot,{allowedFiles,args:[fake,'allowed'],rpcTimeoutMs:650}
    )
  });
  const bridge=inMemoryCoordinator(()=>writer);
  server=makeServer({workspace:t.root,codexPath:'/missing/codex',
   remoteCoordinator:bridge,writeCoordinator:bridge});
  client=new Client({name:'theo-mcp-write-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  const all=(await client.listTools()).tools;
  assert.equal(all.length,13);
  const writeRequest=all.find(x=>x.name==='standalone_write_request');
  assert.equal(writeRequest?.annotations?.readOnlyHint,false);
  assert.match(writeRequest?.description??'',/candidate-only edit/);
  assert.match(writeRequest?.description??'',/Never modifies original code/);
  assert.equal(all.find(x=>x.name==='standalone_write_result')?.annotations?.readOnlyHint,true);
  const caps=await invoke(client,'standalone_capabilities');
  assert.equal(caps.candidateWriteEnabled,true);
  assert.equal(caps.writeEnabled,false);
  const request={
   id:'theo-write-mcp-test01',projectId:'owner-snapshot',
   instruction:'Change only extension/popup.js LABEL text from BEFORE to AFTER.',
   allowedFiles:['extension/popup.js']
  };
  const started=await invoke(client,'standalone_write_request',request);
  assert.equal(started.created,true);
  assert.equal(started.ownerApprovalRequired,true);
  let status=null;
  for(let i=0;i<140;i++){
   status=await invoke(client,'standalone_write_status',{id:request.id});
   if(['COMPLETED','DENIED','REJECTED','UNKNOWN','EXPIRED'].includes(status.state))break;
   await sleep(12);
  }
  assert.equal(status.state,'COMPLETED');
  assert.equal(accepted,1);
  const result=await invoke(client,'standalone_write_result',{id:request.id});
  assert.equal(result.grantConsumed,true);
  assert.equal(result.artifactsApplied,false);
  assert.equal(result.sourceModified,false);
  assert.deepEqual(result.candidate.changedFiles,['extension/popup.js']);
  assert.equal(readFileSync(join(t.dir,'extension','popup.js'),'utf8'),
   'export const LABEL = "BEFORE";\n');
  const staged=join(t.runtime,'write-candidates',request.id,'extension','popup.js');
  assert.equal(readFileSync(staged,'utf8'),'export const LABEL = "AFTER";\n');
  await writer.close();
  writer=new CandidateWriteCoordinator({root:t.root,enabled:true,maxDurationMs:1000,
    approval:async()=>{accepted++;return true;},
    adapterFactory:({projectRoot,allowedFiles})=>new CodexCandidateWriteAdapter(
     process.execPath,projectRoot,{allowedFiles,args:[fake,'allowed'],rpcTimeoutMs:650}
    )
  });
  const afterRestart=await invoke(client,'standalone_write_result',{id:request.id});
  assert.deepEqual(afterRestart,result);
  const replay=await invoke(client,'standalone_write_request',request);
  assert.equal(replay.created,false);
  assert.equal(accepted,1);
  const events=await invoke(client,'standalone_write_events',{id:request.id,after:0});
  assert.ok(events.some(x=>x.kind==='AUTHORIZED'));
  assert.ok(events.some(x=>x.kind==='RUNNING'));
  assert.ok(events.some(x=>x.kind==='COMPLETED'));
  const exhausted=await invoke(client,'standalone_write_events',{
   id:request.id,after:events.at(-1).seq
  });
  assert.deepEqual(exhausted,[]);
  const invalid=await client.callTool({name:'standalone_write_request',arguments:{
   ...request,id:'theo-write-mcp-invalid',allowedFiles:['../../wrong.js']
  }});
  assert.equal(invalid.isError,true);
  const deny=await invoke(client,'standalone_write_cancel',{id:request.id});
  assert.equal(deny.state,'COMPLETED');
 }finally{
  await client?.close();await server?.close();await writer?.close();t.cleanup();
 }
});
test('an active candidate approval blocks read tasks and cancellation remains fail-closed',async()=>{
 const t=fixture();let writer,client,server;let release;
 const approval=new Promise(resolve=>{release=resolve;});
 try{
  writer=new CandidateWriteCoordinator({root:t.root,enabled:true,approval:async()=>approval,maxDurationMs:1000,
    adapterFactory:()=>{throw Error('WRITE_ADAPTER_MUST_NOT_START');}
  });
  const bridge=inMemoryCoordinator(()=>writer);
  server=makeServer({workspace:t.root,codexPath:'/missing/codex',remoteCoordinator:bridge,writeCoordinator:bridge});
  client=new Client({name:'theo-mcp-conflict-test',version:'1'});
  const [a,b]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a),client.connect(b)]);
  const request={id:'theo-write-conflict1',projectId:'owner-snapshot',
   instruction:'Change only extension/popup.js LABEL text from BEFORE to AFTER.',
   allowedFiles:['extension/popup.js']};
  assert.equal((await invoke(client,'standalone_write_request',request)).state,'APPROVAL_PENDING');
  const blocked=await client.callTool({name:'standalone_task_start',arguments:{id:'theo-read-conflict01',
   projectId:'owner-snapshot',mode:'read_only',prompt:'This read task must be refused during Owner approval.'}});
  assert.equal(blocked.isError,true);
  assert.match(blocked.content[0].text,/WRITE_REQUEST_ACTIVE/);
  assert.equal((await invoke(client,'standalone_write_cancel',{id:request.id})).state,'DENIED');
  release(true);
  for(let i=0;i<60;i++){
   if((await invoke(client,'standalone_write_status',{id:request.id})).state==='DENIED')break;
   await sleep(10);
  }
  const result=await invoke(client,'standalone_write_result',{id:request.id});
  assert.equal(result.state,'DENIED');
  assert.equal(result.grantConsumed,false);
  assert.equal(result.candidate,null);
  assert.equal(readFileSync(join(t.dir,'extension','popup.js'),'utf8'),
   'export const LABEL = "BEFORE";\n');
 }finally{release?.(false);await client?.close();await server?.close();await writer?.close();t.cleanup();}
});
