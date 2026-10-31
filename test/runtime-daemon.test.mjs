import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,renameSync,lstatSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {TaskBridge} from '../src/task-bridge.mjs';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {FixtureCodexAdapter} from './fixture-adapter.mjs';
import {DirectCoordinator} from '../src/direct-coordinator.mjs';
import {CodexAppServer} from '../src/codex-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
function testRoot(){
 const root=realpathSync.native(mkdtempSync('/private/tmp/theo-ipc-e2e-'));
 const privateBase=join(root,'.local');
 const runtime=join(privateBase,'theo-runtime');
 const projectBase=join(runtime,'projects');
 const project=join(projectBase,'fixture');
 for(const d of [privateBase,runtime,projectBase,project])mkdirSync(d,{mode:0o700});
 const config=join(runtime,'projects.json');
 writeFileSync(config,JSON.stringify({schema:1,projects:{fixture:project}}),{mode:0o600});
 writeFileSync(join(project,'INPUT.md'),'Synthetic lab file, not a model turn.\n',{mode:0o600});
 return {root,runtime,project,config};
}
async function poll(fn,predicate,ms=1300){
 const end=Date.now()+ms;
 while(Date.now()<end){const x=await fn();if(predicate(x))return x;await pause(10);}
 throw Error('TEST_POLL_TIMEOUT');
}
test('private local daemon + separate IPC clients: accepted -> progress -> result -> restart persistence',async()=>{
 const t=testRoot();let daemon=null,second=null;
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  assert.equal(lstatSync(daemon.socketPath).mode&0o077,0);
  await assert.rejects(()=>startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000}),/TASK_DAEMON_ALREADY_RUNNING/);
  const a=new TaskBridge({root:t.root,autostart:false});
  const b=new TaskBridge({root:t.root,autostart:false});
  assert.deepEqual(await a.listProjects(),[{id:'fixture'}]);
  const started=await a.start({id:'theo-ipc-0001',projectId:'fixture',mode:'read_only',prompt:'Synthetic only'});
  assert.equal(started.created,true);
  const final=await poll(()=>b.status(started.id),s=>s.state==='COMPLETED');
  assert.equal(final.projectId,'fixture');
  const events=await a.events(started.id,0);
  assert.ok(events.some(e=>e.kind==='fixture_analysis'));
  assert.ok(events.some(e=>e.kind==='COMPLETED'));
  assert.equal(JSON.stringify(events).includes('fixturesensitive123456'),false);
  const result=await b.result(started.id);
  assert.equal(result.providerFinished,true);
  assert.equal(result.ownerAccepted,false);
  assert.match(result.output,/Synthetic only/);
  const repeat=await b.start({id:'theo-ipc-0001',projectId:'fixture',mode:'read_only',prompt:'Synthetic only'});
  assert.equal(repeat.created,false);
  await assert.rejects(()=>a.start({id:'theo-ipc-0001',projectId:'fixture',mode:'read_only',prompt:'different'}),/TASK_ID_CONFLICT/);
  await assert.rejects(()=>a.start({id:'theo-ipc-0002',projectId:'outside',mode:'read_only',prompt:'No'}),/PROJECT_NOT_REGISTERED/);
  await daemon.stop();daemon=null;
  second=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  const preserved=await new TaskBridge({root:t.root,autostart:false}).result(started.id);
  assert.equal(preserved.state,'COMPLETED');
 }finally{
  await second?.stop();await daemon?.stop();rmSync(t.root,{recursive:true,force:true});
 }
});
test('two requests cannot run concurrently and caller cannot request writes',async()=>{
 const t=testRoot();let daemon;
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter({mode:'hang'}),maxDurationMs:270});
  const bridge=new TaskBridge({root:t.root,autostart:false});
  await bridge.start({id:'theo-ipc-hang1',projectId:'fixture',mode:'read_only',prompt:'hang'});
  await assert.rejects(()=>bridge.start({id:'theo-ipc-hang2',projectId:'fixture',mode:'read_only',prompt:'another'}),/ANOTHER_TASK_ACTIVE/);
  await assert.rejects(()=>bridge.start({id:'theo-ipc-write',projectId:'fixture',mode:'workspace_write',prompt:'write'}),/WRITE_NOT_AUTHORIZED/);
  await poll(()=>bridge.status('theo-ipc-hang1'),s=>s.state==='UNKNOWN',1500);
  assert.equal((await bridge.result('theo-ipc-hang1')).providerFinished,false);
 }finally{await daemon?.stop();rmSync(t.root,{recursive:true,force:true});}
});
test('registry rejects invalid private-file permissions and project symlinks',()=>{
 const t=testRoot();
 try{
  assert.deepEqual(Object.keys(loadReadOnlyRegistry(t.root).projects),['fixture']);
  const bad=join(t.runtime,'projects','alias');
  symlinkSync(t.project,bad);
  writeFileSync(t.config,JSON.stringify({schema:1,projects:{fixture:bad}}),{mode:0o600});
  assert.throws(()=>loadReadOnlyRegistry(t.root),/PRIVATE_DIRECTORY_REQUIRED/);
 }finally{rmSync(t.root,{recursive:true,force:true});}
});

