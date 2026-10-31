import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,realpathSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {CodexAppServer} from '../src/codex-adapter.mjs';
import {TaskCoordinator} from '../src/task-coordinator.mjs';
import {TaskStore} from '../src/task-store.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {makeServer} from '../src/mcp.mjs';
const fake=resolve('test/fake-app-server.mjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn,testFn,ms=1300)=>{
 const until=Date.now()+ms;
 while(Date.now()<until){const r=await fn();if(testFn(r))return r;await delay(10);}
 throw Error('WAIT_TIMED_OUT');
};
test('Codex stdio wire protocol recognizes terminal, identity and progress',async()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-codex-wire-')));
 const before=readdirSync(dir);
 const adapter=new CodexAppServer(process.execPath,dir,{args:[fake,'completed']});
 const events=[];
 try{
  await adapter.execute({projectRoot:dir,prompt:'Read-only test',onEvent:e=>events.push(e)});
  assert.equal(events.at(-1).status,'completed');
  assert.ok(events.some(e=>e.stage==='agent_message'));
  assert.ok(events.some(e=>e.stage==='diff_report'));
  assert.deepEqual(readdirSync(dir),before);
 }finally{adapter.disconnect();rmSync(dir,{recursive:true,force:true});}
});
for(const [mode,needle] of [['bad-policy','CODEX_EFFECTIVE_POLICY_UNVERIFIED'],['foreign-turn','EVENT_ID_MISMATCH'],
 ['approval','APPROVAL_REQUEST_DENIED'],['disconnected','CODEX_DISCONNECTED']]){
 test('Codex protocol denies '+mode,async()=>{
  const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-codex-wire-')));
  const a=new CodexAppServer(process.execPath,dir,{args:[fake,mode],rpcTimeoutMs:700});
  try{await assert.rejects(()=>a.execute({projectRoot:dir,prompt:'test',onEvent:()=>{}}),new RegExp(needle));}
  finally{a.disconnect();rmSync(dir,{recursive:true,force:true});}
 });
}
test('MCP -> real JSON-RPC adapter -> fake App Server -> SQLite -> status/events/result',async()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-wire-e2e-')));
 const project=join(dir,'project');mkdirSync(project);
 const before=readdirSync(project);
 const store=new TaskStore(join(dir,'journal.sqlite'));
 const coordinator=new TaskCoordinator({
  projects:{fixture:project},store,maxDurationMs:1000,
  adapterFactory:()=>new CodexAppServer(process.execPath,project,{args:[fake,'completed']})
 });
 const server=makeServer({codexPath:'/nonexistent',workspace:dir,fixtureCoordinator:coordinator});
 const client=new Client({name:'wire-e2e',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await Promise.all([server.connect(a),client.connect(b)]);
  const invoke=async(tool,args)=>{
   const r=await client.callTool({name:'standalone_'+tool,arguments:args});
   if(r.isError)throw Error(r.content[0].text);
   return JSON.parse(r.content[0].text);
  };
  const started=await invoke('task_start',{id:'wire-e2e-0001',projectId:'fixture',prompt:'read-only fake server',mode:'read_only'});
  assert.equal(started.created,true);
  const status=await wait(()=>invoke('task_status',{id:started.id}),x=>x.state==='COMPLETED');
  assert.equal(status.state,'COMPLETED');
  const events=await invoke('task_events',{id:started.id,after:0});
  assert.ok(events.some(x=>x.kind==='agent_message'));
  assert.equal(JSON.stringify(events).includes('verysecretfixture1234'),false);
  const result=await invoke('task_result',{id:started.id});
  assert.equal(result.providerFinished,true);
  assert.equal(result.ownerAccepted,false);
  assert.equal(result.output.includes('verysecretfixture1234'),false);
  assert.deepEqual(readdirSync(project),before);
 }finally{await client.close();await server.close();coordinator.close();rmSync(dir,{recursive:true,force:true});}
});

test('MCP fixture adapter interrupt ACK plus interrupted terminal => STOPPED',async()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-wire-stop-')));
 const project=join(dir,'project');mkdirSync(project);
 const store=new TaskStore(join(dir,'journal.sqlite'));
 const coordinator=new TaskCoordinator({projects:{fixture:project},store,maxDurationMs:900,
  adapterFactory:()=>new CodexAppServer(process.execPath,project,{args:[fake,'interrupt']})});
 try{
  const start=coordinator.start({id:'wire-stop-0001',projectId:'fixture',mode:'read_only',prompt:'Read-only synthetic'});
  await wait(()=>coordinator.status(start.id),s=>s.state==='RUNNING'&&coordinator.running.get(start.id)?.turnId);
  await coordinator.stop(start.id);
  const status=await wait(()=>coordinator.status(start.id),s=>s.state==='STOPPED');
  assert.equal(status.state,'STOPPED');
  assert.equal(coordinator.result(start.id).providerFinished,true);
 }finally{coordinator.close();rmSync(dir,{recursive:true,force:true});}
});
test('Interrupt without terminal is UNKNOWN, never reported as STOPPED',async()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-wire-unknown-')));
 const project=join(dir,'project');mkdirSync(project);
 const store=new TaskStore(join(dir,'journal.sqlite'));
 const coordinator=new TaskCoordinator({projects:{fixture:project},store,maxDurationMs:300,
  adapterFactory:()=>new CodexAppServer(process.execPath,project,{args:[fake,'never']})});
 try{
  const start=coordinator.start({id:'wire-unknown-0001',projectId:'fixture',mode:'read_only',prompt:'Read-only synthetic'});
  await wait(()=>coordinator.status(start.id),s=>s.state==='RUNNING'&&coordinator.running.get(start.id)?.turnId);
  const requested=await coordinator.stop(start.id);
  assert.ok(['STOP_REQUESTED','UNKNOWN'].includes(requested.state));
  const status=await wait(()=>coordinator.status(start.id),s=>s.state==='UNKNOWN',1300);
  assert.equal(status.state,'UNKNOWN');
  assert.equal(coordinator.result(start.id).providerFinished,false);
 }finally{coordinator.close();rmSync(dir,{recursive:true,force:true});}
});
