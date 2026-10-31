import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OneTimeWriteGrants} from '../src/write-grants.mjs';

const fnHash='a'.repeat(64);
const req=(id='theo-grant-0001')=>({
 id,projectId:'chappy-signal',
 instruction:'Change the visible test label inside extension/demo.js only.',
 allowedFiles:['extension/demo.js'],
 snapshotHash:'b'.repeat(64),fileHashes:{'extension/demo.js':fnHash}
});
test('grant is Owner-bound, 1 use, consumed BEFORE action, cannot replay',()=>{
 let now=1780000000000;
 const db=new OneTimeWriteGrants(':memory:',{now:()=>now});
 try{
  const first=db.propose(req());
  assert.equal(first.created,true);
  assert.equal(first.state,'APPROVAL_PENDING');
  assert.equal(db.propose(req()).created,false);
  assert.throws(()=>db.propose({...req(),instruction:'Different instruction 123'}),/WRITE_REQUEST_ID_CONFLICT/);
  assert.throws(()=>db.consume(req().id,'abcd'),/GRANT_NOT_AUTHORIZED/);
  const token=db.authorize(req().id);
  assert.equal(typeof token,'string');
  assert.equal(token.length,64);
  assert.equal(JSON.stringify(db.status(req().id)).includes(token),false);
  assert.equal(JSON.stringify(db.events(req().id)).includes(token),false);
  assert.throws(()=>db.consume(req().id,'f'.repeat(64)),/GRANT_SCOPE_MISMATCH/);
  const permission=db.consume(req().id,token);
  assert.deepEqual(permission.allowedFiles,['extension/demo.js']);
  assert.equal(permission.projectId,'chappy-signal');
  assert.equal(db.status(req().id).grantConsumed,true);
  assert.throws(()=>db.consume(req().id,token),/GRANT_ALREADY_USED/);
  const completed=db.complete(req().id,{state:'COMPLETED',outcome:{
   changedFiles:['extension/demo.js'],candidateId:'theo-grant-0001',
   providerFinished:true,candidateVerified:true
  }});
  assert.equal(completed.state,'COMPLETED');
  assert.equal(db.result(req().id).artifactsApplied,false);
  assert.equal(db.result(req().id).sourceModified,false);
  assert.equal(db.result(req().id).candidate.candidateVerified,true);
  assert.throws(()=>db.consume(req().id,token),/GRANT_ALREADY_USED/);
 }finally{db.close();}
});
test('denial, TTL expiry and restart revoke consent rather than retry',()=>{
 let now=1780000000000;
 const db=new OneTimeWriteGrants(':memory:',{now:()=>now,requestTTLms:4000,grantTTLms:2000,maxDaily:3});
 try{
  db.propose(req());
  assert.equal(db.deny(req().id).state,'DENIED');
  assert.throws(()=>db.authorize(req().id),/WRITE_GRANT_NOT_PENDING/);
  assert.equal(db.propose(req('theo-grant-0002')).state,'APPROVAL_PENDING');
  now+=4001;
  assert.throws(()=>db.authorize('theo-grant-0002'),/WRITE_APPROVAL_EXPIRED/);
  assert.equal(db.status('theo-grant-0002').state,'EXPIRED');
  const t=db.propose(req('theo-grant-0003'));
  const token=db.authorize(t.id);
  now+=2001;
  assert.throws(()=>db.consume(t.id,token),/GRANT_EXPIRED/);
  assert.equal(db.status(t.id).state,'EXPIRED');
 }finally{db.close();}
});
test('enforces single active proposal and limits daily write attempts',()=>{
 let now=1780000000000;
 const db=new OneTimeWriteGrants(':memory:',{now:()=>now,maxDaily:2});
 try{
  db.propose(req());
  assert.throws(()=>db.propose(req('theo-grant-busy')),/WRITE_REQUEST_BUSY/);
  db.deny(req().id);
  db.propose(req('theo-grant-0002'));
  db.deny('theo-grant-0002');
  assert.throws(()=>db.propose(req('theo-grant-0003')),/WRITE_DAILY_LIMIT/);
 }finally{db.close();}
});
test('persistent SQLite restart denies pending or unconsumed grants, marks interrupted work UNKNOWN',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path');
 const dir=mkdtempSync('/private/tmp/theo-grant-ledger-');
 const path=join(dir,'write-journal.sqlite');
 let now=1780000000000;
 try{
  let db=new OneTimeWriteGrants(path,{now:()=>now});
  db.propose(req());
  db.authorize(req().id);
  db.close();
  db=new OneTimeWriteGrants(path,{now:()=>now});
  assert.equal(db.status(req().id).state,'DENIED');
  assert.equal(db.status(req().id).grantConsumed,false);
  db.propose(req('theo-grant-0002'));
  const token=db.authorize('theo-grant-0002');
  db.consume('theo-grant-0002',token);
  db.close();
  db=new OneTimeWriteGrants(path,{now:()=>now});
  assert.equal(db.status('theo-grant-0002').state,'UNKNOWN');
  assert.equal(db.status('theo-grant-0002').grantConsumed,true);
  assert.throws(()=>db.consume('theo-grant-0002',token),/GRANT_ALREADY_USED/);
  db.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('an authorized but unconsumed grant is explicitly revocable',()=>{
 const db=new OneTimeWriteGrants(':memory:');
 try{
  const scope=req('theo-grant-revoke1');
  db.propose(scope);
  const token=db.authorize(scope.id);
  const before=db.status(scope.id);
  assert.equal(before.state,'AUTHORIZED');
  const after=db.revoke(scope.id,'OWNER_REVOKED');
  assert.equal(after.state,'DENIED');
  assert.equal(after.grantConsumed,false);
  assert.throws(()=>db.consume(scope.id,token),/GRANT_ALREADY_USED/);
 }finally{db.close();}
});