test('owner registry snapshot hot reload appears without restarting a healthy daemon',async()=>{
 const t=testRoot();let daemon;
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  const bridge=new TaskBridge({root:t.root,autostart:false});
  assert.deepEqual(await bridge.listProjects(),[{id:'fixture'}]);
  const second=join(t.runtime,'projects','approved-snapshot');
  mkdirSync(second,{mode:0o700});
  writeFileSync(join(second,'README.md'),'Imported by Owner locally.\n',{mode:0o600});
  const config2={schema:1,projects:{
   fixture:t.project,'approved-snapshot':second
  }};
  const temp=t.config+'.tmp';
  writeFileSync(temp,JSON.stringify(config2),{mode:0o600});
  renameSync(temp,t.config);
  const returned=await bridge.listProjects();
  assert.deepEqual(returned.map(p=>p.id),['fixture','approved-snapshot']);
  const task=await bridge.start({id:'hotreloaded-0001',projectId:'approved-snapshot',
   mode:'read_only',prompt:'Read-only synthetic'});
  const complete=await poll(()=>bridge.status(task.id),r=>r.state==='COMPLETED');
  assert.equal(complete.projectId,'approved-snapshot');
 }finally{await daemon?.stop();rmSync(t.root,{recursive:true,force:true});}
});
test('new tasks fail closed while an Owner registry import holds its lock',async()=>{
 const t=testRoot();let daemon;
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  const bridge=new TaskBridge({root:t.root,autostart:false});
  const lock=join(t.runtime,'.registry-owner-lock');mkdirSync(lock,{mode:0o700});
  await assert.rejects(()=>bridge.start({id:'locked-import-0001',projectId:'fixture',mode:'read_only',prompt:'Must not start'}),/OWNER_REGISTRY_UPDATE_ACTIVE/);
  rmSync(lock,{recursive:true,force:true});
  assert.equal((await bridge.start({id:'after-import-0001',projectId:'fixture',mode:'read_only',prompt:'May start'})).created,true);
 }finally{await daemon?.stop();rmSync(t.root,{recursive:true,force:true});}
});
test('registry hot reload is deferred during active read-only task',async()=>{
 const t=testRoot();let daemon;
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter({mode:'hang'}),maxDurationMs:275});
  const bridge=new TaskBridge({root:t.root,autostart:false});
  await bridge.start({id:'busy-reload-0001',projectId:'fixture',mode:'read_only',prompt:'Hang until timeout'});
  const second=join(t.runtime,'projects','new-owner-snapshot');
  mkdirSync(second,{mode:0o700});
  const temp=t.config+'.tmp';
  writeFileSync(temp,JSON.stringify({schema:1,projects:{fixture:t.project,'new-owner-snapshot':second}}),{mode:0o600});
  renameSync(temp,t.config);
  await assert.rejects(()=>bridge.listProjects(),/REGISTRY_RELOAD_DEFERRED_BUSY/);
  await poll(()=>bridge.status('busy-reload-0001'),s=>s.state==='UNKNOWN',1500);
  assert.deepEqual((await bridge.listProjects()).map(x=>x.id),['fixture','new-owner-snapshot']);
 }finally{await daemon?.stop();rmSync(t.root,{recursive:true,force:true});}
});

