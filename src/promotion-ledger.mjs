// Persistent one-time Owner promotion/restore ledger.
// Only one local Owner promotion session may hold this ledger at a time.
// After a host crash, stale locks are removed ONLY if the recorded PID is gone.
import {DatabaseSync} from 'node:sqlite';
import {
 openSync,closeSync,constants,lstatSync,realpathSync,readFileSync,
 writeSync,fsyncSync,unlinkSync
} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve,dirname} from 'node:path';

function privateOwnedFile(path){
 const st=lstatSync(path);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.uid!==process.getuid()||
    (st.mode&0o077)!==0)throw Error('PROMOTION_LEDGER_FILE_UNSAFE');
 return st;
}
function pidAlive(pid){
 try{process.kill(pid,0);return true;}
 catch(e){if(e.code==='ESRCH')return false;return true;}
}
function ownerLock(path){
 const lock=path+'.owner-lock';
 const marker=String(process.pid)+' '+randomBytes(12).toString('hex')+'\n';
 for(let attempt=0;attempt<2;attempt++){
  try{
   const fd=openSync(lock,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{writeSync(fd,marker);fsyncSync(fd);}finally{closeSync(fd);}
   const st=privateOwnedFile(lock);
   return {path:lock,ino:st.ino,marker};
  }catch(e){
   if(e.code!=='EEXIST')throw e;
   const st=privateOwnedFile(lock);
   const raw=readFileSync(lock,'utf8');
   const m=/^([0-9]{1,10}) ([a-f0-9]{24})\n$/.exec(raw);
   if(!m||pidAlive(Number(m[1])))
    throw Error('PROMOTION_OWNER_SESSION_ACTIVE');
   // The recorded process is gone. Recheck inode before removing its stale lock.
   if(privateOwnedFile(lock).ino!==st.ino)
    throw Error('PROMOTION_OWNER_LOCK_RACE');
   unlinkSync(lock);
  }
 }
 throw Error('PROMOTION_OWNER_LOCK_UNAVAILABLE');
}
function releaseOwnerLock(owned){
 const st=privateOwnedFile(owned.path);
 if(st.ino!==owned.ino||readFileSync(owned.path,'utf8')!==owned.marker)
  throw Error('PROMOTION_OWNER_LOCK_TAMPERED');
 unlinkSync(owned.path);
}
export class PromotionLedger{
 constructor(file,{now=()=>Date.now(),maxDaily=3}={}){
  if(typeof file!=='string'||resolve(file)!==file)throw Error('PROMOTION_LEDGER_PATH_INVALID');
  if(typeof now!=='function'||!Number.isInteger(maxDaily)||maxDaily<1||maxDaily>10)
   throw Error('PROMOTION_LEDGER_OPTIONS_INVALID');
  const parent=dirname(file),s=lstatSync(parent);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
     (s.mode&0o077)!==0||realpathSync.native(parent)!==parent)
   throw Error('PROMOTION_LEDGER_PARENT_UNSAFE');
  this.lock=ownerLock(file);
  this.closed=false;this.db=null;
  try{
   try{
    const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    closeSync(fd);
   }catch(e){if(e.code!=='EEXIST')throw e;}
   privateOwnedFile(file);
   this.db=new DatabaseSync(file);
   this.now=now;this.maxDaily=maxDaily;
   this.db.exec([
    'PRAGMA journal_mode=WAL',
    'PRAGMA busy_timeout=1500',
    "CREATE TABLE IF NOT EXISTS promotion_decisions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_root TEXT NOT NULL, file TEXT NOT NULL, plan_digest TEXT NOT NULL, before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, backup_path TEXT, backup_hash TEXT, state TEXT NOT NULL CHECK(state IN ('PENDING','APPLYING','APPLIED','ROLLED_BACK','DENIED','CONFLICT','RESTORING','RESTORED','UNKNOWN')), created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, owner_approved_ms INTEGER, consumed_ms INTEGER, restore_approved_ms INTEGER, error_code TEXT)",
    'CREATE INDEX IF NOT EXISTS promotion_decisions_created ON promotion_decisions(created_ms)'
   ].join(';\n')+';');
   // Fail closed on host restart, never auto-finish an interrupted rename.
   this.db.exec('BEGIN IMMEDIATE');
   try{
    this.db.prepare("UPDATE promotion_decisions SET state='DENIED',error_code='RESTART_DURING_APPROVAL',updated_ms=? WHERE state='PENDING'")
     .run(this.now());
    this.db.prepare("UPDATE promotion_decisions SET state='UNKNOWN',error_code='RESTART_DURING_WRITE',updated_ms=? WHERE state IN ('APPLYING','RESTORING')")
     .run(this.now());
    this.db.exec('COMMIT');
   }catch(e){this.db.exec('ROLLBACK');throw e;}
  }catch(e){
   try{this.db?.close();}catch{}
   releaseOwnerLock(this.lock);
   throw e;
  }
 }
 get(id){return this.db.prepare('SELECT * FROM promotion_decisions WHERE id=?').get(id)??null;}
 reserve(plan){
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(plan?.requestId??'')||
     !/^[a-f0-9]{64}$/.test(plan?.fingerprint??''))
   throw Error('PROMOTION_LEDGER_SCOPE_INVALID');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(this.get(plan.requestId))throw Error('PROMOTION_ALREADY_PROCESSED');
   const busy=this.db.prepare("SELECT COUNT(*) AS n FROM promotion_decisions WHERE state IN ('PENDING','APPLYING','RESTORING')").get().n;
   if(busy!==0)throw Error('PROMOTION_OPERATION_BUSY');
   const day=Math.floor(this.now()/86400000)*86400000;
   const count=this.db.prepare('SELECT COUNT(*) AS n FROM promotion_decisions WHERE created_ms>=? AND created_ms<?').get(day,day+86400000).n;
   if(count>=this.maxDaily)throw Error('PROMOTION_DAILY_LIMIT');
   const ms=this.now();
   this.db.prepare(
    "INSERT INTO promotion_decisions(id,project_id,source_root,file,plan_digest,before_hash,after_hash,state,created_ms,updated_ms) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)"
   ).run(plan.requestId,plan.projectId,plan.sourceRoot,plan.relativeFile,plan.fingerprint,
    plan.beforeHash,plan.afterHash,ms,ms);
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 change(id,from,to,fields={}){
  const allowed={
   DENIED:['PENDING'],CONFLICT:['PENDING'],
   APPLYING:['PENDING'],APPLIED:['APPLYING'],
   UNKNOWN:['APPLYING','RESTORING'],ROLLED_BACK:['APPLYING','UNKNOWN'],
   RESTORING:['APPLIED','UNKNOWN'],RESTORED:['RESTORING']
  };
  if(!allowed[to]?.includes(from))throw Error('PROMOTION_INVALID_TRANSITION');
  const expected=this.get(id);
  if(!expected||expected.state!==from)throw Error('PROMOTION_STATE_CONFLICT');
  const stamp=this.now();
  const entries=Object.entries(fields);
  const allowedFields=new Set([
   'backup_path','backup_hash','owner_approved_ms','consumed_ms','restore_approved_ms','error_code'
  ]);
  if(entries.some(([k])=>!allowedFields.has(k)))throw Error('PROMOTION_FIELD_INVALID');
  const update=['state=?','updated_ms=?',...entries.map(([k])=>k+'=?')].join(',');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const sql='UPDATE promotion_decisions SET '+update+' WHERE id=? AND state=?';
   const out=this.db.prepare(sql).run(to,stamp,...entries.map(([,v])=>v),id,from);
   if(out.changes!==1)throw Error('PROMOTION_RACE');
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return this.get(id);
 }
 close(){
  if(this.closed)return;
  this.closed=true;
  try{this.db?.close();}
  finally{releaseOwnerLock(this.lock);}
 }
}
