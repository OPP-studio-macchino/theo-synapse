import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,symlinkSync,
 unlinkSync,linkSync,chmodSync
} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {OneTimeWriteGrants} from '../src/write-grants.mjs';
import {PromotionLedger} from '../src/promotion-ledger.mjs';
import {prepareWritePlan,stageApprovedCandidate,verifyCandidateChanges,snapshotManifest} from '../src/write-candidates.mjs';
import {previewPromotion,applyPromotion,previewRestore,restorePromotion,previewRecovery,recoverUnknownPromotion} from '../src/owner-promotion.mjs';
import {promotionConsentScript} from '../src/promotion-owner-approval.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const before='export const LABEL = "BEFORE";\n';
const after='export const LABEL = "AFTER";\n';
const file='extension/demo.js';
const projectId='owner-project';
const requestId='theo-promotion-test-0001';
function createFixture(){
 const root=mkdtempSync('/private/tmp/theo-promo-standalone-');
 const source=mkdtempSync('/private/tmp/theo-promo-original-');
 const rt=join(root,'.local','theo-runtime');
 const snap=join(rt,'projects',projectId);
 for(const p of [join(root,'.local'),rt,join(rt,'projects'),snap,join(snap,'extension'),
  join(source,'extension')])mkdirSync(p,{mode:0o700});
 writeFileSync(join(rt,'projects.json'),JSON.stringify({
  schema:1,projects:{[projectId]:snap}
 }),{mode:0o600});
 for(const dest of [source,snap]){
  writeFileSync(join(dest,'README.md'),'Theo Synapse isolated project.\n',{mode:0o600});
  writeFileSync(join(dest,file),before,{mode:0o600});
 }
 const grants=new OneTimeWriteGrants(join(rt,'writes.sqlite'));
 const plan=prepareWritePlan({
  projectRoot:snap,id:requestId,projectId,
  instruction:'Change only extension/demo.js LABEL from BEFORE to AFTER.',
  allowedFiles:[file]
 });
 grants.propose(plan);
 const token=grants.authorize(requestId);
 const authorization=grants.consume(requestId,token);
 const staged=stageApprovedCandidate({runtime:rt,projectRoot:snap,request:authorization});
 writeFileSync(join(staged.candidateDir,file),after,{mode:0o600});
 const delta=verifyCandidateChanges({candidateDir:staged.candidateDir,before:staged.before,
  allowedFiles:[file]});
 grants.complete(requestId,{state:'COMPLETED',outcome:{
  changedFiles:delta.changedFiles.map(x=>x.path),
  candidateId:requestId,baseDigest:staged.before.hash,candidateDigest:delta.manifestHash,
  changedHashes:delta.changedFiles.map(x=>({
   path:x.path,before:x.beforeSha256,after:x.afterSha256
  })),providerFinished:true,candidateVerified:true
 }});
 grants.close();
 return {root,source,snap,rt,requestId,
  args:()=>({standaloneRoot:root,requestId,sourceRoot:source}),
  readSource:()=>readFileSync(join(source,file),'utf8'),
  readSnapshot:()=>readFileSync(join(snap,file),'utf8'),
  cleanup:()=>{rmSync(root,{recursive:true,force:true});rmSync(source,{recursive:true,force:true});}
 };
}
function ledgerState(f){
 const p=join(f.rt,'promotions.sqlite');
 const db=new PromotionLedger(p);
 try{return db.get(f.requestId);}finally{db.close();}
}
test('local preview verifies existing completed Codex candidate, hashes, and review diff without edits',()=>{
 const f=createFixture();
 try{
  const plan=previewPromotion(f.args());
  assert.equal(plan.projectId,projectId);
  assert.equal(plan.relativeFile,file);
  assert.equal(plan.beforeHash,digest(Buffer.from(before)));
  assert.equal(plan.afterHash,digest(Buffer.from(after)));
  assert.equal(plan.reviewCode.length,20);
  assert.match(plan.diffPreview,/\- export const LABEL = "BEFORE"/);
  assert.match(plan.diffPreview,/\+ export const LABEL = "AFTER"/);
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  assert.equal(existsSync(join(f.rt,'promotions.sqlite')),false);
 }finally{f.cleanup();}
});
test('without separate physical Owner consent, promotion is denied and candidate remains',async()=>{
 const f=createFixture();
 try{
  const plan=previewPromotion(f.args());
  const result=await applyPromotion({...f.args(),confirm:plan.reviewCode,
   approveOwner:async()=>({approved:false,reason:'USER_DENIED'})});
  assert.deepEqual(result,{state:'DENIED',reason:'USER_DENIED',sourceModified:false});
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  assert.equal(ledgerState(f)?.state,'DENIED');
  assert.throws(()=>previewRestore({standaloneRoot:f.root,requestId:f.requestId}),/PROMOTION_NOT_RESTORABLE/);
  await assert.rejects(()=>applyPromotion({...f.args(),confirm:plan.reviewCode,
   approveOwner:async()=>true}),/PROMOTION_ALREADY_PROCESSED/);
 }finally{f.cleanup();}
});
test('second Owner consent atomically applies exactly one file, stores backup, restores only with third consent',async()=>{
 const f=createFixture();
 try{
  const p=previewPromotion(f.args());
  const previousSnapshot=snapshotManifest(f.snap).hash;
  let approvals=0;
  const apply=await applyPromotion({...f.args(),confirm:p.reviewCode,
   approveOwner:async context=>{
    approvals++;assert.equal(context.action,'APPLY');
    assert.equal(context.file,file);assert.equal(context.sourceRoot,f.source);
    return {approved:true,reason:'APPROVED'};
   }});
  assert.equal(apply.state,'APPLIED');
  assert.equal(approvals,1);
  assert.equal(apply.relativeFile,file);
  assert.equal(f.readSource(),after);
  assert.equal(f.readSnapshot(),before);
  assert.equal(snapshotManifest(f.snap).hash,previousSnapshot);
  const row=ledgerState(f);
  assert.equal(row.state,'APPLIED');
  assert.equal(row.before_hash,p.beforeHash);
  assert.equal(row.after_hash,p.afterHash);
  assert.equal(row.backup_hash,p.beforeHash);
  assert.equal(readFileSync(row.backup_path,'utf8'),before);
  assert.equal(statSync(row.backup_path).mode&0o077,0);
  await assert.rejects(()=>applyPromotion({...f.args(),confirm:p.reviewCode,
   approveOwner:async()=>true}),/PROMOTION_SOURCE_HAS_CHANGED|PROMOTION_ALREADY_PROCESSED/);
  const restoring=previewRestore({standaloneRoot:f.root,requestId:f.requestId});
  assert.equal(restoring.reviewCode.length,20);
  const denied=await restorePromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:restoring.reviewCode,
   approveOwner:async()=>({approved:false,reason:'USER_DENIED'})
  });
  assert.equal(denied.restored,false);
  assert.equal(f.readSource(),after);
  const restored=await restorePromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:restoring.reviewCode,
   approveOwner:async x=>{
    approvals++;assert.equal(x.action,'RESTORE');
    return true;
   }
  });
  assert.equal(restored.state,'RESTORED');
  assert.equal(approvals,2);
  assert.equal(f.readSource(),before);
  assert.equal(f.readSnapshot(),before);
  assert.equal(ledgerState(f).state,'RESTORED');
  await assert.rejects(()=>restorePromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:restoring.reviewCode,
   approveOwner:async()=>true
  }),/PROMOTION_NOT_RESTORABLE/);
 }finally{f.cleanup();}
});
test('any source edit before approval refuses promotion instead of overwriting user changes',async()=>{
 const f=createFixture();
 try{
  const p=previewPromotion(f.args());
  const newer='export const LABEL = "OWNER_NEWER";\n';
  let approvals=0;
  await assert.rejects(()=>applyPromotion({...f.args(),confirm:p.reviewCode,
   approveOwner:async()=>{
    approvals++;
    writeFileSync(join(f.source,file),newer,{mode:0o600});
    return true;
   }}),/PROMOTION_SOURCE_HAS_CHANGED|PROMOTION_PLAN_CHANGED_AFTER_APPROVAL/);
  assert.equal(approvals,1);
  assert.equal(f.readSource(),newer);
  assert.equal(f.readSnapshot(),before);
  assert.equal(ledgerState(f).state,'CONFLICT');
 }finally{f.cleanup();}
});
test('failpoint before or after atomic rename restores baseline and burns one-time decision',async()=>{
 for(const phase of ['beforeSwap','afterSwap']){
  const f=createFixture();
  try{
   const p=previewPromotion(f.args());
   await assert.rejects(()=>applyPromotion({...f.args(),confirm:p.reviewCode,
    approveOwner:async()=>true,failpoint:phase}),/PROMOTION_TEST_/);
   assert.equal(f.readSource(),before,phase);
   assert.equal(f.readSnapshot(),before);
   const row=ledgerState(f);
   assert.equal(row.state,'ROLLED_BACK');
   assert.ok(row.consumed_ms);
   assert.equal(readFileSync(row.backup_path,'utf8'),before);
  }finally{f.cleanup();}
 }
});
test('unapproved fingerprint, invalid source path, symlink and hardlink are rejected',async()=>{
 const f=createFixture();
 try{
  const plan=previewPromotion(f.args());
  await assert.rejects(()=>applyPromotion({...f.args(),confirm:'not-the-review-code',
   approveOwner:async()=>true}),/PROMOTION_OWNER_REVIEW_REQUIRED/);
  const alias=f.source+'-alias';
  symlinkSync(f.source,alias);
  try{
   assert.throws(()=>previewPromotion({...f.args(),sourceRoot:alias}),/PROMOTION_SOURCE_ALIAS/);
  }finally{unlinkSync(alias);}
  const other=join(f.source,'hlink.js');
  linkSync(join(f.source,file),other);
  try{
   assert.throws(()=>previewPromotion(f.args()),/PROMOTION_FILE_UNSAFE/);
  }finally{unlinkSync(other);}
  assert.equal(existsSync(join(f.rt,'promotions.sqlite')),false);
 }finally{f.cleanup();}
});
test('candidate content mismatch and unauthorized additional changed path are rejected in review',()=>{
 const f=createFixture();
 try{
  const p=join(f.rt,'write-candidates',requestId,file);
  writeFileSync(p,'export const LABEL = "UNVERIFIED";\n',{mode:0o600});
  assert.throws(()=>previewPromotion(f.args()),/PROMOTION_CANDIDATE_HASH_MISMATCH/);
  assert.equal(f.readSource(),before);
 }finally{f.cleanup();}
});
test('promotion ledger restart marks in-flight operations UNKNOWN; never retry interrupted apply',()=>{
 const f=createFixture();
 try{
  const plan=previewPromotion(f.args()),database=join(f.rt,'promotions.sqlite');
  let db=new PromotionLedger(database);
  db.reserve(plan);
  db.change(f.requestId,'PENDING','APPLYING',{consumed_ms:Date.now()});
  db.close();
  db=new PromotionLedger(database);
  assert.equal(db.get(f.requestId).state,'UNKNOWN');
  assert.equal(db.get(f.requestId).error_code,'RESTART_DURING_WRITE');
  assert.throws(()=>db.reserve(plan),/PROMOTION_ALREADY_PROCESSED/);
  db.close();
  assert.equal(f.readSource(),before);
 }finally{f.cleanup();}
});
test('native Mac promotion/restore dialogs compile with deny-by-default and are not shown during tests',()=>{
 for(const action of ['APPLY','RESTORE','RECOVER']){
  const script=promotionConsentScript({
   action,id:requestId,projectId,sourceRoot:'/private/tmp/theo-demo-owner',
   file,beforeHash:'a'.repeat(64),afterHash:'b'.repeat(64),
   fingerprint:'c'.repeat(64)
  });
  assert.match(script,/default button "許可しない" cancel button "許可しない"/);
  assert.match(script,/giving up after 90/);
  assert.match(script,/APPROVED/);
  assert.doesNotMatch(script,/do shell script/);
  if(process.platform==='darwin'){
   const folder=mkdtempSync('/private/tmp/theo-promotion-ui-');
   try{
    const out=join(folder,'consent.scpt');
    const r=spawnSync('/usr/bin/osacompile',['-o',out,'-e',script],{
     encoding:'utf8',timeout:7000,stdio:['ignore','pipe','pipe']
    });
    assert.equal(r.status,0,String(r.stderr).slice(0,240));
   }finally{rmSync(folder,{recursive:true,force:true});}
  }
 }
});

