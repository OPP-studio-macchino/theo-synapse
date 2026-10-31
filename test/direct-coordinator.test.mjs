import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,chmodSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {DirectCoordinator} from '../src/direct-coordinator.mjs';
import {CodexAppServer} from '../src/codex-adapter.mjs';
import {makeServer} from '../src/mcp.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function settled(coordinator,request){for(let i=0;i<50;i++){const result=coordinator.wait(request);if(!['APPROVAL_PENDING','QUEUED','RUNNING'].includes(result.state))return result;await pause(10);}return coordinator.wait(request);}
function fixture(){const base=mkdtempSync('/private/tmp/theo-direct-');chmodSync(base,0o700);const a=join(base,'a'),b=join(base,'b');mkdirSync(a,{mode:0o700});mkdirSync(b,{mode:0o700});chmodSync(a,0o700);chmodSync(b,0o700);return {base,a,b,journal:join(base,'direct.sqlite')};}
function fakeFactory(calls=[]){return options=>({async execute(input){calls.push({options,input});input.onEvent({kind:'terminal',status:'completed',output:'synthetic'});},async disconnect(){}});}

test('direct coordinator defaults to read-only, binds a task, and rejects cross-workspace spoofing',async()=>{
 const f=fixture(),calls=[],c=new DirectCoordinator({workspaces:{one:f.a,two:f.b},journalPath:f.journal,adapterFactory:fakeFactory(calls)});
 assert.throws(()=>c.start({task_id:'direct-task',iteration:1,instruction:'x'}),/DIRECT_WORKSPACE_NOT_REGISTERED/);
 const first=c.start({task_id:'direct-task',iteration:1,instruction:'x',workspace_id:'one'});assert.equal(first.execution_mode,'read_only');await pause(10);
 const completed=c.wait({task_id:'direct-task',run_id:first.run_id,workspace_id:'one'});assert.equal(completed.state,'COMPLETED');assert.equal(completed.providerFinished,true);assert.equal(completed.reasonCode,null);
 assert.throws(()=>c.wait({task_id:'unknown-task',run_id:'unknown-task:1'}),/DIRECT_RUN_NOT_FOUND/);
 assert.equal(calls[0].input.executionMode,'read_only');
 assert.throws(()=>c.start({task_id:'direct-task',iteration:2,instruction:'x',workspace_id:'two'}),/DIRECT_TASK_BINDING_CONFLICT/);
 c.close();
});

