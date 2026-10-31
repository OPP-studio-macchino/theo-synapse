// Synthetic App Server that requests Owner confirmation BEFORE changing one fake file.
// This fixture is NOT Codex and never touches any non-disposable directory.
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync} from 'node:fs';
const line=data=>process.stdout.write(JSON.stringify(data)+'\n');
let cwd=null,thread=null,turn=null,changeRequested=false;
createInterface({input:process.stdin}).on('line',raw=>{
 let msg;
 try{msg=JSON.parse(raw);}catch{process.exit(31);}
 if(msg.method==='initialize'){
  return line({id:msg.id,result:{serverInfo:{name:'fake-owner-request'}}});
 }
 if(msg.method==='initialized')return;
 if(msg.method==='thread/start'){
  const p=msg.params;
  if(p.sandbox!=='workspace-write'||p.approvalPolicy!=='on-request'||p.approvalsReviewer!=='user')return process.exit(32);
  cwd=p.cwd;thread='thread-synthetic-owner-01';
  return line({id:msg.id,result:{thread:{id:thread},cwd,approvalPolicy:'on-request',approvalsReviewer:'user',
   sandbox:{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}}});
 }
 if(msg.method==='turn/start'){
  if(!thread||!cwd)return process.exit(33);
  const p=msg.params;
  if(p.sandboxPolicy?.type!=='workspaceWrite'||p.sandboxPolicy.networkAccess!==false||p.sandboxPolicy.writableRoots?.length!==0)return process.exit(34);
  turn='turn-synthetic-owner-01';
  line({id:msg.id,result:{turn:{id:turn}}});
  return setTimeout(()=>{
   line({method:'item/started',params:{threadId:thread,turnId:turn,
    item:{id:'change-synthetic-01',type:'fileChange',status:'inProgress',changes:[{path:cwd+'/proof.js',kind:'update'}]}}});
   line({id:906,method:'item/fileChange/requestApproval',params:{threadId:thread,turnId:turn,
    itemId:'change-synthetic-01',grantRoot:cwd,availableDecisions:['accept','decline']}});
   changeRequested=true;
  },12);
 }
 if(msg.id===906&&changeRequested&&msg.result){
  const allowed=msg.result.decision==='accept';
  if(allowed){
   const file=cwd+'/proof.js';
   if(readFileSync(file,'utf8')!=='export const VALUE = 2;\n')return process.exit(35);
   writeFileSync(file,'export const VALUE = 3;\n',{mode:0o600});
  }
  line({method:'item/completed',params:{threadId:thread,turnId:turn,
   item:{id:'change-synthetic-01',type:'fileChange',status:allowed?'completed':'declined'}}});
  return setTimeout(()=>line({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:allowed?'completed':'interrupted'}}}),8);
 }
 if(msg.id!==undefined)return line({id:msg.id,error:{code:-32601,message:'unsupported fixture method'}});
});
