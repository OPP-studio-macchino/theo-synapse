// Manual, opt-in acceptance only: real Codex against disposable private fixtures.
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmodSync,mkdtempSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {planDirectWorkspace,registerDirectWorkspace} from '../src/direct-workspace-registry.mjs';
import {createOwnerApprovedDirectCoordinator} from '../src/direct-native-factory.mjs';
import {requestDirectWriteApproval,requestDirectRegistrationApproval} from '../src/direct-owner-approval.mjs';
import {startTaskDaemon} from '../src/task-daemon.mjs';
import {TaskBridge} from '../src/task-bridge.mjs';
import {makeServer} from '../src/mcp.mjs';
import {findCodexExecutable} from '../src/codex-binary.mjs';

const physical=process.argv.length===3&&process.argv[2]==='--explicit-physical-disposable-e2e';
const verifyNode=process.argv.length===3&&process.argv[2]==='--explicit-node-verification-e2e';
const enabled=physical||verifyNode||(process.argv.length===3&&process.argv[2]==='--explicit-disposable-e2e');
if(!enabled){
 console.log(JSON.stringify({pass:false,refused:true}));
 process.exitCode=2;
}else{
 let root,source,daemon,server,client,stage='FIXTURE';
 try{
  root=mkdtempSync('/private/tmp/theo-direct-real-ipc-');chmodSync(root,0o700);
  source=mkdtempSync('/private/tmp/theo-direct-real-source-');chmodSync(source,0o700);
  const runtime=join(root,'.local','theo-runtime');
  const snapshot=join(runtime,'projects','theo-lab');
  for(const directory of [join(root,'.local'),runtime,join(runtime,'projects'),snapshot]){
   mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  }
  writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:{'theo-lab':snapshot}}),{mode:0o600});
  writeFileSync(join(snapshot,'proof.js'),'export const VALUE = 1;\n',{mode:0o600});
  writeFileSync(join(source,'proof.js'),'export const VALUE = 1;\n',{mode:0o600});
  const snapshotBefore=readFileSync(join(snapshot,'proof.js'),'utf8');
  const sourceBefore=readdirSync(source).length===1;
  const workspaceId='directfixture';
  stage='REGISTER_PLAN';
  const registration=planDirectWorkspace({standaloneRoot:root,sourcePath:resolve(source),id:workspaceId});
  let registrationApproved=false,ownerApproved=false;
  registerDirectWorkspace({standaloneRoot:root,plan:registration,confirm:registration.confirmation,
   approveOwner:context=>{
    const scoped=context.id===workspaceId&&context.source===resolve(source);
    registrationApproved=scoped&&(physical?requestDirectRegistrationApproval(context):true);
    return registrationApproved;},assertIdle:()=>{}});
  const taskId=`direct-e2e-${randomUUID().replaceAll('-','')}`;
  const instruction=verifyNode?
   'Change only proof.js from export const VALUE = 1; to export const VALUE = 2;. Then run Node.js to import proof.js and verify VALUE is the numeric value 2. Do not create any other file, access the network, or request extra permissions; report the command and observed result.' :
   'In proof.js change only VALUE = 1 to VALUE = 2. Do not add any other file, network operation, or test action. Report completion briefly.';
  const digest=createHash('sha256').update(JSON.stringify({workspace:workspaceId,instruction,execution_mode:'workspace_write',iteration:1})).digest('hex');
  stage='DAEMON';
  daemon=await startTaskDaemon({root,maxDurationMs:60000,directCoordinatorFactory:({journalPath})=>
   createOwnerApprovedDirectCoordinator({root,journalPath,codexExecutable:findCodexExecutable(),
    ownerApproval:(context,options)=>{
     const scoped=context.taskId===taskId&&context.iteration===1&&context.workspaceId===workspaceId&&
      context.workspaceRoot===resolve(source)&&context.instructionDigest===digest;
     if(!scoped)return false;
     if(!physical){ownerApproved=true;return true;}
     return requestDirectWriteApproval(context,options).then(value=>{
      ownerApproved=value===true;return ownerApproved;
     });
    }})});
  const bridge=new TaskBridge({root,autostart:false});
  server=makeServer({workspace:root,codexPath:findCodexExecutable(),remoteCoordinator:bridge,
   directCoordinator:{start:request=>bridge.directStart(request),wait:request=>bridge.directWait(request)}});
  stage='MCP_CONNECT';
  client=new Client({name:'theo-direct-real-ipc-e2e',version:'1'});
  const [inbound,outbound]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(inbound),client.connect(outbound)]);
  const tools=(await client.listTools()).tools;
  const names=tools.map(tool=>tool.name).sort();
  const expected=['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop','codex_turn_start','codex_turn_wait'].sort();
  const startTool=tools.find(tool=>tool.name==='codex_turn_start');
  const toolsOk=JSON.stringify(names)===JSON.stringify(expected)&&JSON.stringify(startTool?.annotations)===JSON.stringify({readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false});
  const invalid=await client.callTool({name:'codex_turn_start',arguments:{task_id:'invalid-e2e-task',iteration:1,instruction:'do nothing',workspace_id:'missing',execution_mode:'workspace_write'}});
  const arbitrary=await client.callTool({name:'codex_turn_start',arguments:{task_id:'path-e2e-task',iteration:1,instruction:'do nothing',workspace_id:workspaceId,execution_mode:'workspace_write',root:'/private/tmp'}});
  const rejected=invalid.isError===true&&arbitrary.isError===true&&!ownerApproved;
  stage='DIRECT_START';
  const started=await client.callTool({name:'codex_turn_start',arguments:{task_id:taskId,iteration:1,instruction,workspace_id:workspaceId,execution_mode:'workspace_write'}});
  if(started.isError)throw Error('START_FAILED');
  const start=JSON.parse(started.content[0].text);let result;
  stage='DIRECT_WAIT';
  for(let i=0;i<90;i++){
   const waited=await client.callTool({name:'codex_turn_wait',arguments:{task_id:taskId,run_id:start.run_id,workspace_id:workspaceId}});
   if(waited.isError)throw Error('WAIT_FAILED');
   result=JSON.parse(waited.content[0].text);
   if(result.state!=='APPROVAL_PENDING'&&result.state!=='QUEUED'&&result.state!=='RUNNING')break;
   await pause(1000);
  }
  stage='ASSERT_RESULT';
  const completed=result?.state==='COMPLETED'&&typeof result.result==='string'&&result.result.length>0;
  const sourceOk=sourceBefore&&readFileSync(join(source,'proof.js'),'utf8')==='export const VALUE = 2;\n'&&readdirSync(source).length===1;
  const snapshotOk=readFileSync(join(snapshot,'proof.js'),'utf8')===snapshotBefore;
  const checked=verifyNode?spawnSync(process.execPath,['--input-type=module','-e','import("./proof.js").then(m=>{if(m.VALUE!==2)process.exitCode=1;else console.log("VALUE_OK");}).catch(()=>{process.exitCode=1;})'],{cwd:source,timeout:3000,encoding:'utf8'}):null;
  const hostNodeVerified=verifyNode?checked.status===0&&checked.stdout.trim()==='VALUE_OK':null;
  const pass=toolsOk&&rejected&&registrationApproved&&ownerApproved&&completed&&sourceOk&&snapshotOk&&(!verifyNode||hostNodeVerified);
  console.log(JSON.stringify({pass,physical,verifyNode,tools:toolsOk,rejected,registrationApproved,ownerApproved,completed,reasonCode:result?.reasonCode??null,source:sourceOk,snapshot:snapshotOk,hostNodeVerified}));
  if(!pass)process.exitCode=1;
 }catch(e){
  const reason=/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message??'')?e.message:'UNVERIFIED';
  console.log(JSON.stringify({pass:false,stage,reason}));
  process.exitCode=1;
 }finally{
  try{await client?.close();}catch{}
  try{await server?.close();}catch{}
  try{await daemon?.stop();}catch{}
  try{if(root)rmSync(root,{recursive:true,force:true});}catch{}
  try{if(source)rmSync(source,{recursive:true,force:true});}catch{}
 }
}
