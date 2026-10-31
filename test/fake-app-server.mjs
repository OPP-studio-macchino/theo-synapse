// Isolated deterministic JSON-RPC fixture. NOT Codex. No model or filesystem modifications.
import readline from 'node:readline';
const mode=process.argv[2]??'completed';
const line=x=>process.stdout.write(JSON.stringify(x)+'\n');
let initialized=false, thread=false, turn=false, stopped=false;
const done=(status='completed',turnId='turn-fixture')=>{
 if(stopped)return;
 stopped=true;line({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:turnId,status,items:[]}}});
};
const progress=()=>{
 line({method:'item/completed',params:{
  threadId:'thread-fixture',turnId:'turn-fixture',completedAtMs:Date.now(),
  item:{type:'agentMessage',id:'message-fixture',text:'Synthetic Codex result, token=sk\u002dproj-THEO_PUBLIC_SYNTHETIC_001_AAAAAAAAAAAAAAAAAAAAAAAA'}
 }});
 line({method:'turn/diff/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',
  diff:'FAKE DIFF: no file content was modified'}});
};
readline.createInterface({input:process.stdin}).on('line',raw=>{
 let m;try{m=JSON.parse(raw);}catch{process.exitCode=1;return;}
 if(m.method==='initialize'){
  line({id:m.id,result:{userAgent:'synthetic App Server',platformOs:'darwin'}});
  return;
 }
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized){process.exit(1);return;}
 if(m.method==='thread/start'){
  if(m.params.sandbox!=='read-only'||m.params.approvalPolicy!=='on-request'||
   m.params.approvalsReviewer!=='user'){process.exit(2);return;}
  thread=true;
  line({id:m.id,result:{thread:{id:'thread-fixture'},cwd:m.params.cwd,
   approvalPolicy:'on-request',approvalsReviewer:'user',
   sandbox:mode==='bad-policy'?{type:'dangerFullAccess'}:{type:'readOnly',networkAccess:false}}});
  return;
 }
 if(m.method==='turn/start'){
  if(!thread||m.params.sandboxPolicy?.type!=='readOnly'||m.params.sandboxPolicy.networkAccess!==false||
     m.params.input?.[0]?.type!=='text'){process.exit(3);return;}
  turn=true;
  line({id:m.id,result:{turn:{id:'turn-fixture',status:'inProgress'}}});
  if(mode==='approval'){
   setTimeout(()=>line({id:12345,method:'item/commandExecution/requestApproval',params:{threadId:'thread-fixture',turnId:'turn-fixture'}}),10);
   return;
  }
  if(mode==='disconnected'){setTimeout(()=>process.exit(0),20);return;}
  if(mode==='never'||mode==='interrupt')return;
  setTimeout(()=>{
   progress();
   if(mode==='foreign-turn')done('completed','bad-turn');
   else if(mode==='failed')done('failed');
   else done('completed');
  },25);
  return;
 }
 if(m.method==='turn/interrupt'){
  if(!turn||m.params.threadId!=='thread-fixture'||m.params.turnId!=='turn-fixture'){process.exit(4);return;}
  line({id:m.id,result:{}});
  if(mode!=='never')setTimeout(()=>done('interrupted'),20);
  return;
 }
 if(m.id===12345&&m.error)return;
 line({id:m.id,error:{code:-32601,message:'unsupported'}});
});
