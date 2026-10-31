// Validate individual App Server approvals. Owner UI is separate from this pure policy.
// Never use the previous per-task grant as approval for a Codex tool request.
import {resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';

const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeText=x=>typeof x==='string'&&x.length>0&&x.length<=1100&&!/[\x00-\x08\x0b-\x1f\x7f]/.test(x);
const isInside=(root,path)=>{
 const delta=relative(root,path);
 return delta!==''&&!delta.startsWith('..'+sep)&&delta!=='..'&&!delta.startsWith(sep);
};

function canonicalChild(root,raw){
 if(typeof raw!=='string'||!raw||raw.length>500||raw.includes('\0'))return null;
 const full=resolve(root,raw);
 if(!isInside(root,full))return null;
 // Disallow symlinks in any existing component, including target.
 let current=root;
 const bits=relative(root,full).split(sep);
 try{
  for(const part of bits){
   current=resolve(current,part);
   const s=lstatSync(current);
   if(s.isSymbolicLink())return null;
  }
 }catch(e){if(e.code!=='ENOENT')return null;}
 return full;
}

function eligibleDecisions(request){
 const options=request.params.availableDecisions;
 if(options===undefined)return true;
 return Array.isArray(options)&&options.some(x=>x==='accept');
}

export function reviewCodexRequest({request,items,workspaceRoot,threadId,turnId,executionMode,taskId}={}){
 if(executionMode!=='workspace_write'||!obj(request)||!obj(request.params)||!id(threadId)||!id(turnId)||
    request.params.threadId!==threadId||request.params.turnId!==turnId||
    !id(request.params.itemId)||!id(taskId)||!eligibleDecisions(request)||
    !workspaceRoot?.startsWith('/')||resolve(workspaceRoot)!==workspaceRoot||realpathSync.native(workspaceRoot)!==workspaceRoot||
    !items?.has?.(request.params.itemId))return null;
 if(typeof request.id!=='number'&&!id(request.id))return null;
 const item=items.get(request.params.itemId);
 if(!obj(item)||item.id!==request.params.itemId)return null;
 let kind,preview;
 if(request.method==='item/fileChange/requestApproval'){
  if(item.type!=='fileChange'||(request.params.grantRoot!==undefined&&request.params.grantRoot!==workspaceRoot))return null;
  const changes=item.changes;
  if(!Array.isArray(changes)||changes.length<1||changes.length>12)return null;
  const paths=[];
  for(const change of changes){
   if(!obj(change)||!safeText(change.path)||/[\r\n]/.test(change.path)||!['update','add','delete','move'].includes(change.kind))return null;
   const full=canonicalChild(workspaceRoot,change.path);
   if(!full)return null;
   paths.push(change.kind+' : '+relative(workspaceRoot,full));
  }
  preview=paths.join('\n');
  kind='fileChange';
 }else if(request.method==='item/commandExecution/requestApproval'){
  if(item.type!=='commandExecution'||request.params.networkApprovalContext!==undefined||
     request.params.additionalPermissions!==undefined||request.params.proposedExecpolicyAmendment!==undefined||
     request.params.commandActions!==undefined)return null;
  const cwd=request.params.cwd??item.cwd;
  if(cwd!==workspaceRoot||item.cwd!==workspaceRoot||typeof item.command!=='string'||!safeText(item.command))return null;
  if(request.params.command!==undefined&&request.params.command!==item.command)return null;
  const command=item.command;
  // Restricted commands only: no arbitrary shell, redirections, pipelines or escape requests.
  // General project command approvals require a separately reviewed policy.
  const safeReadOnlyCommand=/^(?:rg|grep|cat|ls|pwd|sed|node)\b/;
  if(!safeReadOnlyCommand.test(command)||/[;&|><\n\r\`$\\]/.test(command)||command.includes('../')||command.includes('/Users/')||command.length>320)return null;
  preview=command;
  kind='commandExecution';
 }else return null;
 if(preview.length>1100)return null;
 const facts={kind,threadId,turnId,taskId,requestId:request.id,itemId:item.id,workspaceRoot,preview};
 return {...facts,digest:digest(facts)};
}
