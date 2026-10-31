import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,cpSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {createOwnerApprovedDirectCoordinator} from '../src/direct-native-factory.mjs';
import {planDirectWorkspace,registerDirectWorkspace} from '../src/direct-workspace-registry.mjs';
import {FixtureCodexAdapter} from './fixture-adapter.mjs';

const sourceRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
const eight=[
 'standalone_capabilities','standalone_codex_probe','standalone_list_projects',
 'standalone_task_events','standalone_task_result','standalone_task_start',
 'standalone_task_status','standalone_task_stop'
].sort();
const ten=[...eight,'codex_turn_start','codex_turn_wait'].sort();

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-direct-stdio-');chmodSync(root,0o700);
 const runtime=join(root,'.local','theo-runtime'),projects=join(runtime,'projects'),project=join(projects,'fixture');
 for(const dir of [runtime,projects,project])mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:{fixture:project}}),{mode:0o600});
 cpSync(join(sourceRoot,'src'),join(root,'src'),{recursive:true});
 mkdirSync(join(root,'scripts'),{mode:0o700});
 cpSync(join(sourceRoot,'scripts','theo-task-entry.mjs'),join(root,'scripts','theo-task-entry.mjs'));
 mkdirSync(join(root,'assets'),{mode:0o700});
 cpSync(join(sourceRoot,'assets','theo-synapse-icon-64.png'),join(root,'assets','theo-synapse-icon-64.png'));
 cpSync(join(sourceRoot,'package.json'),join(root,'package.json'));
 symlinkSync(join(sourceRoot,'node_modules'),join(root,'node_modules'));
 const directSource=mkdtempSync('/private/tmp/theo-direct-stdio-source-');chmodSync(directSource,0o700);
 const plan=planDirectWorkspace({standaloneRoot:root,sourcePath:directSource,id:'directfixture'});
 registerDirectWorkspace({standaloneRoot:root,plan,confirm:plan.confirmation,approveOwner:()=>true,assertIdle:()=>{}});
 return {root,runtime,project,directSource};
}
function client(root){
 const mcp=new Client({name:'direct-stdio-gate',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'scripts','theo-task-entry.mjs')],cwd:root,
  env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin',THEO_SCHEMA_PROBE:'1'}});
 return {mcp,transport};
}
async function listed(root){
 const {mcp,transport}=client(root);
 try{
  await mcp.connect(transport);
  return {mcp,tools:(await mcp.listTools()).tools};
 }catch(error){
  await mcp.close().catch(()=>{});
  throw error;
 }
}
async function settled(mcp,started){
 for(let i=0;i<50;i++){
  const response=await mcp.callTool({name:'codex_turn_wait',arguments:{task_id:started.task_id,run_id:started.run_id,workspace_id:'directfixture'}});
  const value=JSON.parse(response.content[0].text);
  if(value.state!=='QUEUED'&&value.state!=='RUNNING')return value;
  await pause(10);
 }
 throw Error('DIRECT_STDIO_DID_NOT_SETTLE');
}

test('stdio discovery exposes direct tools only for an opted-in local daemon',async()=>{
 const f=fixture();let daemon;
 try{
  daemon=await startTaskDaemon({root:f.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000});
  let session=await listed(f.root);
  try{assert.deepEqual(session.tools.map(tool=>tool.name).sort(),eight);}
  finally{await session.mcp.close();}
  await daemon.stop();daemon=null;

  daemon=await startTaskDaemon({root:f.root,adapterFactory:()=>new FixtureCodexAdapter(),maxDurationMs:1000,
   directCoordinatorFactory:({journalPath})=>createOwnerApprovedDirectCoordinator({root:f.root,journalPath,ownerApproval:()=>false,
    adapterFactory:()=>({async execute({onEvent}){onEvent({kind:'terminal',status:'completed',output:'synthetic direct stdio'});},async disconnect(){}})
   })
  });
  session=await listed(f.root);
  try{
   assert.deepEqual(session.tools.map(tool=>tool.name).sort(),ten);
   const start=session.tools.find(tool=>tool.name==='codex_turn_start');
   const wait=session.tools.find(tool=>tool.name==='codex_turn_wait');
   assert.deepEqual(start.annotations,{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
   assert.deepEqual(wait.annotations,{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false});
   assert.deepEqual(Object.keys(start.inputSchema.properties).sort(),['execution_mode','instruction','iteration','task_id','workspace_id']);
   assert.deepEqual(Object.keys(wait.inputSchema.properties).sort(),['run_id','task_id','workspace_id']);
   const bad=await session.mcp.callTool({name:'codex_turn_start',arguments:{task_id:'direct-stdio-0001',iteration:1,instruction:'Read synthetic fixture',workspace_id:'directfixture',root:'/private/tmp',cwd:'/',command:'anything'}});
   assert.equal(bad.isError,true);
   const response=await session.mcp.callTool({name:'codex_turn_start',arguments:{task_id:'direct-stdio-0001',iteration:1,instruction:'Read synthetic fixture',workspace_id:'directfixture',execution_mode:'read_only'}});
   assert.notEqual(response.isError,true); // MCP omits isError on success.
   const done=await settled(session.mcp,JSON.parse(response.content[0].text));
   assert.equal(done.state,'COMPLETED');assert.equal(done.execution_mode,'read_only');
   const denied=await session.mcp.callTool({name:'codex_turn_start',arguments:{task_id:'direct-stdio-0002',iteration:1,instruction:'Synthetic write request',workspace_id:'directfixture',execution_mode:'workspace_write'}});
   assert.equal(denied.isError,true);assert.match(denied.content[0].text,/DIRECT_OWNER_AUTHORIZATION_REQUIRED/);
  }finally{await session.mcp.close();}
 }finally{
  await daemon?.stop();
  rmSync(f.root,{recursive:true,force:true});rmSync(f.directSource,{recursive:true,force:true});
 }
});
