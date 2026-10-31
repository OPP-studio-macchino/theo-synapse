import {test} from 'node:test';
import * as fs from 'node:fs';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {TaskStore} from '../src/task-store.mjs';
import {TaskCoordinator} from '../src/task-coordinator.mjs';
import {FixtureCodexAdapter} from './fixture-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,match,timeout=1400){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){const v=await fn();if(match(v))return v;await delay(10);}
 throw Error('TEST_TIMEOUT');
}
async function setup(mode='complete',maxDurationMs=1000){
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-standalone-e2e-')));
 const project=join(dir,'fixture-workspace');mkdirSync(project);
 const store=new TaskStore(join(dir,'journal.sqlite'));
 const coordinator=new TaskCoordinator({projects:{fixture:project},store,adapterFactory:()=>new FixtureCodexAdapter({mode}),maxDurationMs});
 const server=makeServer({codexPath:'/nonexistent',workspace:dir,fixtureCoordinator:coordinator});
 const client=new Client({name:'fixture-mcp-client',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(a),client.connect(b)]);
 const call=async (name,args={})=>{
   const res=await client.callTool({name:'standalone_'+name,arguments:args});
   let value;try{value=JSON.parse(res.content[0].text);}catch{throw Error(res.content[0].text);}
   if(res.isError)throw Error(value.error??res.content[0].text);
   return value;
 };
 const close=async()=>{await client.close();await server.close();coordinator.close();rmSync(dir,{recursive:true,force:true});};
 return {dir,project,call,close};
}
test('MCP request -> fake execution -> progress -> persisted result',async()=>{
 const t=await setup();
 try{
  const before=readdirSync(t.project);
  assert.deepEqual(await t.call('list_projects'),[{id:'fixture'}]);
  const start=await t.call('task_start',{id:'fixture-pass-0001',projectId:'fixture',prompt:'Examine synthetic fixture only',mode:'read_only'});
  assert.equal(start.created,true);
  const done=await until(()=>t.call('task_status',{id:start.id}),v=>v.state==='COMPLETED');
  assert.equal(done.projectId,'fixture');
  const ev=await t.call('task_events',{id:start.id,after:0});
  assert.ok(ev.some(x=>x.kind==='fixture_analysis'));
  assert.ok(ev.some(x=>x.kind==='COMPLETED'));
  assert.equal(JSON.stringify(ev).includes('fixturesensitive123456'),false);
  assert.equal(JSON.stringify(ev).includes('[REDACTED]'),true);
  const tail=await t.call('task_events',{id:start.id,after:ev[ev.length-1].seq});
  assert.deepEqual(tail,[]);
  const result=await t.call('task_result',{id:start.id});
  assert.equal(result.providerFinished,true);
  assert.match(result.output,/Synthetic only/);
  assert.equal(result.testsVerified,false);
  assert.equal(result.ownerAccepted,false);
  assert.deepEqual(readdirSync(t.project),before);
  const again=await t.call('task_start',{id:'fixture-pass-0001',projectId:'fixture',prompt:'Examine synthetic fixture only',mode:'read_only'});
  assert.equal(again.created,false);
  await assert.rejects(()=>t.call('task_start',{id:'fixture-pass-0001',projectId:'fixture',prompt:'new job',mode:'read_only'}),/TASK_ID_CONFLICT/);
  await assert.rejects(()=>t.call('task_start',{id:'fixture-pass-0002',projectId:'outside',prompt:'new job',mode:'read_only'}),/PROJECT_NOT_REGISTERED/);
  const write=await t.call('task_start',{id:'fixture-pass-0003',projectId:'fixture',prompt:'edit source',mode:'workspace_write'}).catch(e=>String(e));
  assert.match(String(write),/Invalid|literal|Expected|WRITE_NOT_AUTHORIZED/);
 }finally{await t.close();}
});
test('MCP fixture stop returns STOPPED only on terminal acknowledgment',async()=>{
 const t=await setup();
 try{
  const {id}=await t.call('task_start',{id:'fixture-stop-0001',projectId:'fixture',prompt:'Stop synthetic task',mode:'read_only'});
  await until(()=>t.call('task_status',{id}),v=>v.state==='RUNNING');
  await t.call('task_stop',{id});
  await until(()=>t.call('task_status',{id}),v=>v.state==='STOPPED');
  assert.equal((await t.call('task_result',{id})).providerFinished,true);
 }finally{await t.close();}
});
test('Missing fixture terminal becomes UNKNOWN and never passes as completed',async()=>{
 const t=await setup('hang',260);
 try{
  const {id}=await t.call('task_start',{id:'fixture-hang-0001',projectId:'fixture',prompt:'hang fixture',mode:'read_only'});
  await until(()=>t.call('task_status',{id}),v=>v.state==='UNKNOWN',1200);
  assert.equal((await t.call('task_result',{id})).providerFinished,false);
  const again=await t.call('task_start',{id,projectId:'fixture',prompt:'hang fixture',mode:'read_only'});
  assert.equal(again.created,false);
  assert.equal((await t.call('task_status',{id})).state,'UNKNOWN');
 }finally{await t.close();}
});
test('SQLite on restart preserves orphan as UNKNOWN',()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-standalone-journal-')));
 try{
  const filename=join(dir,'journal.sqlite');
  const first=new TaskStore(filename);
  first.reserve({id:'orphan-0001',projectId:'fixture',mode:'read_only',prompt:'read'});
  first.transition('orphan-0001','RUNNING');first.close();
  const second=new TaskStore(filename);
  assert.equal(second.get('orphan-0001').state,'UNKNOWN');
  assert.equal(second.reserve({id:'orphan-0001',projectId:'fixture',mode:'read_only',prompt:'read'}).created,false);
  second.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('Journal refuses unsafe permissions and symlink alias',()=>{
 const dir=realpathSync.native(mkdtempSync(join(tmpdir(),'opp-standalone-secure-')));
 try{
  const file=join(dir,'run.sqlite');
  const s=new TaskStore(file);s.close();
  const {chmodSync,symlinkSync,statSync}=fs;
  assert.equal(statSync(file).mode&0o077,0);
  chmodSync(file,0o644);
  assert.throws(()=>new TaskStore(file),/JOURNAL_FILE_UNSAFE/);
  chmodSync(file,0o600);
  symlinkSync(file,join(dir,'linked.sqlite'));
  assert.throws(()=>new TaskStore(join(dir,'linked.sqlite')),/JOURNAL_FILE_UNSAFE/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