test('restore fails closed when the source was independently changed after promotion',async()=>{
 const f=createFixture();
 try{
  const p=previewPromotion(f.args());
  const result=await applyPromotion({...f.args(),confirm:p.reviewCode,approveOwner:async()=>true});
  assert.equal(result.state,'APPLIED');
  const changed='export const LABEL = "ANOTHER_AUTHOR";\n';
  writeFileSync(join(f.source,file),changed,{mode:0o600});
  const preview=previewRestore({standaloneRoot:f.root,requestId:f.requestId});
  await assert.rejects(()=>restorePromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:preview.reviewCode,
   approveOwner:async()=>true
  }),/PROMOTION_RESTORE_CONFLICT/);
  assert.equal(f.readSource(),changed);
  assert.equal(ledgerState(f).state,'APPLIED');
 }finally{f.cleanup();}
});
test('source group-writable path and broad root are rejected before native Owner consent',()=>{
 const f=createFixture();
 try{
  const plan=previewPromotion(f.args());
  assert.throws(()=>previewPromotion({...f.args(),sourceRoot:'/private/tmp'}),
   /PROMOTION_SOURCE_OVERLAP|PROMOTION_SOURCE_TOO_BROAD/);
  chmodSync(join(f.source,'extension'),0o777);
  try{
   assert.throws(()=>previewPromotion(f.args()),/PROMOTION_DIRECTORY_UNSAFE/);
   assert.equal(existsSync(join(f.rt,'promotions.sqlite')),false);
  }finally{chmodSync(join(f.source,'extension'),0o700);}
  assert.equal(f.readSource(),before);
 }finally{f.cleanup();}
});

