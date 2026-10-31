import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {TaskBridge} from '../src/task-bridge.mjs';
import {FixtureCodexAdapter} from './fixture-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';

const expected=[
 'standalone_capabilities','standalone_codex_probe','standalone_list_projects',
 'standalone_task_events','standalone_task_result','standalone_task_start',
 'standalone_task_status','standalone_task_stop'
].sort();

test('normal Theo task MCP stdio process advertises real read-only task surface',async()=>{
 const c=new Client({name:'read-only-api-check',version:'1'});
 const t=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/theo-task-entry.mjs')],
  cwd:process.cwd(),env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin'}});
 try{
  await c.connect(t);
  const reported=(await c.listTools()).tools;
  const names=reported.map(x=>x.name).sort();
  assert.deepEqual(names,expected);
  assert.deepEqual(reported.filter(x=>x.annotations?.readOnlyHint===true).map(x=>x.name).sort(),[
   'standalone_capabilities','standalone_codex_probe','standalone_list_projects',
   'standalone_task_events','standalone_task_result','standalone_task_status'
  ].sort());
  assert.deepEqual(reported.filter(x=>x.annotations?.readOnlyHint===false).map(x=>x.name).sort(),[
   'standalone_task_start','standalone_task_stop'
  ].sort());
  const result=await c.callTool({name:'standalone_capabilities',arguments:{}});
  const cap=JSON.parse(result.content[0].text);
  assert.equal(cap.realCodexTaskEnabled,true);
  assert.equal(cap.taskStartEnabled,true);
  assert.equal(cap.writeEnabled,false);
  assert.equal(cap.fixtureTaskEnabled,false);
 }finally{await c.close();}
});
test('normal Theo MCP tool path: start, persist across stateless calls, events and final result',async()=>{
 const root=realpathSync.native(mkdtempSync('/private/tmp/theo-task-mcp-'));
 const local=join(root,'.local'), runtime=join(local,'theo-runtime'), parent=join(runtime,'projects'),
  dir=join(parent,'fixture');
 for(const x of [local,runtime,parent,dir])mkdirSync(x,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:{fixture:dir}}),{mode:0o600});
 const daemon=await startTaskDaemon({root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
 const bridge=new TaskBridge({root,autostart:false});
 const m=makeServer({codexPath:'/nonexistent',workspace:root,remoteCoordinator:bridge});
 const c=new Client({name:'remote-coordinator-e2e',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();
 const call=async(name,args={})=>{
  const r=await c.callTool({name:'standalone_'+name,arguments:args});
  const value=JSON.parse(r.content[0].text);
  if(r.isError)throw Error(value.error);
  return value;
 };
 try{
  await Promise.all([m.connect(a),c.connect(b)]);
  assert.deepEqual(await call('list_projects'),[{id:'fixture'}]);
  const start=await call('task_start',{
   id:'theo-mcp-e2e-1',projectId:'fixture',mode:'read_only',prompt:'Synthetic demo task'
  });
  assert.equal(start.created,true);
  let status;
  for(let i=0;i<70;i++){
   status=await call('task_status',{id:start.id});
   if(status.state==='COMPLETED')break;
   await pause(15);
  }
  assert.equal(status.state,'COMPLETED');
  const all=await call('task_events',{id:start.id,after:0});
  assert.ok(all.length>3);
  assert.ok(all.some(x=>x.kind==='fixture_analysis'));
  const more=await call('task_events',{id:start.id,after:all.at(-1).seq});
  assert.deepEqual(more,[]);
  const res=await call('task_result',{id:start.id});
  assert.equal(res.providerFinished,true);
  assert.equal(res.ownerAccepted,false);
  assert.equal(res.output.includes('Synthetic only'),true);
  const dup=await call('task_start',{
   id:'theo-mcp-e2e-1',projectId:'fixture',mode:'read_only',prompt:'Synthetic demo task'
  });
  assert.equal(dup.created,false);
  await assert.rejects(()=>call('task_start',{
   id:'theo-mcp-e2e-2',projectId:'other',mode:'read_only',prompt:'No'
  }),/PROJECT_NOT_REGISTERED/);
  const bad=await c.callTool({name:'standalone_task_start',arguments:{
    id:'theo-mcp-e2e-3',projectId:'fixture',mode:'workspace_write',prompt:'write'
  }});
  assert.equal(bad.isError,true);
 }finally{
  await c.close();await m.close();await daemon.stop();
  rmSync(root,{recursive:true,force:true});
 }
});
