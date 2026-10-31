// Codex write-mode ONLY for an Owner-approved disposable candidate workspace.
// Never spawn against the Chappy Sound original or an authoritative project snapshot.
import {realpathSync} from 'node:fs';
import {CodexAppServer} from './codex-adapter.mjs';

const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const validId=v=>typeof v==='string'&&v.length>0&&v.length<257;
export class CodexCandidateWriteAdapter extends CodexAppServer{
 constructor(executable,cwd,{allowedFiles,turnEffort='low',...opts}={}){
  super(executable,cwd,{turnEffort,...opts});
  if(typeof cwd!=='string'||!cwd.includes('/write-candidates/')||
     realpathSync.native(cwd)!==cwd||!Array.isArray(allowedFiles)||
     allowedFiles.length<1||allowedFiles.length>3)
   throw Error('WRITE_ADAPTER_SCOPE_INVALID');
  this.allowedFiles=[...allowedFiles];
 }
 async execute({projectRoot,prompt,onEvent}={}){
  if(projectRoot!==this.cwd||typeof prompt!=='string'||!prompt.trim()||
     Buffer.byteLength(prompt)>512)
   throw Error('WRITE_EXECUTION_CONTEXT_INVALID');
  this.onEvent=onEvent;
  const terminal=new Promise((resolve,reject)=>{
   this.terminalResolve=resolve;this.terminalReject=reject;
  });
  terminal.catch(()=>{});
  const forbidden='Do not access other directories, secrets, network, Git, install dependencies, request permission changes, create new files, delete files, or modify any path outside the exact allowed filenames.';
  const developerInstructions=[
   'THEO SYNAPSE: ONE-TIME OWNER-AUTHORIZED ISOLATED CANDIDATE ONLY.',
   'This is not the original project and changes will NOT be applied to it.',
   'Change exactly the following existing files, if needed: '+this.allowedFiles.join(', '),
   forbidden,
   'Do not open, create, modify, or delete any other file in this candidate.',
   'If the requested change cannot be done within this scope, explain and stop.',
   'Do not invoke commands requiring elevated permissions. Avoid network operations.',
   'Make the smallest change possible and summarize it briefly.'
  ].join(' ');
  try{
   await this.connect();
   const thread=await this.rpc('thread/start',{
    cwd:this.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',
    sandbox:'workspace-write',developerInstructions,
    ephemeral:true,serviceName:'theo-synapse-write-candidate'
   });
   if(!object(thread)||!object(thread.thread)||!validId(thread.thread.id)||
      thread.cwd!==this.cwd||thread.approvalPolicy!=='on-request'||
      thread.approvalsReviewer!=='user'||!object(thread.sandbox)||
      thread.sandbox.type!=='workspaceWrite'||thread.sandbox.networkAccess!==false||
      (thread.sandbox.writableRoots??[]).some(root=>root!==this.cwd))
    throw Error('CODEX_WRITE_POLICY_UNVERIFIED');
   this.threadId=thread.thread.id;
   const fullPrompt=[
    'Owner-authorized candidate change:',
    prompt,
    'Allowed file paths: '+this.allowedFiles.join(', '),
    'Modify those existing files only. No additional files, no deletion, no network.'
   ].join('\n');
   const turn=await this.rpc('turn/start',{
    threadId:this.threadId,cwd:this.cwd,
    approvalPolicy:'on-request',approvalsReviewer:'user',
    sandboxPolicy:{
     type:'workspaceWrite',networkAccess:false,
     writableRoots:[this.cwd],excludeTmpdirEnvVar:true,excludeSlashTmp:true
    },
    effort:this.turnEffort,input:[{type:'text',text:fullPrompt}]
   });
   if(!object(turn)||!object(turn.turn)||!validId(turn.turn.id))
    throw Error('CODEX_WRITE_TURN_UNVERIFIED');
   this.turnId=turn.turn.id;
   for(const event of this.early)this.notification(event);
   this.early=[];
   await terminal;
  }catch(e){
   this.fail('CODEX_WRITE_EXECUTION_UNVERIFIED');
   throw e;
  }
 }
}
