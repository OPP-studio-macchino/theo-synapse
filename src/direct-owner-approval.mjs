// Per-task physical Owner approval for real-workspace writes.
import {spawn,spawnSync} from 'node:child_process';

const safe=s=>String(s??'').replace(/[\x00-\x1f]/g,' ').slice(0,360);
const quote=s=>'"'+safe(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
export function directWriteApprovalScript({taskId,workspaceId,workspaceRoot,instructionDigest}={}){
 if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(taskId)||typeof workspaceId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)||typeof workspaceRoot!=='string'||!workspaceRoot.startsWith('/')||typeof instructionDigest!=='string'||!/^[a-f0-9]{64}$/.test(instructionDigest))throw Error('DIRECT_OWNER_DIALOG_CONTEXT_INVALID');
 const lines=['Theo Synapse：実際のソースへ１回だけ書き込みを許可しますか？','',
  'プロジェクト：'+safe(workspaceId),'フォルダ：'+safe(workspaceRoot),'タスク：'+safe(taskId),
  '指示の確認コード：'+instructionDigest.slice(0,20),'',
  'この承認はこの１タスクだけです。継続許可は保存されません。',
  '内容を確認し、よければ「１回だけ許可」を押してください。'];
 return ['try','set d to display dialog ('+lines.map(quote).join(' & return & ')+')'+
  ' buttons {"拒否する", "１回だけ許可"} default button "拒否する" cancel button "拒否する" with icon caution giving up after 30',
  'if gave up of d then return "TIMEOUT"','if button returned of d is "１回だけ許可" then return "APPROVED"','return "DENIED"',
  'on error','return "DENIED"','end try'].join('\n');
}
export function requestDirectWriteApproval(context,{signal}={}){
 if(process.platform!=='darwin')return Promise.resolve(false);
 const script=directWriteApprovalScript(context);
 return new Promise(resolve=>{
  let child,done=false,output='',timer;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!value&&child&&!child.killed)child.kill('SIGTERM');resolve(value);};
  const abort=()=>finish(false);if(signal?.aborted)return abort();
  try{child=spawn('/usr/bin/osascript',['-e',script],{shell:false,stdio:['ignore','pipe','ignore']});}catch{return finish(false);}
  signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,31000);
  child.stdout.on('data',x=>{output+=String(x);if(output.length>256)finish(false);});
  child.once('error',()=>finish(false));child.once('close',code=>finish(code===0&&output.trim()==='APPROVED'));
 });
}
export function directRegistrationApprovalScript({id,source,fingerprint}={}){
 if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(id)||typeof source!=='string'||!source.startsWith('/')||typeof fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('DIRECT_REGISTRATION_DIALOG_CONTEXT_INVALID');
 const lines=['Theo Synapse：実際のソースフォルダを直接作業用に登録しますか？','',
  'プロジェクト：'+safe(id),'フォルダ：'+safe(source),'確認コード：'+fingerprint.slice(0,20),'',
  'この操作はフォルダ内のファイルを変更しません。',
  '書き込み作業は、後でタスクごとに別途１回だけ確認します。'];
 return ['try','set d to display dialog ('+lines.map(quote).join(' & return & ')+')'+
  ' buttons {"許可しない", "登録を許可"} default button "許可しない" cancel button "許可しない" with icon caution giving up after 90',
  'if gave up of d then return "DENIED"','if button returned of d is "登録を許可" then return "APPROVED"','return "DENIED"','on error','return "DENIED"','end try'].join('\n');
}
export function requestDirectRegistrationApproval(context){
 if(process.platform!=='darwin')return false;
 try{const r=spawnSync('/usr/bin/osascript',['-e',directRegistrationApprovalScript(context)],{encoding:'utf8',timeout:95000,maxBuffer:1024,stdio:['ignore','pipe','ignore']});return r.status===0&&r.stdout.trim()==='APPROVED';}catch{return false;}
}


// A Codex App Server command or file-change request needs its OWN physical Owner
// confirmation. The earlier task-level permission never auto-grants tool approval.
export function directActionApprovalScript({kind,taskId,itemId,workspaceRoot,preview,digest}={}){
 if(!['fileChange','commandExecution'].includes(kind)||
  typeof taskId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(taskId)||
  typeof itemId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(itemId)||
  typeof workspaceRoot!=='string'||!workspaceRoot.startsWith('/')||workspaceRoot.length>500||
  typeof preview!=='string'||preview.length<1||preview.length>950||
  /[\x00-\x08\x0b-\x1f\x7f]/.test(preview)||
  typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))throw Error('DIRECT_ACTION_DIALOG_INVALID');
 const exact=x=>'"'+x.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,' ')+'"';
 const lines=[
  'Theo Synapse：Codexが次の操作の追加承認を求めています。',
  '種類：'+kind,'タスク：'+taskId,'リクエスト：'+itemId,
  '実フォルダ：'+workspaceRoot,'操作内容：'+preview,
  'この要求の確認コード：'+digest.slice(0,20),
  '別の操作や追加権限・ネットワーク利用は許可しません。',
  'この1操作だけを許可しますか？拒否するとタスクは停止します。'];
 return ['try','set d to display dialog ('+lines.map(exact).join(' & return & ')+')'+
  ' buttons {"拒否する","この1操作だけ許可"} default button "拒否する" cancel button "拒否する" with icon caution giving up after 30',
  'if gave up of d then return "DENIED"','if button returned of d is "この1操作だけ許可" then return "APPROVED"',
  'return "DENIED"','on error','return "DENIED"','end try'].join('\n');
}
export function requestDirectActionApproval(context,{signal}={}){
 if(process.platform!=='darwin')return Promise.resolve(false);
 let script;
 try{script=directActionApprovalScript(context);}catch{return Promise.resolve(false);}
 return new Promise(resolve=>{
  let child,done=false,output='',timer;
  const finish=value=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(!value&&child&&!child.killed)child.kill('SIGTERM');resolve(value);};
  const abort=()=>finish(false);
  if(signal?.aborted)return abort();
  try{child=spawn('/usr/bin/osascript',['-e',script],{shell:false,stdio:['ignore','pipe','ignore']});}
  catch{return finish(false);}
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(abort,31000);
  child.stdout.on('data',x=>{output+=String(x);if(output.length>256)finish(false);});
  child.once('error',()=>finish(false));
  child.once('close',code=>finish(code===0&&output.trim()==='APPROVED'));
 });
}
