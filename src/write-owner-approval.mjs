// One-time Mac native Owner confirmation; never auto-approve.
// Return only a safe status enum; no secret or arbitrary AppleScript error output.
import {spawn} from 'node:child_process';

const clean=s=>String(s??'').replace(/[\x00-\x1f]/g,' ').slice(0,255);
const quote=s=>'"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
const outcomes=new Set(['APPROVED','USER_DENIED','TIMEOUT','SCRIPT_ERROR']);
export function writeNativeApprovalScript({id,projectId,instruction,allowedFiles,planHash}={}){
 if(typeof id!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(id)||
    typeof projectId!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)||
    typeof instruction!=='string'||instruction.length>240||instruction.length<12||
    /[\x00-\x1f]/.test(instruction)||
    !Array.isArray(allowedFiles)||allowedFiles.length<1||allowedFiles.length>3||
    allowedFiles.some(x=>typeof x!=='string'||x.length>220||/[\x00-\x1f]/.test(x))||
    typeof planHash!=='string'||!/^[a-f0-9]{64}$/.test(planHash))
  throw Error('WRITE_OWNER_DIALOG_CONTEXT_INVALID');
 const lines=[
  'Theo Synapse：コード変更を１回だけ許可しますか？',
  '',
  '対象：'+clean(projectId),
  '変更可能なファイル：',...allowedFiles.map(f=>'・'+clean(f)),
  '',
  '作業指示（全文）：',clean(instruction),'',
  'コードの変更先は専用の隔離コピーだけです。',
  '元のChappy Signalや登録済みの資料は変更しません。',
  '変更結果を原本に反映するには別の承認が必要です。',
  '追加課金の購入や権限昇格も許可しません。','',
  '指示内容とファイルを確認し、よければ「１回だけ許可」。',
  'それ以外は「拒否する」を押してください。',
  '確認コード：'+planHash.slice(0,20)
 ];
 const explanation=lines.map(quote).join(' & return & ');
 return [
  'try',
  'set d to display dialog '+explanation+
   ' buttons {"拒否する", "１回だけ許可"} default button "拒否する" cancel button "拒否する" with icon caution giving up after 90',
  'if gave up of d then return "TIMEOUT"',
  'if button returned of d is "１回だけ許可" then return "APPROVED"',
  'return "USER_DENIED"',
  'on error errText number errNum',
  'if errNum is -128 then return "USER_DENIED"',
  'return "SCRIPT_ERROR"',
  'end try'
 ].join('\n');
}
export function requestWriteOwnerApprovalDetailed(context,{signal}={}){
 if(process.platform!=='darwin')return Promise.resolve({approved:false,reason:'MAC_UNAVAILABLE'});
 const script=writeNativeApprovalScript(context);
 return new Promise(resolve=>{
  let child=null,timeout,finished=false,output='';
  const finish=reason=>{
   if(finished)return;
   finished=true;clearTimeout(timeout);
   signal?.removeEventListener('abort',abort);
   if(reason!=='APPROVED'&&child&&!child.killed)child.kill('SIGTERM');
   resolve({approved:reason==='APPROVED',reason});
  };
  const abort=()=>finish('ABORTED');
  if(signal?.aborted)return finish('ABORTED');
  try{
   child=spawn('/usr/bin/osascript',['-e',script],
    {shell:false,stdio:['ignore','pipe','ignore']});
  }catch{return finish('SCRIPT_ERROR');}
  signal?.addEventListener('abort',abort,{once:true});
  timeout=setTimeout(()=>finish('TIMEOUT'),95000);
  child.stdout.on('data',chunk=>{
   output+=String(chunk);
   if(output.length>4096)finish('SCRIPT_ERROR');
  });
  child.once('error',()=>finish('SCRIPT_ERROR'));
  child.once('close',code=>{
   const answer=output.trim();
   finish(code===0&&outcomes.has(answer)?answer:'SCRIPT_ERROR');
  });
 });
}
// Legacy boolean wrapper retained for standalone callers.
export async function requestWriteOwnerApproval(context,opts={}){
 return (await requestWriteOwnerApprovalDetailed(context,opts)).approved;
}