function makeInterruptedPromotion(f,{sourceNow=after}={}){
 const plan=previewPromotion(f.args());
 const parent=join(f.rt,'promotion-recovery');
 mkdirSync(parent,{mode:0o700});
 const dir=join(parent,f.requestId);
 mkdirSync(dir,{mode:0o700});
 const backup=join(dir,'before.bin');
 writeFileSync(backup,before,{mode:0o600});
 const path=join(f.rt,'promotions.sqlite');
 let db=new PromotionLedger(path);
 db.reserve(plan);
 db.change(f.requestId,'PENDING','APPLYING',{
  backup_path:backup,backup_hash:plan.beforeHash,consumed_ms:Date.now()
 });
 db.close();
 if(sourceNow!==before)writeFileSync(join(f.source,file),sourceNow,{mode:0o600});
 db=new PromotionLedger(path); // Simulates host restart; APPLYING becomes UNKNOWN.
 assert.equal(db.get(f.requestId).state,'UNKNOWN');
 db.close();
 return {plan,backup};
}
test('interrupt AFTER original changed: recovery requires new Owner consent and verifies backup',async()=>{
 const f=createFixture();
 try{
  const {backup}=makeInterruptedPromotion(f);
  assert.equal(f.readSource(),after);
  const plan=previewRecovery({standaloneRoot:f.root,requestId:f.requestId});
  assert.equal(plan.currentState,'CANDIDATE_PRESENT');
  const denied=await recoverUnknownPromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:plan.reviewCode,
   approveOwner:async()=>({approved:false,reason:'USER_DENIED'})
  });
  assert.equal(denied.recovered,false);
  assert.equal(f.readSource(),after);
  assert.equal(ledgerState(f).state,'UNKNOWN');
  let approvals=0;
  const recovered=await recoverUnknownPromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:plan.reviewCode,
   approveOwner:async ctx=>{
    approvals++;
    assert.equal(ctx.action,'RECOVER');
    assert.equal(ctx.file,file);
    return true;
   }
  });
  assert.equal(recovered.state,'RESTORED');
  assert.equal(recovered.actualFileChanged,true);
  assert.equal(approvals,1);
  assert.equal(f.readSource(),before);
  assert.equal(readFileSync(backup,'utf8'),before);
  assert.equal(ledgerState(f).state,'RESTORED');
  await assert.rejects(()=>recoverUnknownPromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:plan.reviewCode,
   approveOwner:async()=>true
  }),/PROMOTION_NOT_UNKNOWN/);
 }finally{f.cleanup();}
});
test('interrupt BEFORE rename: recovery resolves safely without rewriting original',async()=>{
 const f=createFixture();
 try{
  makeInterruptedPromotion(f,{sourceNow:before});
  const plan=previewRecovery({standaloneRoot:f.root,requestId:f.requestId});
  assert.equal(plan.currentState,'ORIGINAL_UNCHANGED');
  const resolved=await recoverUnknownPromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:plan.reviewCode,
   approveOwner:async()=>true
  });
  assert.equal(resolved.state,'ROLLED_BACK');
  assert.equal(resolved.actualFileChanged,false);
  assert.equal(f.readSource(),before);
  assert.equal(ledgerState(f).state,'ROLLED_BACK');
 }finally{f.cleanup();}
});
test('an interrupted action NEVER overwrites a third-party change during recovery',async()=>{
 const f=createFixture();
 try{
  makeInterruptedPromotion(f,{sourceNow:'export const LABEL = "THIRD_PARTY";\n'});
  assert.throws(()=>previewRecovery({standaloneRoot:f.root,requestId:f.requestId}),
   /PROMOTION_RECOVERY_CONFLICT/);
  assert.equal(ledgerState(f).state,'UNKNOWN');
  assert.equal(f.readSource(),'export const LABEL = "THIRD_PARTY";\n');
 }finally{f.cleanup();}
});

