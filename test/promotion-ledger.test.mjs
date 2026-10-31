import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,symlinkSync,lstatSync
} from 'node:fs';
import {join} from 'node:path';
import {PromotionLedger} from '../src/promotion-ledger.mjs';

const plan=(id='theo-promotion-ledger-0001')=>({
 requestId:id,projectId:'fixture-project',
 sourceRoot:'/private/tmp/fixture-owner-original',
 relativeFile:'extension/demo.js',
 fingerprint:'a'.repeat(64),beforeHash:'b'.repeat(64),afterHash:'c'.repeat(64)
});
const fixture=()=>{
 const root=mkdtempSync('/private/tmp/theo-promotion-ledger-');
 return {root,path:join(root,'promotions.sqlite'),cleanup:()=>rmSync(root,{recursive:true,force:true})};
};
test('one Owner ledger writer lock rejects concurrency without invalidating live approval',()=>{
 const f=fixture();
 try{
  let first=new PromotionLedger(f.path);
  first.reserve(plan());
  assert.equal(first.get(plan().requestId).state,'PENDING');
  assert.throws(()=>new PromotionLedger(f.path),/PROMOTION_OWNER_SESSION_ACTIVE/);
  assert.equal(first.get(plan().requestId).state,'PENDING');
  const lock=f.path+'.owner-lock';
  assert.equal(existsSync(lock),true);
  assert.equal(lstatSync(lock).mode&0o077,0);
  first.close();
  assert.equal(existsSync(lock),false);
  const after=new PromotionLedger(f.path);
  assert.equal(after.get(plan().requestId).state,'DENIED');
  assert.equal(after.get(plan().requestId).error_code,'RESTART_DURING_APPROVAL');
  after.close();
 }finally{f.cleanup();}
});
test('stale lock left by a dead process is recovered without granting execution permission',()=>{
 const f=fixture();
 try{
  const lock=f.path+'.owner-lock';
  writeFileSync(lock,'99999999 '+'a'.repeat(24)+'\n',{mode:0o600});
  const db=new PromotionLedger(f.path);
  assert.equal(existsSync(lock),true);
  assert.match(readFileSync(lock,'utf8'),new RegExp('^'+process.pid+' '));
  db.close();
  assert.equal(existsSync(lock),false);
 }finally{f.cleanup();}
});
test('malformed or symlink owner lock blocks promotion and is not silently removed',()=>{
 const f=fixture();
 try{
  const lock=f.path+'.owner-lock',fake=join(f.root,'unrelated.key');
  writeFileSync(fake,'DO NOT MODIFY',{mode:0o600});
  symlinkSync(fake,lock);
  assert.throws(()=>new PromotionLedger(f.path),/PROMOTION_LEDGER_FILE_UNSAFE/);
  assert.equal(readFileSync(fake,'utf8'),'DO NOT MODIFY');
  assert.equal(existsSync(lock),true);
 }finally{f.cleanup();}
});
test('daily bounds and one-shot status transitions forbid duplicate promotion',()=>{
 const f=fixture();
 let db;
 try{
  let time=1780000000000;
  db=new PromotionLedger(f.path,{now:()=>time,maxDaily:2});
  db.reserve(plan());
  db.change(plan().requestId,'PENDING','DENIED',{error_code:'USER_DENIED'});
  db.reserve(plan('theo-promotion-ledger-0002'));
  db.change('theo-promotion-ledger-0002','PENDING','CONFLICT',{
   error_code:'PROMOTION_SOURCE_HAS_CHANGED'
  });
  assert.throws(()=>db.reserve(plan('theo-promotion-ledger-0003')),/PROMOTION_DAILY_LIMIT/);
  assert.throws(()=>db.reserve(plan()),/PROMOTION_ALREADY_PROCESSED/);
  assert.throws(()=>db.change(plan().requestId,'DENIED','APPLIED'),/PROMOTION_INVALID_TRANSITION/);
  assert.deepEqual(db.get(plan().requestId).state,'DENIED');
 }finally{db?.close();f.cleanup();}
});
test('restart cannot silently complete an interrupted rename or restore',()=>{
 const f=fixture();
 try{
  let db=new PromotionLedger(f.path);
  db.reserve(plan());
  db.change(plan().requestId,'PENDING','APPLYING',{consumed_ms:Date.now()});
  db.close();
  db=new PromotionLedger(f.path);
  assert.equal(db.get(plan().requestId).state,'UNKNOWN');
  assert.equal(db.get(plan().requestId).error_code,'RESTART_DURING_WRITE');
  assert.throws(()=>db.reserve(plan()),/PROMOTION_ALREADY_PROCESSED/);
  db.close();
 }finally{f.cleanup();}
});
