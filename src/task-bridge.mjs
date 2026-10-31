import {connect} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdirSync,rmdirSync,openSync,closeSync,constants} from 'node:fs';
import {resolve,join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';

const isMissing=e=>['ENOENT','ECONNREFUSED','EPIPE'].includes(e?.code)||e?.message==='TASK_DAEMON_NOT_RUNNING';
function exchange(path,message,timeout=8000){
 return new Promise((resolve,reject)=>{
  let finished=false,buf='';
  const socket=connect({path});
  const complete=(e,result)=>{
   if(finished)return;finished=true;
   socket.destroy();
   if(e)reject(e);else resolve(result);
  };
  socket.setEncoding('utf8');
  socket.setTimeout(timeout,()=>complete(Error('TASK_DAEMON_TIMEOUT')));
  socket.once('error',e=>{
   const error=Error(isMissing(e)?'TASK_DAEMON_NOT_RUNNING':'TASK_DAEMON_IO_FAILED');
   error.code=e?.code;
   complete(error);
  });
  socket.once('connect',()=>{
   try{socket.write(JSON.stringify(message)+'\n');}
   catch{complete(Error('TASK_DAEMON_WRITE_FAILED'));}
  });
  socket.on('data',chunk=>{
   if(finished)return;
   buf+=chunk;
   if(Buffer.byteLength(buf)>131072)return complete(Error('TASK_DAEMON_RESPONSE_TOO_LARGE'));
   const index=buf.indexOf('\n');
   if(index===-1)return;
   try{
    const result=JSON.parse(buf.slice(0,index));
    if(result.ok!==true){
     const err=Error(typeof result.error==='string'?result.error:'TASK_DAEMON_BAD_RESPONSE');
     return complete(err);
    }
    complete(null,result.value);
   }catch{complete(Error('TASK_DAEMON_INVALID_JSON'));}
  });
  socket.once('end',()=>complete(Error('TASK_DAEMON_DISCONNECTED')));
 });
}
export class TaskBridge {
 constructor({root,autostart=true,timeout=9000}={}){
  if(typeof root!=='string'||!root.startsWith('/'))throw Error('INVALID_STANDALONE_ROOT');
  this.root=resolve(root);
  this.socketPath=join(this.root,'.local','theo.sock');
  this.lockDir=join(this.root,'.local','theo-runtime','.launch-lock');
  this.autostart=autostart;
  this.timeout=timeout;
 }
 async _boot(){
  // Only the existing private Standalone runtime dir may contain this lock.
  let owner=false;
  try{mkdirSync(this.lockDir,{mode:0o700});owner=true;}
  catch(e){if(e.code!=='EEXIST')throw Error('TASK_DAEMON_BOOT_DENIED');}
  if(owner){
   try{
    const entry=join(this.root,'scripts','task-daemon-entry.mjs');
    const logPath=join(this.root,'.local','theo-runtime','daemon.log');
    const fd=openSync(logPath,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    try{
     const child=spawn(process.execPath,[entry],{
      cwd:this.root,detached:true,stdio:['ignore',fd,fd],shell:false,
      env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8'}
     });
     child.on('error',()=>{});child.unref();
    }finally{closeSync(fd);}
   }finally{rmdirSync(this.lockDir);}
  }
  for(let i=0;i<50;i++){
   await pause(100);
   try{return await exchange(this.socketPath,{action:'ping',args:{}},1800);}
   catch(e){if(!isMissing(e))throw e;}
  }
  throw Error('TASK_DAEMON_START_FAILED');
 }
 async call(action,args={}){
  const request={action,args};
  try{return await exchange(this.socketPath,request,this.timeout);}
  catch(e){
   if(!this.autostart||!isMissing(e))throw e;
   await this._boot();
   return await exchange(this.socketPath,request,this.timeout);
  }
 }
 listProjects(){return this.call('list_projects');}
 start(input){return this.call('task_start',input);}
 status(id){return this.call('task_status',{id});}
 events(id,after=0){return this.call('task_events',{id,after});}
 result(id){return this.call('task_result',{id});}
 stop(id){return this.call('task_stop',{id});}
 writePropose(request){return this.call('write_propose',request);}
 writeStatus(id){return this.call('write_status',{id});}
 writeEvents(id,after=0){return this.call('write_events',{id,after});}
 writeResult(id){return this.call('write_result',{id});}
 writeCancel(id){return this.call('write_cancel',{id});}
 directStart(request){return this.call('direct_start',request);}
 directWait(request){return this.call('direct_wait',request);}
 directCapabilities(){return this.call('direct_capabilities');}
 ping(){return this.call('ping');}
}
