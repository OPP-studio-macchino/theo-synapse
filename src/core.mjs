import {DatabaseSync} from 'node:sqlite';
import {realpathSync,lstatSync} from 'node:fs';
import {resolve,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
export function projectPath(path){const p=resolve(path);if(lstatSync(p).isSymbolicLink())throw Error('SYMLINK_DENIED');const real=realpathSync(p);if(real!==p)throw Error('PATH_ALIAS_DENIED');return real;}
export function inside(root,path){const r=projectPath(root),p=realpathSync(path);if(p!==r&&!p.startsWith(r+sep))throw Error('OUTSIDE_PROJECT');return p;}
export class Journal{
 constructor(file){this.db=new DatabaseSync(file);this.db.exec("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project TEXT NOT NULL, digest TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, write_closed INTEGER NOT NULL, result TEXT);CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL);");}
 start({id,project,mode,prompt}){if(!['read_only','workspace_write'].includes(mode))throw Error('INVALID_MODE');const digest=createHash('sha256').update(JSON.stringify({project,mode,prompt})).digest('hex');const old=this.get(id);if(old){if(old.digest!==digest)throw Error('ID_CONFLICT');return {created:false,run:old};}if(mode==='workspace_write'&&this.db.prepare("SELECT 1 FROM runs WHERE project=? AND mode='workspace_write' AND write_closed=0").get(project))throw Error('WRITER_BUSY');const run={id,project,digest,mode,state:'QUEUED',write_closed:mode==='read_only'?1:0};this.db.prepare('INSERT INTO runs(id,project,digest,mode,state,write_closed) VALUES(?,?,?,?,?,?)').run(id,project,digest,mode,run.state,run.write_closed);this.event(id,'QUEUED',{});return {created:true,run};}
 get(id){return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);}
 event(id,kind,payload){this.db.prepare('INSERT INTO events(id,kind,payload) VALUES(?,?,?)').run(id,kind,JSON.stringify(payload));}
 events(id){return this.db.prepare('SELECT * FROM events WHERE id=? ORDER BY seq').all(id);}
 transition(id,state,result=null){const run=this.get(id);if(!run)throw Error('NOT_FOUND');if(!['QUEUED','RUNNING','UNKNOWN','STOP_REQUESTED','STOPPED','FAILED','COMPLETED'].includes(state))throw Error('INVALID_STATE');if(run.state==='UNKNOWN'&&state==='RUNNING')throw Error('UNKNOWN_NO_RETRY');this.db.prepare('UPDATE runs SET state=?,result=? WHERE id=?').run(state,result,id);this.event(id,state,{});}
 closeWrite(id){const run=this.get(id);if(!run||!['STOPPED','FAILED','COMPLETED'].includes(run.state))throw Error('NOT_TERMINAL');this.db.prepare('UPDATE runs SET write_closed=1 WHERE id=?').run(id);this.event(id,'WRITE_CLOSED',{});}
 close(){this.db.close();}
}
export const newId=()=>randomUUID();
