import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {nativeApprovalScript} from '../src/owner-approval.mjs';

test('Japanese native approval is deny-by-default, readable, bounded and never invokes shell commands',()=>{
 const script=nativeApprovalScript({id:'chappy-signal',
   source:'/Volumes/OPP_ARCHIVE/O.P.P Studio/Chappy Sound',
   digest:'abcdef0123456789'.repeat(4),files:69});
 assert.match(script,/Theo Synapse：検証用コピーの許可/);
 assert.match(script,/Chappy Sound/);
 assert.match(script,/69 ファイル/);
 assert.match(script,/元のChappy Signalなどのファイルは書き換えません/);
 assert.match(script,/コピーを許可/);
 assert.match(script,/default button "許可しない" cancel button "許可しない"/);
 assert.match(script,/giving up after 90/);
 assert.match(script,/return "APPROVED"/);
 assert.match(script,/return "DENIED"/);
 assert.doesNotMatch(script,/do shell script/);
 assert.throws(()=>nativeApprovalScript({id:'test',source:'/',files:1}),/OWNER_APPROVAL_CONTEXT_INVALID/);
});
test('Japanese AppleScript compiles; tests do NOT show a user approval dialog',()=>{
 if(process.platform!=='darwin')return;
 const folder=mkdtempSync('/private/tmp/theo-native-approval-');
 const output=join(folder,'native-consent.scpt');
 try{
  const script=nativeApprovalScript({
   id:'safe-project',
   source:'/Users/THEO_PUBLIC_EXAMPLE/Documents/Code/with "a quote" in name',
   digest:'abcd0123abcd0123'.repeat(4),
   files:4
  });
  const result=spawnSync('/usr/bin/osacompile',['-o',output,'-e',script],{
   encoding:'utf8',timeout:7000,stdio:['ignore','pipe','pipe']
  });
  assert.equal(result.status,0,String(result.stderr).slice(0,300));
  assert.equal(existsSync(output),true);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