test('direct instructions allow one bounded 12 KiB feature request and reject any larger request',async()=>{
 const f=fixture(),c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
 try{
  const accepted=c.start({task_id:'direct-12k-request',iteration:1,instruction:'a'.repeat(12288),workspace_id:'one'});assert.equal(accepted.created,true);
  assert.throws(()=>c.start({task_id:'direct-over-request',iteration:1,instruction:'a'.repeat(12289),workspace_id:'one'}),/INVALID_DIRECT_REQUEST/);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('workspace write requires a separate host Owner grant and the App Server verifies its effective policy',async()=>{
 const f=fixture();let grants=0;
 const denied=new DirectCoordinator({workspaces:{one:f.a},journalPath:join(f.base,'denied.sqlite'),adapterFactory:fakeFactory(),ownerAuthorization:()=>false});
 assert.throws(()=>denied.start({task_id:'write-denied',iteration:1,instruction:'write',execution_mode:'workspace_write'}),/DIRECT_OWNER_AUTHORIZATION_REQUIRED/);denied.close();
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,ownerAuthorization:()=>{grants++;return true;},adapterFactory:({projectRoot})=>new CodexAppServer(process.execPath,projectRoot,{args:[new URL('./fake-direct-app-server.mjs',import.meta.url).pathname]})});
 const started=c.start({task_id:'write-granted',iteration:1,instruction:'write only target',execution_mode:'workspace_write'});
 const result=await settled(c,{task_id:'write-granted',run_id:started.run_id});assert.equal(result.state,'COMPLETED');assert.equal(grants,1);
 assert.equal(readFileSync(join(f.a,'direct-target.txt'),'utf8'),'synthetic direct write\n');
 c.close();
});

test('read-only direct execution reaches the local fake App Server without creating a workspace file',async()=>{
 const f=fixture();
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,
  adapterFactory:({projectRoot})=>new CodexAppServer(process.execPath,projectRoot,{args:[new URL('./fake-direct-app-server.mjs',import.meta.url).pathname]})
 });
 try{
  const started=c.start({task_id:'direct-readonly-app-server',iteration:1,instruction:'Read only'});
  const result=await settled(c,{task_id:started.task_id,run_id:started.run_id});
  assert.equal(result.state,'COMPLETED');
  assert.equal(existsSync(join(f.a,'direct-target.txt')),false);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('crash recovery is UNKNOWN and an idempotent replay never executes again',async()=>{
 const f=fixture(),hanging=()=>({execute:async()=>{await pause(25);},disconnect:async()=>{}});
 const first=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:hanging});const started=first.start({task_id:'crash-run',iteration:1,instruction:'hang'});await pause(5);first.close();
 const next=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
 const replay=next.start({task_id:'crash-run',iteration:1,instruction:'hang'});assert.equal(replay.created,false);assert.equal(replay.state,'UNKNOWN');assert.equal(next.wait({task_id:'crash-run',run_id:started.run_id}).state,'UNKNOWN');next.close();await pause(30);
});

test('direct MCP tools are injected only by a trusted host and schemas reject unknown fields',async()=>{
 const f=fixture(),coordinator=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
 const s=makeServer({directCoordinator:coordinator}),c=new Client({name:'direct-mcp',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await Promise.all([s.connect(a),c.connect(b)]);const names=(await c.listTools()).tools.map(x=>x.name);assert.ok(names.includes('codex_turn_start')&&names.includes('codex_turn_wait'));
  const bad=await c.callTool({name:'codex_turn_start',arguments:{task_id:'schema-task',iteration:1,instruction:'x',root:'/nope'}});assert.equal(bad.isError,true);
  const twelve=await c.callTool({name:'codex_turn_start',arguments:{task_id:'schema-12k-task',iteration:1,instruction:'a'.repeat(12288),workspace_id:'one'}});assert.notEqual(twelve.isError,true);
  const tooLarge=await c.callTool({name:'codex_turn_start',arguments:{task_id:'schema-over-task',iteration:1,instruction:'a'.repeat(12289),workspace_id:'one'}});assert.equal(tooLarge.isError,true);
 }finally{await c.close();await s.close();coordinator.close();}
});

test('normal coordinator inventory remains the existing eight tools',async()=>{
 const coordinator={listProjects:()=>[],start:()=>({}),status:()=>({}),events:()=>[],result:()=>({}),stop:()=>({})};
 const s=makeServer({fixtureCoordinator:coordinator}),c=new Client({name:'eight-tools',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 try{await Promise.all([s.connect(a),c.connect(b)]);assert.deepEqual((await c.listTools()).tools.map(x=>x.name).sort(),['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop']);}
 finally{await c.close();await s.close();}
});

test('effective sandbox mismatch is rejected before any Codex turn starts',async()=>{
 const f=fixture();
 const mismatches=[
  {mode:'read_only',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}},
  {mode:'workspace_write',sandbox:{type:'readOnly',networkAccess:false}},
  {mode:'workspace_write',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[f.a],excludeTmpdirEnvVar:true,excludeSlashTmp:true}},
  {mode:'workspace_write',sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:false,excludeSlashTmp:true}}
 ];
 for(const scenario of mismatches){
  const adapter=new CodexAppServer('/usr/bin/false',f.a);
  let turnStarted=false;
  adapter.connect=async()=>({});
  adapter.rpc=async method=>{
   if(method==='thread/start')return {thread:{id:'synthetic-thread'},cwd:f.a,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:scenario.sandbox};
   turnStarted=true;throw Error('TURN_MUST_NOT_START');
  };
  await assert.rejects(()=>adapter.execute({projectRoot:f.a,prompt:'Verify effective sandbox only',executionMode:scenario.mode}),/CODEX_EFFECTIVE_POLICY_UNVERIFIED/);
  assert.equal(turnStarted,false,scenario.mode);
 }
});