test('trusted-host direct IPC reaches a fake local App Server and remains isolated from read tasks and writes',async()=>{
 const t=testRoot();let daemon,second;
 const directFactory=({workspaces,journalPath})=>new DirectCoordinator({
  workspaces,journalPath,
  adapterFactory:({projectRoot})=>new CodexAppServer(process.execPath,projectRoot,{args:[new URL('./fake-direct-app-server.mjs',import.meta.url).pathname]}),
  ownerAuthorization:()=>false,maxDurationMs:1000
 });
 try{
  daemon=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),directCoordinatorFactory:directFactory,maxDurationMs:1000});
  const bridge=new TaskBridge({root:t.root,autostart:false});
  assert.deepEqual(await bridge.directCapabilities(),{enabled:true,ownerApproval:'host_callback_required',workspaceWriteEnabled:false});
  const server=makeServer({codexPath:'/nonexistent',workspace:t.root,remoteCoordinator:bridge,
   directCoordinator:{start:x=>bridge.directStart(x),wait:x=>bridge.directWait(x)}});
  const client=new Client({name:'direct-daemon-e2e',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
  try{
   await Promise.all([server.connect(a),client.connect(b)]);
   assert.equal((await client.listTools()).tools.length,10);
   const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});const body=JSON.parse(r.content[0].text);if(r.isError)throw Error(body.error);return body;};
   const pathAttempt=await client.callTool({name:'codex_turn_start',arguments:{task_id:'direct-path-0001',iteration:1,instruction:'no path',workspace_id:'fixture',path:'/private/tmp'}});
   assert.equal(pathAttempt.isError,true);
   const started=await call('codex_turn_start',{task_id:'direct-ipc-0001',iteration:1,instruction:'Read only fixture',workspace_id:'fixture',execution_mode:'read_only'});
   await assert.rejects(()=>bridge.start({id:'read-conflict-0001',projectId:'fixture',mode:'read_only',prompt:'blocked'}),/DIRECT_RUN_ACTIVE/);
   const done=await poll(()=>bridge.directWait({task_id:'direct-ipc-0001',run_id:started.run_id,workspace_id:'fixture'}),x=>x.state==='COMPLETED');
   assert.equal(done.execution_mode,'read_only');
  }finally{await client.close();await server.close();}
  await assert.rejects(()=>bridge.directStart({task_id:'direct-write-0001',iteration:1,instruction:'Denied write',workspace_id:'fixture',execution_mode:'workspace_write'}),/DIRECT_OWNER_AUTHORIZATION_REQUIRED/);
  const persisted=await bridge.directStart({task_id:'direct-ipc-0001',iteration:1,instruction:'Read only fixture',workspace_id:'fixture',execution_mode:'read_only'});
  assert.equal(persisted.created,false);
  await daemon.stop();daemon=null;
  second=await startTaskDaemon({root:t.root,adapterFactory:()=>new FixtureCodexAdapter(),directCoordinatorFactory:directFactory,maxDurationMs:1000});
  const afterRestart=await new TaskBridge({root:t.root,autostart:false}).directWait({task_id:'direct-ipc-0001',run_id:persisted.run_id,workspace_id:'fixture'});
  assert.equal(afterRestart.state,'COMPLETED');
  await assert.rejects(()=>new TaskBridge({root:t.root,autostart:false}).directWait({task_id:'direct-ipc-0001',run_id:persisted.run_id,workspace_id:'outside'}),/DIRECT_WORKSPACE_MISMATCH/);
 }finally{await second?.stop();await daemon?.stop();rmSync(t.root,{recursive:true,force:true});}
});