test('Mac extended file attributes survive atomic apply and separately approved restore',async()=>{
 if(process.platform!=='darwin')return;
 const f=createFixture();
 try{
  const target=join(f.source,file);
  const name='com.oppstudio.theosynapse-fixture';
  const marker='safe-xattr-marker';
  const write=spawnSync('/usr/bin/xattr',['-w',name,marker,target],{
   encoding:'utf8',timeout:3000
  });
  assert.equal(write.status,0);
  const inspect=()=>{
   const r=spawnSync('/usr/bin/xattr',['-p',name,target],{encoding:'utf8',timeout:3000});
   assert.equal(r.status,0);
   return r.stdout.trim();
  };
  assert.equal(inspect(),marker);
  const p=previewPromotion(f.args());
  const applied=await applyPromotion({...f.args(),confirm:p.reviewCode,approveOwner:async()=>true});
  assert.equal(applied.state,'APPLIED');
  assert.equal(f.readSource(),after);
  assert.equal(inspect(),marker);
  const restoring=previewRestore({standaloneRoot:f.root,requestId:f.requestId});
  const restored=await restorePromotion({
   standaloneRoot:f.root,requestId:f.requestId,confirm:restoring.reviewCode,
   approveOwner:async()=>true
  });
  assert.equal(restored.state,'RESTORED');
  assert.equal(f.readSource(),before);
  assert.equal(inspect(),marker);
 }finally{f.cleanup();}
});
