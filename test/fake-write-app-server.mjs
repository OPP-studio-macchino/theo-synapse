// Simulated Codex App Server for isolated write-contract validation.
// THIS IS NOT A MODEL; it only modifies throwaway candidate files in tests.
import {createInterface} from 'node:readline';
import {writeFileSync,readFileSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
const mode=process.argv[2]??'allowed';
const root=process.cwd();
if(!root.includes('/write-candidates/'))process.exit(71);
let initialized=false,thread=false;
const response=o=>process.stdout.write(JSON.stringify(o)+'\n');
const content=join(root,'extension','popup.js');
createInterface({input:process.stdin}).on('line',raw=>{
 let m;try{m=JSON.parse(raw);}catch{process.exit(72);return;}
 if(m.method==='initialize'){
  response({id:m.id,result:{userAgent:'fake-write-app-server',platformOs:'darwin'}});return;
 }
 if(m.method==='initialized'){initialized=true;return;}
 if(!initialized){process.exit(73);return;}
 if(m.method==='thread/start'){
  if(m.params.sandbox!=='workspace-write'||m.params.approvalPolicy!=='on-request'||
     m.params.approvalsReviewer!=='user'||m.params.cwd!==root||
     !m.params.developerInstructions.includes('extension/popup.js')){process.exit(74);return;}
  thread=true;
  response({id:m.id,result:{thread:{id:'fake-write-thread'},cwd:root,
   approvalPolicy:'on-request',approvalsReviewer:'user',
   sandbox:mode==='bad-policy'?{type:'dangerFullAccess'}:
    {type:'workspaceWrite',networkAccess:false,writableRoots:[root]}}});
  return;
 }
 if(m.method==='turn/start'){
  if(!thread||m.params.sandboxPolicy?.type!=='workspaceWrite'||
     m.params.sandboxPolicy?.networkAccess!==false||
     m.params.sandboxPolicy?.excludeSlashTmp!==true||
     m.params.sandboxPolicy?.excludeTmpdirEnvVar!==true||
     m.params.sandboxPolicy?.writableRoots?.[0]!==root){process.exit(75);return;}
  response({id:m.id,result:{turn:{id:'fake-write-turn',status:'inProgress'}}});
  if(mode==='approval-request'){
   setTimeout(()=>response({id:90210,method:'item/commandExecution/requestApproval',params:{
    threadId:'fake-write-thread',turnId:'fake-write-turn'
   }}),15);
   return;
  }
  if(mode==='missing-terminal')return;
  setTimeout(()=>{
   try{
    if(mode==='allowed'){
     writeFileSync(content,'export const LABEL = "AFTER";\n');
    }else if(mode==='foreign-file'){
     writeFileSync(join(root,'README.md'),'An unauthorized change\n');
    }else if(mode==='symlink'){
     unlinkSync(content);
     symlinkSync(join(root,'README.md'),content);
    }
    response({method:'item/completed',params:{threadId:'fake-write-thread',
     turnId:'fake-write-turn',item:{type:'agentMessage',text:'Synthetic candidate edit completed'}}});
    response({method:'turn/completed',params:{threadId:'fake-write-thread',
     turn:{id:'fake-write-turn',status:mode==='failed'?'failed':'completed'}}});
   }catch{process.exit(76);}
  },20);
  return;
 }
 if(m.id===90210&&m.error){process.exit(77);return;}
 response({id:m.id,error:{code:-32601,message:'unsupported'}});
});
