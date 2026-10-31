// Deterministic App Server fixture. It is not a model and only writes its disposable cwd.
import readline from 'node:readline';
import {writeFileSync} from 'node:fs';
const line=value=>process.stdout.write(JSON.stringify(value)+'\n');let initialized=false,thread=false;
readline.createInterface({input:process.stdin}).on('line',raw=>{
 const m=JSON.parse(raw);
 if(m.method==='initialize')return line({id:m.id,result:{serverInfo:{name:'fake-direct'}}});
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized)return process.exit(2);
 if(m.method==='thread/start'){
  if(!['workspace-write','read-only'].includes(m.params.sandbox)||m.params.approvalPolicy!=='on-request'||m.params.approvalsReviewer!=='user')return process.exit(3);
  thread=m.params.sandbox;return line({id:m.id,result:{thread:{id:'direct-thread'},cwd:m.params.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:thread==='workspace-write'?{type:'workspaceWrite',networkAccess:false,writableRoots:[],excludeTmpdirEnvVar:true,excludeSlashTmp:true}:{type:'readOnly',networkAccess:false}}});
 }
 if(m.method==='turn/start'){
  if(!thread)return process.exit(4);
  if(thread==='workspace-write'&&(m.params.sandboxPolicy?.type!=='workspaceWrite'||m.params.sandboxPolicy.networkAccess!==false||m.params.sandboxPolicy.writableRoots?.length!==0||m.params.sandboxPolicy.excludeTmpdirEnvVar!==true||m.params.sandboxPolicy.excludeSlashTmp!==true))return process.exit(4);
  if(thread==='read-only'&&(m.params.sandboxPolicy?.type!=='readOnly'||m.params.sandboxPolicy.networkAccess!==false))return process.exit(4);
  if(thread==='workspace-write')writeFileSync(m.params.cwd+'/direct-target.txt','synthetic direct write\n',{mode:0o600});
  line({id:m.id,result:{turn:{id:'direct-turn'}}});
  return setTimeout(()=>line({method:'turn/completed',params:{threadId:'direct-thread',turn:{id:'direct-turn',status:'completed'}}}),5);
 }
 if(m.id!==undefined)line({id:m.id,error:{code:-32601,message:'unsupported'}});
});
