import {createServer,connect} from 'node:net';
import {existsSync,lstatSync,chmodSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {CodexAppServer} from './codex-adapter.mjs';
import {findCodexExecutable} from './codex-binary.mjs';
import {TaskCoordinator} from './task-coordinator.mjs';
import {TaskStore} from './task-store.mjs';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';
import {CandidateWriteCoordinator} from './candidate-write-coordinator.mjs';
import {assertHostWriteGate} from './write-release.mjs';

const allowedActions=new Set(['ping','list_projects','task_start','task_status','task_events','task_result','task_stop',
 'write_propose','write_status','write_events','write_result','write_cancel',
 'direct_start','direct_wait','direct_capabilities']);
const safeError=e=>/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message??'')?e.message:'TASK_RUNTIME_ERROR';
const socketsAlive=async path=>new Promise(resolve=>{
 const peer=connect({path});
 peer.once('connect',()=>{peer.end();resolve(true);});
 peer.once('error',()=>resolve(false));
 peer.setTimeout(600,()=>{peer.destroy();resolve(false);});
});
async function ensureCleanSocket(path){
 if(!existsSync(path))return;
 const s=lstatSync(path);
 if(!s.isSocket()||s.uid!==process.getuid())throw Error('UNSAFE_EXISTING_SOCKET');
 if(await socketsAlive(path))throw Error('TASK_DAEMON_ALREADY_RUNNING');
 // Remove only a stale socket owned by the current user in the private dir.
 unlinkSync(path);
}
export async function startTaskDaemon({root,adapterFactory,maxDurationMs=60000,
 enableCandidateWrites=false,writeCoordinatorFactory=null,writePolicy=null,
 directCoordinatorFactory=null}={}){
 const registry=loadReadOnlyRegistry(root);
 // Reject a second daemon BEFORE its journal constructor can mark live jobs UNKNOWN.
 await ensureCleanSocket(registry.socketPath);
 const store=new TaskStore(registry.journalPath);
 const factory=adapterFactory??(({projectRoot})=>
   new CodexAppServer(findCodexExecutable(),projectRoot,{
      turnEffort:'low',rpcTimeoutMs:9000
   }));
 const coordinator=new TaskCoordinator({
   projects:registry.projects,store,adapterFactory:factory,maxDurationMs
 });
 // Explicit host-only feature gate: never set by a ChatGPT/MCP request.
 const activeWritePolicy=enableCandidateWrites&&!writeCoordinatorFactory?
   assertHostWriteGate(root,writePolicy):null;
 const writer=enableCandidateWrites?
   (writeCoordinatorFactory?writeCoordinatorFactory({root,readStore:store}):
     new CandidateWriteCoordinator({
       root,enabled:true,readStore:store,writePolicy:activeWritePolicy,
     reauthorize:()=>assertHostWriteGate(root,activeWritePolicy)
     })):null;
 // This is a trusted-native-host seam only. The normal entry point never passes
 // it, so it neither creates a direct database nor exposes direct IPC commands.
 let direct=null;
 try{
  direct=directCoordinatorFactory?directCoordinatorFactory({
    root,runtime:registry.runtime,workspaces:registry.projects,
    journalPath:join(registry.runtime,'direct.sqlite')
  }):null;
  if(direct&&(!['start','wait','close','hasActiveRun'].every(name=>typeof direct[name]==='function')))
    throw Error('DIRECT_COORDINATOR_INVALID');
 }catch(e){
  try{direct?.close();}catch{}
  coordinator.close();
  throw e;
 }
 const readTaskActive=()=>coordinator.store.db.prepare(
  "SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')"
 ).get().n>0;
 let closing=false;
 const directActive=()=>Boolean(direct?.hasActiveRun());
 const directEnabled=()=>Boolean(direct&&!closing);
 const rpc=async message=>{
  if(closing)throw Error('SERVER_SHUTTING_DOWN');
  if(!message||typeof message!=='object'||Array.isArray(message)||
     !allowedActions.has(message.action))throw Error('INVALID_ACTION');
  const arg=message.args??{};
  if(!arg||typeof arg!=='object'||Array.isArray(arg))throw Error('INVALID_ARGUMENTS');
  const refresh=()=>coordinator.refreshProjects(loadReadOnlyRegistry(root).projects);
  switch(message.action){
   // The private socket is shared by the two mutually-exclusive native hosts.
   // Report the actual host mode so a desktop manager never adopts a manual host.
   case 'ping': return {alive:true,mode:directEnabled()?'direct':'read_only',backend:'theo-task-daemon',version:'0.0.5'};
   case 'list_projects':refresh();return coordinator.listProjects();
   case 'task_start':
    if(writer?.hasActiveRequest())throw Error('WRITE_REQUEST_ACTIVE');
    if(directActive())throw Error('DIRECT_RUN_ACTIVE');
    // Close the race between an Owner import's final idle check and registry commit.
    if(existsSync(join(registry.runtime,'.registry-owner-lock'))||existsSync(join(registry.runtime,'.direct-workspace-owner-lock')))throw Error('OWNER_REGISTRY_UPDATE_ACTIVE');
    refresh();return coordinator.start(arg);
   case 'task_status':return coordinator.status(arg.id);
   case 'task_events':return coordinator.events(arg.id,arg.after??0);
   case 'task_result':return coordinator.result(arg.id);
   case 'task_stop':return coordinator.stop(arg.id);
   case 'write_propose':if(!writer)throw Error('WRITE_MODE_NOT_ENABLED');if(directActive())throw Error('DIRECT_RUN_ACTIVE');return writer.request(arg);
   case 'write_status':if(!writer)throw Error('WRITE_MODE_NOT_ENABLED');return writer.status(arg.id);
   case 'write_events':if(!writer)throw Error('WRITE_MODE_NOT_ENABLED');return writer.events(arg.id,arg.after??0);
   case 'write_result':if(!writer)throw Error('WRITE_MODE_NOT_ENABLED');return writer.result(arg.id);
   case 'write_cancel':if(!writer)throw Error('WRITE_MODE_NOT_ENABLED');return writer.cancel(arg.id);
   case 'direct_capabilities':return {enabled:directEnabled(),ownerApproval:'host_callback_required',
    workspaceWriteEnabled:false};
   case 'direct_start':
    if(!directEnabled())throw Error('DIRECT_MODE_NOT_ENABLED');
    if(readTaskActive())throw Error('READ_TASK_ACTIVE');
    if(writer?.hasActiveRequest())throw Error('WRITE_REQUEST_ACTIVE');
    if(existsSync(join(registry.runtime,'.registry-owner-lock'))||existsSync(join(registry.runtime,'.direct-workspace-owner-lock')))throw Error('OWNER_REGISTRY_UPDATE_ACTIVE');
    return direct.start(arg);
   case 'direct_wait':if(!directEnabled())throw Error('DIRECT_MODE_NOT_ENABLED');return direct.wait(arg);
  }
 };
 const sockets=new Set();
 const server=createServer({allowHalfOpen:false},socket=>{
   sockets.add(socket);
   socket.on('close',()=>sockets.delete(socket));
   socket.setTimeout(16000,()=>socket.destroy());
   let data='',answered=false;
   socket.setEncoding('utf8');
   socket.on('data',chunk=>{
    if(answered)return;
    data+=chunk;
    if(Buffer.byteLength(data)>18432){answered=true;socket.end(JSON.stringify({ok:false,error:'REQUEST_TOO_LARGE'})+'\n');return;}
    const end=data.indexOf('\n');
    if(end===-1)return;
    answered=true;
    let request;
    try{request=JSON.parse(data.slice(0,end));}
    catch{socket.end(JSON.stringify({ok:false,error:'INVALID_JSON'})+'\n');return;}
    Promise.resolve().then(()=>rpc(request)).then(value=>{
      const response=JSON.stringify({ok:true,value});
      if(Buffer.byteLength(response)>131072)
        socket.end(JSON.stringify({ok:false,error:'RESPONSE_TOO_LARGE'})+'\n');
      else socket.end(response+'\n');
    }).catch(e=>socket.end(JSON.stringify({ok:false,error:safeError(e)})+'\n'));
   });
 });
 try{
   await new Promise((resolve,reject)=>{
     server.once('error',reject);
     server.listen(registry.socketPath,()=>{server.off('error',reject);resolve();});
   });
   chmodSync(registry.socketPath,0o600);
 }catch(e){
  try{server.close();}catch{}
  coordinator.close();
  throw e;
 }
 const stop=async()=>{
  if(closing)return;
  closing=true;
  for(const [id,adapter] of coordinator.running){
   try{adapter.disconnect();}catch{}
   try{
    const state=coordinator.store.get(id)?.state;
    if(['RUNNING','STOP_REQUESTED'].includes(state))coordinator.store.transition(id,'UNKNOWN');
   }catch{}
  }
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(()=>resolve()));
  try{await writer?.close();}catch{}
  try{direct?.close();}catch{}
  try{coordinator.close();}catch{}
  try{
   const s=lstatSync(registry.socketPath);
   if(s.isSocket()&&s.uid===process.getuid())unlinkSync(registry.socketPath);
  }catch(e){if(e.code!=='ENOENT')throw e;}
 };
 return {runtime:registry.runtime,socketPath:registry.socketPath,coordinator,writer,direct,server,stop};
}
