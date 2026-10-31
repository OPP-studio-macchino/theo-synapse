import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {lstatSync,realpathSync,openSync,closeSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import { safeOutput } from './redaction.mjs';

const transitions = {
  QUEUED: new Set(['RUNNING','STOPPED','FAILED','UNKNOWN']),
  RUNNING: new Set(['COMPLETED','FAILED','STOP_REQUESTED','UNKNOWN']),
  STOP_REQUESTED: new Set(['STOPPED','FAILED','UNKNOWN']),
  COMPLETED: new Set(), FAILED: new Set(), STOPPED: new Set(), UNKNOWN: new Set()
};
const iso = () => new Date().toISOString();
function privateJournalFile(filename) {
  if(filename===':memory:')return;
  if(typeof filename!=='string'||resolve(filename)!==filename)throw Error('JOURNAL_PATH_INVALID');
  const directory=dirname(filename),dir=lstatSync(directory);
  if(!dir.isDirectory()||dir.isSymbolicLink()||realpathSync.native(directory)!==directory||
    dir.uid!==process.getuid?.()||(dir.mode&0o077)!==0)throw Error('JOURNAL_DIRECTORY_UNSAFE');
  try{const fd=openSync(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);}
  catch(e){if(e.code!=='EEXIST')throw e;}
  const file=lstatSync(filename);
  if(!file.isFile()||file.isSymbolicLink()||file.nlink!==1||file.uid!==process.getuid?.()||
    (file.mode&0o077)!==0)throw Error('JOURNAL_FILE_UNSAFE');
}
export class TaskStore {
  constructor(filename=':memory:') {
    privateJournalFile(filename);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS standalone_tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, digest TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode='read_only'),
        state TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS standalone_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        FOREIGN KEY(task_id) REFERENCES standalone_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS standalone_events_task_seq ON standalone_events(task_id,seq);
    `);
    // Interrupted host means UNKNOWN. Never silently restart tasks.
    const orphaned=this.db.prepare("SELECT id FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").all();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const {id} of orphaned){
        this.db.prepare("UPDATE standalone_tasks SET state='UNKNOWN',updated_at=? WHERE id=?").run(iso(),id);
        this._event(id,'UNKNOWN','Recovered after interruption; execution not verified');
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  get(id) {
    return this.db.prepare('SELECT * FROM standalone_tasks WHERE id=?').get(id) ?? null;
  }
  reserve({id,projectId,prompt,mode}) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw Error('INVALID_TASK_ID');
    if (mode !== 'read_only') throw Error('WRITE_NOT_AUTHORIZED');
    if (typeof projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw Error('INVALID_PROJECT');
    if (typeof prompt !== 'string' || prompt.length < 1 || Buffer.byteLength(prompt) > 12288) throw Error('INVALID_PROMPT');
    const digest = createHash('sha256').update(JSON.stringify({projectId,prompt,mode})).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior=this.get(id);
      if (prior) {
        if (prior.digest!==digest) throw Error('TASK_ID_CONFLICT');
        this.db.exec('COMMIT');
        return {created:false,run:prior};
      }
      // Provider access is deliberately serialized: one active read-only turn.
      // Idempotent retries above remain allowed without allocating another turn.
      const busy=this.db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").get().n;
      if(busy>0)throw Error('ANOTHER_TASK_ACTIVE');
      const today=iso().slice(0,10);
      const daily=this.db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE created_at>=? AND created_at<?").get(today+'T00:00:00',today+'T~').n;
      if(daily>=8)throw Error('DAILY_TASK_LIMIT');
      const at=iso();
      this.db.prepare('INSERT INTO standalone_tasks(id,project_id,digest,mode,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,projectId,digest,mode,'QUEUED',at,at);
      this._event(id,'QUEUED','Task accepted');
      const run=this.get(id);
      this.db.exec('COMMIT');
      return {created:true,run};
    } catch(e) {
      this.db.exec('ROLLBACK'); throw e;
    }
  }
  _event(id,kind,text) {
    const value=safeOutput(text,4096);
    this.db.prepare('INSERT INTO standalone_events(task_id,at,kind,text) VALUES(?,?,?,?)').run(id,iso(),kind,value.text);
  }
  progress(id,kind,text) {
    const current=this.get(id);
    if (!current || !['RUNNING','STOP_REQUESTED'].includes(current.state)) return false;
    const total=this.db.prepare('SELECT COUNT(*) AS total FROM standalone_events WHERE task_id=?').get(id).total;
    if (total>=200) return false;
    this._event(id,kind,text);
    return true;
  }
  transition(id,next,result=null) {
    const prior=this.get(id);
    if (!prior) throw Error('TASK_NOT_FOUND');
    if (!transitions[prior.state]?.has(next)) throw Error('INVALID_TRANSITION');
    const resultText=result===null?prior.result:safeOutput(result,8192).text;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE standalone_tasks SET state=?,result=?,updated_at=? WHERE id=? AND state=?').run(next,resultText,iso(),id,prior.state);
      this._event(id,next,next);
      this.db.exec('COMMIT');
      return this.get(id);
    } catch(e) {this.db.exec('ROLLBACK');throw e;}
  }
  events(id,after=0,limit=30) {
    if(!this.get(id)) throw Error('TASK_NOT_FOUND');
    if (!Number.isInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>100) throw Error('BAD_CURSOR');
    return this.db.prepare('SELECT seq,at,kind,text FROM standalone_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit);
  }
  result(id) {
    const r=this.get(id);
    if (!r) throw Error('TASK_NOT_FOUND');
    return {id:r.id,state:r.state,providerFinished:['COMPLETED','FAILED','STOPPED'].includes(r.state),
      output:r.result??null, testsVerified:false,artifactsVerified:false,requirementsMet:false,ownerAccepted:false,userReported:false};
  }
  close() {this.db.close();}
}
