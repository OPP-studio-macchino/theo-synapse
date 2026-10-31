import {spawn} from 'node:child_process';
import {reviewCodexRequest} from './direct-action-review.mjs';

const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const validId=x=>typeof x==='string'&&x.length>=1&&x.length<=256;
const textLimit=(x,bytes=12288)=>typeof x==='string'?Buffer.from(x).subarray(0,bytes).toString('utf8'):'';
// Keep remote error payloads private: diagnose only the protocol stage.
const rpcRejectCode=method=>({initialize:'CODEX_RPC_INITIALIZE_REJECTED','thread/start':'CODEX_RPC_THREAD_START_REJECTED','turn/start':'CODEX_RPC_TURN_START_REJECTED'}[method]??'CODEX_RPC_ERROR');
function sandboxValid(p){
 return object(p)&&p.type==='readOnly'&&(p.networkAccess===undefined||p.networkAccess===false)
   &&Object.keys(p).every(k=>['type','networkAccess'].includes(k));
}
function workspaceWriteSandboxValid(p){
 return object(p)&&p.type==='workspaceWrite'&&p.networkAccess===false&&
  Array.isArray(p.writableRoots)&&p.writableRoots.length===0&&
  p.excludeTmpdirEnvVar===true&&p.excludeSlashTmp===true&&
  Object.keys(p).every(k=>['type','networkAccess','writableRoots','excludeTmpdirEnvVar','excludeSlashTmp'].includes(k));
}
export class CodexAppServer {
 constructor(executable,cwd,opts={}){
  this.executable=executable;this.cwd=cwd;this.args=opts.args??['app-server','--listen','stdio://'];
  this.seq=0;this.pending=new Map();this.events=[];this.buffer='';
  this.child=null;this.dead=false;this.receivedBytes=0;this.frameCount=0;
  this.threadId=null;this.turnId=null;this.early=[];
  this.taskId=opts.taskId??null;this.ownerActionApproval=opts.ownerActionApproval??null;
  this.executionMode='read_only';this.reviewItems=new Map();this.approvalPending=false;
  this.actionAbort=new AbortController();
  this.onEvent=null;this.terminalResolve=null;this.terminalReject=null;this.finalText='';
  this.rpcTimeoutMs=opts.rpcTimeoutMs??5000;
  this.turnEffort=opts.turnEffort??null;
  if(this.turnEffort!==null&&!['low','medium','high'].includes(this.turnEffort))throw Error('INVALID_EFFORT');
 }
 send(obj){
  if(!this.child||this.dead||!this.child.stdin.writable)throw Error('CODEX_NOT_CONNECTED');
  const line=JSON.stringify(obj)+'\n';
  if(Buffer.byteLength(line)>16384)throw Error('REQUEST_TOO_LARGE');
  this.child.stdin.write(line);
 }
 fail(code){
  if(this.dead)return;
  this.dead=true;
  this.actionAbort.abort();
  for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error(code));}
  this.pending.clear();
  this.terminalReject?.(Error(code));
  this.child?.kill('SIGTERM');
 }
 ingest(chunk){
  if(this.dead)return;
  this.receivedBytes+=Buffer.byteLength(chunk);
  if(this.receivedBytes>2*1024*1024)return this.fail('CODEX_STREAM_LIMIT');
  this.buffer+=chunk;
  if(Buffer.byteLength(this.buffer)>131072)return this.fail('CODEX_FRAME_LIMIT');
  let i;
  while((i=this.buffer.indexOf('\n'))!==-1){
   const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);
   if(++this.frameCount>10000)return this.fail('CODEX_EVENT_LIMIT');
   let msg;
   try{msg=JSON.parse(line);}catch{return this.fail('CODEX_BAD_JSON');}
   if(!object(msg))return this.fail('CODEX_BAD_MESSAGE');
   if(msg.id!==undefined&&typeof msg.method==='string'){
    // Server-initiated request is NEVER auto-approved. Only an exact, bounded
    // request may go through separate physical Mac Owner confirmation.
    void this.handleServerRequest(msg).catch(()=>this.fail('APPROVAL_REQUEST_DENIED'));
    continue;
   }
   if(typeof msg.id==='number'){
    const p=this.pending.get(msg.id);
    if(!p)continue;
    this.pending.delete(msg.id);clearTimeout(p.timer);
    if('error' in msg)p.reject(Error(p.rejectionCode));
    else if('result' in msg)p.resolve(msg.result);
    else p.reject(Error('CODEX_BAD_RESPONSE'));
    continue;
   }
   if(typeof msg.method==='string'){
    if(this.events.length>=100)this.events.shift();
    this.events.push({method:msg.method,at:new Date().toISOString()});
    if(this.terminalResolve&&!this.turnId){
      if(this.early.length>=100)return this.fail('CODEX_EARLY_EVENT_LIMIT');
      this.early.push(msg);
    }else this.notification(msg);
    continue;
   }
   return this.fail('CODEX_BAD_MESSAGE');
  }
 }
 async handleServerRequest(msg){
  if(this.dead)return;
  if(this.approvalPending||typeof this.ownerActionApproval!=='function'||this.actionAbort.signal.aborted){
   try{this.send({id:msg.id,error:{code:-32601,message:'Owner approval unavailable; denied'}});}catch{}
   return this.fail('APPROVAL_REQUEST_DENIED');
  }
  const params={request:msg,items:this.reviewItems,workspaceRoot:this.cwd,
   threadId:this.threadId,turnId:this.turnId,executionMode:this.executionMode,taskId:this.taskId};
  let review;
  try{review=reviewCodexRequest(params);}catch{}
  if(!review){
   try{this.send({id:msg.id,error:{code:-32601,message:'Not authorized; denied'}});}catch{}
   return this.fail('APPROVAL_REQUEST_DENIED');
  }
  this.approvalPending=true;
  try{
   // No task-level approval is reused: each Codex request gets a fresh Mac dialog.
   const approved=await this.ownerActionApproval(review,{signal:this.actionAbort.signal});
   if(this.dead)return;
   let again;
   try{again=reviewCodexRequest(params);}catch{}
   if(approved!==true||!again||again.digest!==review.digest){
    try{this.send({id:msg.id,result:{decision:'decline'}});}catch{}
    return this.fail('APPROVAL_REQUEST_DENIED');
   }
   // Never issue acceptForSession, execpolicy amendments, network or scope grants.
   this.reviewItems.delete(review.itemId);
   this.send({id:msg.id,result:{decision:'accept'}});
  }catch{
   if(!this.dead)this.fail('APPROVAL_REQUEST_DENIED');
  }finally{this.approvalPending=false;}
 }
 notification(msg){
  if(!this.turnId||!this.threadId)return;
  const p=msg.params;
  if(!object(p))return;
  const tokenId=p.turnId??p.turn?.id;
  if((p.threadId!==undefined&&p.threadId!==this.threadId)||(tokenId!==undefined&&tokenId!==this.turnId)){
   if(['turn/completed','item/completed','turn/diff/updated'].includes(msg.method))return this.fail('EVENT_ID_MISMATCH');
   return;
  }
  if(msg.method==='item/started'&&object(p.item)&&validId(p.item.id)&&
    ['fileChange','commandExecution'].includes(p.item.type)){
   if(this.reviewItems.size>=24)return this.fail('CODEX_EVENT_LIMIT');
   this.reviewItems.set(p.item.id,p.item);
  }
  if(msg.method==='item/completed'&&object(p.item)){
   if(validId(p.item.id))this.reviewItems.delete(p.item.id);
   const item=p.item;
   if(item.type==='agentMessage'&&typeof item.text==='string'){
    if(Buffer.byteLength(this.finalText)+Buffer.byteLength(item.text)>16384)return this.fail('RESULT_TOO_LARGE');
    this.finalText+=item.text+'\n';
    this.onEvent?.({kind:'progress',stage:'agent_message',text:textLimit(item.text)});
   }else if(item.type==='commandExecution'){
    this.onEvent?.({kind:'progress',stage:'command_report',text:'Codex reported a command item; test success not independently verified'});
   }
  }
  if(msg.method==='item/agentMessage/delta'&&typeof p.delta==='string')
   this.onEvent?.({kind:'progress',stage:'agent_delta',text:textLimit(p.delta,1024)});
  if(msg.method==='turn/diff/updated'&&typeof p.diff==='string')
   this.onEvent?.({kind:'progress',stage:'diff_report',text:textLimit(p.diff,2048)});
  if(msg.method==='turn/completed'){
   if(!object(p.turn)||p.turn.id!==this.turnId)return this.fail('INVALID_TURN_TERMINAL');
   const status=p.turn.status;
   if(!['completed','failed','interrupted'].includes(status))return this.fail('INVALID_TURN_STATUS');
   this.onEvent?.({kind:'terminal',status,output:this.finalText.trimEnd()});
   this.terminalResolve?.();
   this.terminalResolve=null;this.terminalReject=null;
  }
 }
 rpc(method,params,timeout=this.rpcTimeoutMs){
  if(this.dead||!this.child)throw Error('CODEX_NOT_CONNECTED');
  const id=++this.seq;
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CODEX_RPC_TIMEOUT'));this.fail('CODEX_RPC_TIMEOUT');},timeout);
   this.pending.set(id,{resolve,reject,timer,rejectionCode:rpcRejectCode(method)});
   try{this.send({id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}
  });
 }
 async connect(){
  if(this.child)throw Error('ALREADY_CONNECTED');
  if(!this.executable?.startsWith('/')||!Array.isArray(this.args)||this.args.some(a=>typeof a!=='string'||a.includes('\0')))
   throw Error('INVALID_EXECUTABLE');
  this.child=spawn(this.executable,this.args,{
   cwd:this.cwd,stdio:['pipe','pipe','pipe'],shell:false,
   env:{PATH:process.env.PATH??'/usr/bin:/bin',HOME:process.env.HOME??'',LANG:'C.UTF-8'}
  });
  this.child.stderr.resume(); // stderr might contain secrets
  this.child.stdout.setEncoding('utf8');
  this.child.stdout.on('data',chunk=>{try{this.ingest(chunk);}catch{this.fail('CODEX_STREAM_ERROR');}});
  this.child.on('error',()=>this.fail('CODEX_SPAWN_ERROR'));
  this.child.on('close',()=>{this.child=null;if(!this.dead)this.fail('CODEX_DISCONNECTED');});
  const response=await this.rpc('initialize',{clientInfo:{name:'theo-synapse',title:'Theo Synapse',version:'0.0.5'}});
  this.send({method:'initialized',params:{}});
  return response;
 }
 async execute({projectRoot,prompt,onEvent,executionMode='read_only'}){
  if(projectRoot!==this.cwd||typeof prompt!=='string'||Buffer.byteLength(prompt)>12288||prompt.length===0)throw Error('INVALID_EXECUTION_CONTEXT');
  if(!['read_only','workspace_write'].includes(executionMode))throw Error('INVALID_EXECUTION_MODE');
  const writable=executionMode==='workspace_write';
  this.onEvent=onEvent;this.executionMode=executionMode;
  const completed=new Promise((resolve,reject)=>{this.terminalResolve=resolve;this.terminalReject=reject;});
  completed.catch(()=>{}); // A pre-turn failure may reject before the terminal is awaited.
  try{
   await this.connect();
   const thread=await this.rpc('thread/start',{
    cwd:this.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:writable?'workspace-write':'read-only',
    developerInstructions:writable?
     'You are an Owner-authorized workspace worker. Work only inside the current workspace. Network access is disabled. Do not access files outside this workspace, home directories, credentials, or secrets. Additional Codex tool approval requests must be reviewed separately by the physical Mac Owner, one action at a time. Never assume approval, and never request sandbox escalation, network access, or persistent grants.':
     'You are a strictly READ-ONLY project review worker. Access only ordinary files inside the current working directory. Do not inspect files outside this workspace, home directories, passwords, keys or user credentials. Do not edit, create, delete, install packages, invoke Git mutations, connect to any network endpoint, or request additional permissions. If the task requires any of these actions, clearly explain the limitation instead. Respond with a short factual answer based on inspected workspace files.',
    ephemeral:true,serviceName:'theo-synapse',
    config:{
     'features.exec_permission_approvals':true,
     'features.default_mode_request_user_input':true,
     'sandbox_workspace_write.writable_roots':[],
     'sandbox_workspace_write.network_access':false,
     'sandbox_workspace_write.exclude_tmpdir_env_var':true,
     'sandbox_workspace_write.exclude_slash_tmp':true
    }
   });
   const effectiveSandboxOK=writable
    ? workspaceWriteSandboxValid(thread?.sandbox,this.cwd)
    : sandboxValid(thread?.sandbox);
   if(!object(thread)||!object(thread.thread)||!validId(thread.thread.id)||thread.cwd!==this.cwd||
      thread.approvalPolicy!=='on-request'||thread.approvalsReviewer!=='user'||!effectiveSandboxOK)
    throw Error('CODEX_EFFECTIVE_POLICY_UNVERIFIED');
   this.threadId=thread.thread.id;
   const turn=await this.rpc('turn/start',{
    threadId:this.threadId,cwd:this.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',
    sandboxPolicy:writable?{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false},
    ...(this.turnEffort?{effort:this.turnEffort}:{}),input:[{type:'text',text:prompt}]
   });
   if(!object(turn)||!object(turn.turn)||!validId(turn.turn.id))throw Error('CODEX_TURN_ID_MISSING');
   this.turnId=turn.turn.id;
   for(const ev of this.early)this.notification(ev);
   this.early=[];
   await completed;
  }catch(e){this.fail('CODEX_EXECUTION_UNVERIFIED');throw e;}
 }
 async stop(){
  if(!this.threadId||!this.turnId)throw Error('NO_TURN_TO_INTERRUPT');
  await this.rpc('turn/interrupt',{threadId:this.threadId,turnId:this.turnId});
  // An RPC ACK is NOT proof the provider has stopped. Wait for turn/completed.
 }
 disconnect(){this.fail('CODEX_CLIENT_DISCONNECTED');}
}
