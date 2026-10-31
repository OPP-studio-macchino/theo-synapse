// Separate native Mac consent for PROMOTING or RESTORING one verified file.
// No MCP-exposed grant. Never allow the default button to approve.
import {spawn} from 'node:child_process';

const allowedOutcomes=new Set(['APPROVED','DENIED','TIMEOUT','SCRIPT_ERROR']);
function quote(s){
 return '"'+String(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
}
const noControl=s=>typeof s==='string'&&!/[\x00-\x1f]/.test(s);
export function promotionConsentScript({action,id,projectId,sourceRoot,file,fingerprint,beforeHash,afterHash}={}){
 if(!['APPLY','RESTORE','RECOVER'].includes(action)||
    !/^[A-Za-z0-9_-]{8,80}$/.test(id??'')||
    !/^[A-Za-z0-9_-]{1,64}$/.test(projectId??'')||
    !noControl(sourceRoot)||!sourceRoot.startsWith('/')||sourceRoot.length>450||
    !noControl(file)||file.length>220||
    !/^[a-f0-9]{64}$/.test(fingerprint??'')||
    !/^[a-f0-9]{64}$/.test(beforeHash??'')||
    !/^[a-f0-9]{64}$/.test(afterHash??''))
   throw Error('PROMOTION_CONSENT_CONTEXT_INVALID');
 const restoration=action==='RESTORE'||action==='RECOVER';
 const recovery=action==='RECOVER';
 const lines=restoration?[
  recovery?'Theo Synapse：中断した書き込みを安全に復旧しますか？':'Theo Synapse：変更を元に戻しますか？','',
  recovery?'前回の処理が途中停止したため、バックアップに戻します。':'これは実際の開発フォルダの１ファイルを書き戻します。',
  '対象プロジェクト：'+projectId,
  '対象フォルダ：'+sourceRoot,
  '対象ファイル：'+file,
  '現在の内容（SHA）：'+afterHash.slice(0,16),
  '復元する内容（SHA）：'+beforeHash.slice(0,16),
  '確認番号：'+fingerprint.slice(0,20),
  '他のファイルは変更しません。',
  '許可する場合のみ「復元を許可」を押してください。'
 ]:[
  'Theo Synapse：実際の開発ファイルへ反映しますか？','',
  '注意：これは隔離コピーの作成とは違い、元の実プロジェクトを変更します。',
  '対象プロジェクト：'+projectId,
  '対象フォルダ：'+sourceRoot,
  '変更するファイル：'+file,
  '変更前のSHA：'+beforeHash.slice(0,16),
  '変更後のSHA：'+afterHash.slice(0,16),
  '確認番号：'+fingerprint.slice(0,20),
  '事前に元ファイルのバックアップを残します。',
  'この１ファイルだけの反映を許可する場合、「１回だけ反映」を押してください。'
 ];
 const accept=recovery?'復旧を許可':restoration?'復元を許可':'１回だけ反映';
 return [
  'try',
  'set r to display dialog ('+lines.map(quote).join(' & return & ')+
   ') buttons {"許可しない", '+quote(accept)+'} default button "許可しない" cancel button "許可しない" with icon caution giving up after 90',
  'if gave up of r then return "TIMEOUT"',
  'if button returned of r is '+quote(accept)+' then return "APPROVED"',
  'return "DENIED"',
  'on error errText number errNum',
  'if errNum is -128 then return "DENIED"',
  'return "SCRIPT_ERROR"',
  'end try'
 ].join('\n');
}
export function requestPromotionConsent(context,{signal}={}){
 if(process.platform!=='darwin')return Promise.resolve({approved:false,reason:'MAC_UNAVAILABLE'});
 const source=promotionConsentScript(context);
 return new Promise(resolve=>{
  let output='',child,finished=false,timer;
  const end=reason=>{
   if(finished)return;finished=true;
   clearTimeout(timer);
   signal?.removeEventListener('abort',abort);
   if(reason!=='APPROVED'&&child&&!child.killed)child.kill('SIGTERM');
   resolve({approved:reason==='APPROVED',reason});
  };
  const abort=()=>end('ABORTED');
  if(signal?.aborted)return end('ABORTED');
  try{child=spawn('/usr/bin/osascript',['-e',source],{
   shell:false,stdio:['ignore','pipe','ignore']
  });}catch{return end('SCRIPT_ERROR');}
  signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>end('TIMEOUT'),95000);
  child.stdout.on('data',b=>{
   output+=String(b);
   if(output.length>2000)end('SCRIPT_ERROR');
  });
  child.once('error',()=>end('SCRIPT_ERROR'));
  child.once('close',code=>{
   const answer=output.trim();
   end(code===0&&allowedOutcomes.has(answer)?answer:'SCRIPT_ERROR');
  });
 });
}
