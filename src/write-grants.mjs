// One-time Owner consent ledger, never exposes grant tokens over MCP.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {lstatSync,realpathSync,openSync,closeSync,constants} from 'node:fs';
import {safeOutput} from './redaction.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const DAY=86400000;
const terminal=new Set(['COMPLETED','REJECTED','DENIED','EXPIRED','UNKNOWN']);
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(x);

function privateFile(path){
 if(path===':memory:')return;
 if(typeof path!=='string'||resolve(path)!==path)throw Error('WRITE_DB_PATH_INVALID');
 const dir=dirname(path),s=lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
    (s.mode&0o077)!==0||realpathSync.native(dir)!==dir)
   throw Error('WRITE_DB_DIRECTORY_UNSAFE');
 try{
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  closeSync(fd);
 }catch(e){if(e.code!=='EEXIST')throw e;}
 const f=lstatSync(path);
 if(!f.isFile()||f.isSymbolicLink()||f.nlink!==1||f.uid!==process.getuid()||
    (f.mode&0o077)!==0)throw Error('WRITE_DB_FILE_UNSAFE');
}
export class OneTimeWriteGrants{
 constructor(filename,{now=()=>Date.now(),requestTTLms=300000,grantTTLms=60000,maxDaily=2}={}){
  if(typeof now!=='function'||!Number.isInteger(requestTTLms)||requestTTLms<1000||
     requestTTLms>600000||!Number.isInteger(grantTTLms)||grantTTLms<1000||
     grantTTLms>120000||!Number.isInteger(maxDaily)||maxDaily<1||maxDaily>5)
   throw Error('WRITE_CONFIG_INVALID');
  this.now=now;this.requestTTLms=requestTTLms;this.grantTTLms=grantTTLms;this.maxDaily=maxDaily;
  privateFile(filename);
  this.db=new DatabaseSync(filename);
  this.db.exec([
   'PRAGMA busy_timeout=1500',
   'PRAGMA journal_mode=WAL',
   "CREATE TABLE IF NOT EXISTS theo_write_requests (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, instruction TEXT NOT NULL, paths_json TEXT NOT NULL, file_hashes_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, plan_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('APPROVAL_PENDING','AUTHORIZED','RUNNING','COMPLETED','REJECTED','DENIED','EXPIRED','UNKNOWN')), created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, request_deadline_ms INTEGER NOT NULL, grant_hash TEXT, grant_deadline_ms INTEGER, consumed_ms INTEGER, outcome_json TEXT)",
   'CREATE TABLE IF NOT EXISTS theo_write_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, at_ms INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)',
   'CREATE INDEX IF NOT EXISTS theo_write_events_by_request ON theo_write_events(request_id,seq)'
  ].join(';\n')+';');
  // An interrupted host can never inherit an Owner's old approval.
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const stale=this.db.prepare("SELECT id,state FROM theo_write_requests WHERE state IN ('APPROVAL_PENDING','AUTHORIZED','RUNNING')").all();
   for(const old of stale){
    const state=old.state==='RUNNING'?'UNKNOWN':'DENIED';
    this.db.prepare('UPDATE theo_write_requests SET state=?,grant_hash=NULL,grant_deadline_ms=NULL,updated_ms=? WHERE id=?')
     .run(state,this.now(),old.id);
    this._event(old.id,state,'Host restart invalidates old consent');
   }
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 _event(id,kind,message){
  const msg=safeOutput(String(message),512).text;
  this.db.prepare('INSERT INTO theo_write_events(request_id,at_ms,kind,text) VALUES(?,?,?,?)')
   .run(id,this.now(),kind,msg);
 }
 get(id){return this.db.prepare('SELECT * FROM theo_write_requests WHERE id=?').get(id)??null;}
 _transition(id,prior,next,reason){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const r=this.db.prepare('UPDATE theo_write_requests SET state=?,updated_ms=? WHERE id=? AND state=?')
    .run(next,this.now(),id,prior);
   if(r.changes!==1)throw Error('WRITE_STATE_CONFLICT');
   this._event(id,next,reason);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 propose(request){
  if(!validId(request?.id)||typeof request.projectId!=='string'||
     !/^[A-Za-z0-9_-]{1,64}$/.test(request.projectId)||
     typeof request.instruction!=='string'||request.instruction.length<12||
     request.instruction.length>240||request.instruction.trim()!==request.instruction||
     /[\x00-\x1f]/.test(request.instruction)||
     !Array.isArray(request.allowedFiles)||request.allowedFiles.length<1||
     request.allowedFiles.length>3||request.allowedFiles.some(x=>typeof x!=='string'||x.length>220)||
     typeof request.snapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(request.snapshotHash)||
     !request.fileHashes||typeof request.fileHashes!=='object')
    throw Error('WRITE_PROPOSAL_INVALID');
  const names=[...new Set(request.allowedFiles)].sort();
  if(names.length!==request.allowedFiles.length)throw Error('WRITE_DUPLICATE_FILE');
  if(Object.keys(request.fileHashes).length!==names.length||
     names.some(p=>!/^[a-f0-9]{64}$/.test(request.fileHashes[p]??'')))
    throw Error('WRITE_FILE_HASH_INVALID');
  const scope={
   projectId:request.projectId,instruction:request.instruction,allowedFiles:names,
   snapshotHash:request.snapshotHash,fileHashes:request.fileHashes,
   mode:'workspace_write',target:'isolated-candidate-only'
  };
  const planHash=sha(JSON.stringify(scope));
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const existing=this.get(request.id);
   if(existing){
    if(existing.plan_hash!==planHash)throw Error('WRITE_REQUEST_ID_CONFLICT');
    this.db.exec('COMMIT');
    return {created:false,...this.status(request.id)};
   }
   const busy=this.db.prepare("SELECT COUNT(*) AS n FROM theo_write_requests WHERE state IN ('APPROVAL_PENDING','AUTHORIZED','RUNNING')").get().n;
   if(busy)throw Error('WRITE_REQUEST_BUSY');
   const day=Math.floor(this.now()/DAY)*DAY;
   const total=this.db.prepare('SELECT COUNT(*) AS n FROM theo_write_requests WHERE created_ms>=? AND created_ms<?').get(day,day+DAY).n;
   if(total>=this.maxDaily)throw Error('WRITE_DAILY_LIMIT');
   const stamp=this.now();
   const sql="INSERT INTO theo_write_requests(id,project_id,instruction,paths_json,file_hashes_json,snapshot_hash,plan_hash,state,created_ms,updated_ms,request_deadline_ms) VALUES(?,?,?,?,?,?,?,'APPROVAL_PENDING',?,?,?)";
   this.db.prepare(sql).run(request.id,request.projectId,request.instruction,
    JSON.stringify(names),JSON.stringify(request.fileHashes),request.snapshotHash,
    planHash,stamp,stamp,stamp+this.requestTTLms);
   this._event(request.id,'APPROVAL_PENDING','Waiting for physical Owner approval');
   this.db.exec('COMMIT');
   return {created:true,...this.status(request.id)};
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 deny(id,reason='OWNER_DENIED'){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  if(r.state==='APPROVAL_PENDING')this._transition(id,'APPROVAL_PENDING','DENIED',reason);
  return this.status(id);
 }
 revoke(id,reason='OWNER_GRANT_INVALIDATED'){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  if(!['APPROVAL_PENDING','AUTHORIZED'].includes(r.state))return this.status(id);
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const updated=this.db.prepare(
    "UPDATE theo_write_requests SET state='DENIED',grant_hash=NULL,grant_deadline_ms=NULL,updated_ms=? WHERE id=? AND state=?"
   ).run(this.now(),id,r.state);
   if(updated.changes!==1)throw Error('WRITE_REVOKE_RACE');
   this._event(id,'DENIED',reason);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return this.status(id);
 }
 authorize(id){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  if(r.state!=='APPROVAL_PENDING')throw Error('WRITE_GRANT_NOT_PENDING');
  if(this.now()>r.request_deadline_ms){
   this._transition(id,'APPROVAL_PENDING','EXPIRED','Approval request expired');
   throw Error('WRITE_APPROVAL_EXPIRED');
  }
  const token=randomBytes(32).toString('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const updated=this.db.prepare("UPDATE theo_write_requests SET state='AUTHORIZED',grant_hash=?,grant_deadline_ms=?,updated_ms=? WHERE id=? AND state='APPROVAL_PENDING' AND request_deadline_ms>=?")
    .run(sha(token),this.now()+this.grantTTLms,this.now(),id,this.now());
   if(updated.changes!==1)throw Error('WRITE_AUTHORIZATION_RACE');
   this._event(id,'AUTHORIZED','Owner granted exactly one isolated write attempt');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return token; // Only trusted host runtime receives token, never MCP.
 }
 consume(id,token){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  if(r.consumed_ms!==null||r.state==='RUNNING'||terminal.has(r.state))
   throw Error('GRANT_ALREADY_USED');
  if(r.state!=='AUTHORIZED'||typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))
   throw Error('GRANT_NOT_AUTHORIZED');
  const supplied=Buffer.from(sha(token),'hex'),expected=Buffer.from(r.grant_hash??'','hex');
  if(expected.length!==32||!timingSafeEqual(supplied,expected))
   throw Error('GRANT_SCOPE_MISMATCH');
  if(this.now()>r.grant_deadline_ms){
   this._transition(id,'AUTHORIZED','EXPIRED','One-time grant expired');
   throw Error('GRANT_EXPIRED');
  }
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const result=this.db.prepare("UPDATE theo_write_requests SET state='RUNNING',consumed_ms=?,grant_hash=NULL,updated_ms=? WHERE id=? AND state='AUTHORIZED' AND consumed_ms IS NULL AND grant_deadline_ms>=?")
    .run(this.now(),this.now(),id,this.now());
   if(result.changes!==1)throw Error('GRANT_ALREADY_USED');
   this._event(id,'RUNNING','Grant burned BEFORE candidate modification or Codex spawn');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return {
   id,projectId:r.project_id,instruction:r.instruction,
   allowedFiles:JSON.parse(r.paths_json),fileHashes:JSON.parse(r.file_hashes_json),
   snapshotHash:r.snapshot_hash,planHash:r.plan_hash
  };
 }
 complete(id,{state,outcome={}}){
  if(!['COMPLETED','REJECTED','UNKNOWN'].includes(state))throw Error('WRITE_TERMINAL_INVALID');
  const r=this.get(id);
  if(!r||r.state!=='RUNNING'||r.consumed_ms===null)
   throw Error('WRITE_FINISH_WRONG_STATE');
  const safe={
   changedFiles:Array.isArray(outcome.changedFiles)?outcome.changedFiles.slice(0,3):[],
   candidateId:typeof outcome.candidateId==='string'?outcome.candidateId.slice(0,80):null,
   baseDigest:/^[a-f0-9]{64}$/.test(outcome.baseDigest??'')?outcome.baseDigest:null,
   candidateDigest:/^[a-f0-9]{64}$/.test(outcome.candidateDigest??'')?outcome.candidateDigest:null,
   changedHashes:Array.isArray(outcome.changedHashes)?outcome.changedHashes.slice(0,3).filter(x=>
    x&&typeof x.path==='string'&&/^[a-f0-9]{64}$/.test(x.before??'')&&
    /^[a-f0-9]{64}$/.test(x.after??'')):[],
   reason:typeof outcome.reason==='string'?outcome.reason.slice(0,80):null,
   providerFinished:outcome.providerFinished===true,
   candidateVerified:outcome.candidateVerified===true
  };
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const res=this.db.prepare('UPDATE theo_write_requests SET state=?,outcome_json=?,updated_ms=? WHERE id=? AND state=?')
    .run(state,JSON.stringify(safe),this.now(),id,'RUNNING');
   if(res.changes!==1)throw Error('WRITE_COMPLETE_RACE');
   this._event(id,state,state==='COMPLETED'?'Staged candidate verified':'Staged result was unverified');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return this.status(id);
 }
 status(id){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  return {
   id:r.id,projectId:r.project_id,state:r.state,
   allowedFiles:JSON.parse(r.paths_json),
   planFingerprint:r.plan_hash.slice(0,20),
   createdAt:new Date(r.created_ms).toISOString(),
   approvalDeadline:new Date(r.request_deadline_ms).toISOString(),
   grantConsumed:r.consumed_ms!==null,
   sourceModified:false
  };
 }
 events(id,after=0,limit=30){
  if(!this.get(id))throw Error('WRITE_REQUEST_NOT_FOUND');
  if(!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100)
   throw Error('WRITE_CURSOR_INVALID');
  return this.db.prepare('SELECT seq,at_ms AS atMs,kind,text FROM theo_write_events WHERE request_id=? AND seq>? ORDER BY seq LIMIT ?')
   .all(id,after,limit);
 }
 result(id){
  const r=this.get(id);
  if(!r)throw Error('WRITE_REQUEST_NOT_FOUND');
  return {
   id:r.id,state:r.state,grantConsumed:r.consumed_ms!==null,
   sourceModified:false,snapshotModified:false,
   candidate:JSON.parse(r.outcome_json??'null'),
   ownerAccepted:false,artifactsApplied:false
  };
 }
 close(){this.db.close();}
}
