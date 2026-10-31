// Owner must physically approve a specific read-only snapshot; fail closed.
import {spawnSync} from 'node:child_process';

const safeText=s=>String(s??'').replace(/[\r\n\t]/g,' ').slice(0,360);
const quote=s=>'"'+safeText(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
export function nativeApprovalScript({id,source,digest,files}={}){
 if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(id)||
    typeof source!=='string'||!source.startsWith('/')||
    typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest)||
    !Number.isInteger(files)||files<1||files>180)
  throw Error('OWNER_APPROVAL_CONTEXT_INVALID');

 const folder=source.split('/').filter(Boolean).at(-1);
 const lines=[
  'Theo Synapse：検証用コピーの許可',
  '',
  '対象：'+safeText(folder)+'（'+safeText(id)+'）',
  '内容：安全検査で選ばれた '+files+' ファイルをMac内にコピーします。',
  '',
  '元のChappy Signalなどのファイルは書き換えません。',
  '今回、Codexにコードを書き換える権限は与えません。',
  'コピーした資料は、後でCodexの読み取り検証に使います。',
  '',
  'コピーしてよければ「コピーを許可」を押してください。',
  '迷う場合は「許可しない」を押してください。',
  '確認番号：'+digest.slice(0,20)
 ];
 const explanation=lines.map(quote).join(' & return & ');
 return [
  'try',
  'set d to display dialog '+explanation+
    ' buttons {"許可しない", "コピーを許可"} default button "許可しない" cancel button "許可しない" with icon caution giving up after 90',
  'if gave up of d then return "DENIED"',
  'if button returned of d is "コピーを許可" then return "APPROVED"',
  'return "DENIED"',
  'on error',
  'return "DENIED"',
  'end try'
 ].join('\n');
}
export function requestNativeOwnerApproval(context){
 if(process.platform!=='darwin')return false;
 const script=nativeApprovalScript(context);
 const reply=spawnSync('/usr/bin/osascript',['-e',script],{
  encoding:'utf8',timeout:95000,maxBuffer:4096,stdio:['ignore','pipe','ignore']
 });
 return reply.status===0&&reply.stdout.trim()==='APPROVED';
}