test('closing during an active run marks it UNKNOWN and aborts its watchdog without replay',async()=>{
 const f=fixture();
 let disconnects=0;
 const coordinator=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,maxDurationMs:600000,
  adapterFactory:()=>({execute:()=>new Promise(()=>{}),disconnect:()=>{disconnects++;}})
 });
 try{
  const task=coordinator.start({task_id:'direct-close-abort',iteration:1,instruction:'synthetic hanging run'});
  await pause(10);
  coordinator.close();
  assert.ok(disconnects>0);
  const reopened=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
  const result=reopened.wait({task_id:'direct-close-abort',run_id:task.run_id});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.reasonCode,'DIRECT_HOST_CLOSED');
  assert.equal(result.providerFinished,false);
  assert.equal(reopened.start({task_id:'direct-close-abort',iteration:1,instruction:'synthetic hanging run'}).created,false);
  reopened.close();
  await pause(10);
 }finally{rmSync(f.base,{recursive:true,force:true});}
});

test('native direct route never accepts chappy-signal and keeps theo-lab read-only',()=>{
 const f=fixture();
 try{
  assert.throws(()=>new DirectCoordinator({workspaces:{'chappy-signal':f.a},journalPath:f.journal,adapterFactory:fakeFactory()}),/DIRECT_FORBIDDEN_NATIVE_PROJECT/);
  const c=new DirectCoordinator({workspaces:{'theo-lab':f.a},journalPath:f.journal,adapterFactory:fakeFactory(),ownerAuthorization:()=>true});
  try{
   assert.throws(()=>c.start({task_id:'native-lab-write',iteration:1,instruction:'do not write',execution_mode:'workspace_write'}),/DIRECT_LAB_READONLY/);
  }finally{c.close();}
 }finally{rmSync(f.base,{recursive:true,force:true});}
});

test('async owner approval returns promptly, starts no turn before approval, then rechecks and denies replay',async()=>{
 const f=fixture();let resolveApproval,calls=0,rechecks=0;
 const approval=new Promise(resolve=>{resolveApproval=resolve;});
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory(),
  ownerAuthorization:()=>approval,authorizationRecheck:()=>{rechecks++;return true;}});
 try{
  const started=c.start({task_id:'pending-write',iteration:1,instruction:'synthetic write',execution_mode:'workspace_write'});
  assert.equal(started.state,'APPROVAL_PENDING');assert.equal(calls,0);
  resolveApproval(true);await pause(25);
  assert.equal(c.wait({task_id:'pending-write',run_id:started.run_id}).state,'COMPLETED');assert.equal(rechecks,1);
  assert.equal(c.start({task_id:'pending-write',iteration:1,instruction:'synthetic write',execution_mode:'workspace_write'}).created,false);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('closing during pending physical approval aborts dialog and preserves UNKNOWN without Codex run',async()=>{
 const f=fixture();let aborted=false,executed=0;
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,
  ownerAuthorization:(_context,{signal})=>new Promise(resolve=>{
   signal.addEventListener('abort',()=>{aborted=true;resolve(false);},{once:true});
  }),
  adapterFactory:()=>{executed++;return fakeFactory()();}
 });
 try{
  const start=c.start({task_id:'pending-close-001',iteration:1,instruction:'approve a synthetic change',execution_mode:'workspace_write'});
  assert.equal(start.state,'APPROVAL_PENDING');
  c.close();
  await pause(12);
  assert.equal(aborted,true);
  assert.equal(executed,0);
  const recovered=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
  try{
   assert.equal(recovered.wait({task_id:start.task_id,run_id:start.run_id}).state,'UNKNOWN');
   assert.equal(recovered.start({task_id:start.task_id,iteration:1,instruction:'approve a synthetic change',execution_mode:'workspace_write'}).created,false);
  }finally{recovered.close();}
 }finally{rmSync(f.base,{recursive:true,force:true});}
});

