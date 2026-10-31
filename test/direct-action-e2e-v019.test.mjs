import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {CodexAppServer} from '../src/codex-adapter.mjs';

function sandbox(){
 const root=mkdtempSync('/private/tmp/theo-native-approval-e2e-');chmodSync(root,0o700);
 const proof=join(root,'proof.js');writeFileSync(proof,'export const VALUE = 2;\n',{mode:0o600});
 return {root,proof,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const fake=new URL('./fake-native-owner-approval-app-server.mjs',import.meta.url).pathname;

test('synthetic AppServer file request is fulfilled only after a separate Owner callback',async()=>{
 const f=sandbox();let ownerRequests=0,terminal=[];
 const a=new CodexAppServer(process.execPath,f.root,{
  args:[fake],taskId:'synthetic_action_approval_01',
  ownerActionApproval:async(review)=>{
   ownerRequests++;
   assert.equal(review.kind,'fileChange');
   assert.match(review.preview,/update : proof\.js/);
   assert.equal(review.workspaceRoot,f.root);
   assert.match(review.digest,/^[a-f0-9]{64}$/);
   assert.equal(readFileSync(f.proof,'utf8'),'export const VALUE = 2;\n');
   return true;
  }
 });
 try{
  await a.execute({projectRoot:f.root,prompt:'Synthetic single file update',executionMode:'workspace_write',
   onEvent:e=>{if(e.kind==='terminal')terminal.push(e.status);}});
  assert.equal(ownerRequests,1);
  assert.deepEqual(terminal,['completed']);
  assert.equal(readFileSync(f.proof,'utf8'),'export const VALUE = 3;\n');
  assert.deepEqual(readdirSync(f.root),['proof.js']);
 }finally{a.disconnect();f.cleanup();}
});

test('synthetic AppServer requires genuine Owner callback; no callback means no file change',async()=>{
 const f=sandbox();const a=new CodexAppServer(process.execPath,f.root,{args:[fake],taskId:'synthetic_action_denied_02'});
 try{
  await assert.rejects(()=>a.execute({projectRoot:f.root,prompt:'Synthetic update should fail',executionMode:'workspace_write'}),/APPROVAL_REQUEST_DENIED/);
  assert.equal(readFileSync(f.proof,'utf8'),'export const VALUE = 2;\n');
  assert.deepEqual(readdirSync(f.root),['proof.js']);
 }finally{a.disconnect();f.cleanup();}
});

test('synthetic AppServer explicit Owner refusal does not modify a file',async()=>{
 const f=sandbox();let ownerRequests=0;
 const a=new CodexAppServer(process.execPath,f.root,{
  args:[fake],taskId:'synthetic_action_refuse_03',
  ownerActionApproval:async()=>{ownerRequests++;return false;}
 });
 try{
  await assert.rejects(()=>a.execute({projectRoot:f.root,prompt:'Synthetic update should be refused',executionMode:'workspace_write'}),/APPROVAL_REQUEST_DENIED/);
  assert.equal(ownerRequests,1);
  assert.equal(readFileSync(f.proof,'utf8'),'export const VALUE = 2;\n');
 }finally{a.disconnect();f.cleanup();}
});