test('adapter rejection becomes a sanitized persisted UNKNOWN diagnosis without provider completion',async()=>{
 const f=fixture();
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,
  adapterFactory:()=>({execute:async()=>{throw Error('secret token /private/path and prompt');},disconnect:async()=>{}})
 });
 try{
  const started=c.start({task_id:'direct-reject-001',iteration:1,instruction:'synthetic rejection'});
  const result=await settled(c,{task_id:started.task_id,run_id:started.run_id});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.reasonCode,'DIRECT_EXECUTION_UNVERIFIED');
  assert.equal(result.providerFinished,false);
  assert.doesNotMatch(JSON.stringify(result),/secret|private|prompt/i);
  c.close();
  const db=new DatabaseSync(f.journal);
  assert.equal(db.prepare('SELECT error_code FROM direct_runs WHERE task_id=?').get('direct-reject-001').error_code,'DIRECT_EXECUTION_UNVERIFIED');
  db.close();
 }finally{try{c.close();}catch{}rmSync(f.base,{recursive:true,force:true});}
});

test('allowlisted adapter timeout diagnosis is retained exactly',async()=>{
 const f=fixture();
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,
  adapterFactory:()=>({execute:async()=>{throw Error('CODEX_RPC_TIMEOUT');},disconnect:async()=>{}})
 });
 try{
  const started=c.start({task_id:'direct-rpc-timeout',iteration:1,instruction:'synthetic timeout'});
  const result=await settled(c,{task_id:started.task_id,run_id:started.run_id});
  assert.equal(result.reasonCode,'CODEX_RPC_TIMEOUT');
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('migrates an existing direct journal without rewriting its prior UNKNOWN diagnosis',()=>{
 const f=fixture(),db=new DatabaseSync(f.journal);
 try{
  db.exec("CREATE TABLE direct_runs (task_id TEXT NOT NULL, iteration INTEGER NOT NULL, workspace_id TEXT NOT NULL, mode TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,iteration));");
  db.prepare('INSERT INTO direct_runs VALUES(?,?,?,?,?,?,?,?,?)').run('old-unknown-001',1,'one','read_only','d'.repeat(64),'UNKNOWN',null,'2026-10-30T00:00:00.000Z','2026-10-30T00:00:00.000Z');
 }finally{db.close();}
 chmodSync(f.journal,0o600);
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,adapterFactory:fakeFactory()});
 try{
  const result=c.wait({task_id:'old-unknown-001',run_id:'old-unknown-001:1'});
  assert.equal(result.state,'UNKNOWN');
  assert.equal(result.result,null);
  assert.equal(result.reasonCode,null);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});

test('owner denial is not provider completion and has a safe diagnosis',async()=>{
 const f=fixture();
 const c=new DirectCoordinator({workspaces:{one:f.a},journalPath:f.journal,ownerAuthorization:async()=>false,adapterFactory:fakeFactory()});
 try{
  const started=c.start({task_id:'owner-denial-001',iteration:1,instruction:'synthetic write',execution_mode:'workspace_write'});
  const result=await settled(c,{task_id:started.task_id,run_id:started.run_id});
  assert.equal(result.state,'DENIED');
  assert.equal(result.reasonCode,'DIRECT_OWNER_DENIED');
  assert.equal(result.providerFinished,false);
 }finally{c.close();rmSync(f.base,{recursive:true,force:true});}
});
