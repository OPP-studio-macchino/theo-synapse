// Host-injected direct Codex execution. It is deliberately not wired into the daemon.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync,realpathSync,statSync,openSync,closeSync,constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {safeOutput} from './redaction.mjs';
import {CodexAppServer} from './codex-adapter.mjs';

const iso=()=>new Date().toISOString();
const active="('APPROVAL_PENDING','QUEUED','RUNNING')";
const diagnosisCodes=new Set([
 'DIRECT_TIMEOUT','CODEX_RPC_TIMEOUT','CODEX_EFFECTIVE_POLICY_UNVERIFIED',
 'DIRECT_HOST_CLOSED','DIRECT_EXECUTION_UNVERIFIED','DIRECT_OWNER_DENIED',
 // Static, source-defined stages only. Never persist provider text, paths, prompts or keys.
 'CODEX_RPC_INITIALIZE_REJECTED','CODEX_RPC_THREAD_START_REJECTED','CODEX_RPC_TURN_START_REJECTED',
 'APPROVAL_REQUEST_DENIED','CODEX_SPAWN_ERROR','CODEX_DISCONNECTED','CODEX_NOT_CONNECTED',
 'CODEX_TURN_ID_MISSING','DIRECT_TERMINAL_UNVERIFIED','DIRECT_MISSING_TERMINAL',
 'CODEX_TURN_INTERRUPTED','CODEX_BAD_MESSAGE','CODEX_BAD_JSON','CODEX_STREAM_ERROR'
]);
function diagnosisCode(error){
 const code=typeof error==='string'?error:(typeof error?.message==='string'?error.message:'');
 return diagnosisCodes.has(code)?code:'DIRECT_EXECUTION_UNVERIFIED';
}
const storedDiagnosisCode=code=>code===null||code===undefined?null:(diagnosisCodes.has(code)?code:'DIRECT_EXECUTION_UNVERIFIED');
function journalFile(file){
 if(file===':memory:')return;
 if(typeof file!=='string'||resolve(file)!==file)throw Error('DIRECT_JOURNAL_PATH_INVALID');
 const dir=dirname(file),d=lstatSync(dir);
 if(!d.isDirectory()||d.isSymbolicLink()||realpathSync.native(dir)!==dir||d.uid!==process.getuid?.()||(d.mode&0o077)!==0)throw Error('DIRECT_JOURNAL_DIRECTORY_UNSAFE');
 try{const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);}catch(e){if(e.code!=='EEXIST')throw e;}
 const f=lstatSync(file);if(!f.isFile()||f.isSymbolicLink()||f.nlink!==1||f.uid!==process.getuid?.()||(f.mode&0o077)!==0)throw Error('DIRECT_JOURNAL_FILE_UNSAFE');
}
function validTask(v){return typeof v==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(v);}
function validWorkspace(v){return typeof v==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(v);}
function runId(task,iteration){return `${task}:${iteration}`;}

export class DirectCoordinator {
 constructor({workspaces,journalPath,adapterFactory,ownerAuthorization=()=>false,authorizationRecheck=()=>true,maxDurationMs=300000}={}){
  if(!workspaces||typeof workspaces!=='object'||Array.isArray(workspaces)||typeof adapterFactory!=='function')throw Error('DIRECT_HOST_CONFIGURATION_REQUIRED');
  if(typeof journalPath!=='string'||journalPath===':memory:')throw Error('DIRECT_PERSISTENT_JOURNAL_REQUIRED');
  this.workspaces=new Map();
  for(const [id,configuredRoot] of Object.entries(workspaces)){
   if(id==='chappy-signal')throw Error('DIRECT_FORBIDDEN_NATIVE_PROJECT');
   if(!validWorkspace(id)||typeof configuredRoot!=='string')throw Error('INVALID_DIRECT_WORKSPACE');
   const root=resolve(configuredRoot),st=lstatSync(root),real=realpathSync.native(root);
   if(!st.isDirectory()||st.isSymbolicLink()||real!==root||statSync(root).uid!==process.getuid?.())throw Error('UNSAFE_DIRECT_WORKSPACE');
   this.workspaces.set(id,root);
  }
  if(!this.workspaces.size||!Number.isInteger(maxDurationMs)||maxDurationMs<250||maxDurationMs>900000)throw Error('INVALID_DIRECT_CONFIGURATION');
  if(typeof ownerAuthorization!=='function'||typeof authorizationRecheck!=='function')throw Error('DIRECT_OWNER_AUTHORIZATION_INVALID');
  journalFile(journalPath);this.db=new DatabaseSync(journalPath);this.adapterFactory=adapterFactory;this.ownerAuthorization=ownerAuthorization;this.authorizationRecheck=authorizationRecheck;this.maxDurationMs=maxDurationMs;this.running=new Map();this.abortWaiters=new Map();this.approvals=new Map();this.closed=false;
  this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
   CREATE TABLE IF NOT EXISTS direct_runs (task_id TEXT NOT NULL, iteration INTEGER NOT NULL, workspace_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('read_only','workspace_write')), digest TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,iteration));
   CREATE INDEX IF NOT EXISTS direct_runs_state ON direct_runs(state);
  `);
  if(!this.db.prepare("SELECT 1 FROM pragma_table_info('direct_runs') WHERE name='error_code'").get())
   this.db.exec('ALTER TABLE direct_runs ADD COLUMN error_code TEXT');
  const lost=this.db.prepare(`SELECT task_id,iteration FROM direct_runs WHERE state IN ${active}`).all();
  this.db.exec('BEGIN IMMEDIATE');try{for(const r of lost)this.db.prepare("UPDATE direct_runs SET state='UNKNOWN',error_code='DIRECT_EXECUTION_UNVERIFIED',updated_at=? WHERE task_id=? AND iteration=?").run(iso(),r.task_id,r.iteration);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 _get(taskId,iteration){return this.db.prepare('SELECT * FROM direct_runs WHERE task_id=? AND iteration=?').get(taskId,iteration)??null;}
 _transition(taskId,iteration,state,result=null,errorCode=null){const before=this._get(taskId,iteration);if(!before||!{APPROVAL_PENDING:['QUEUED','DENIED','UNKNOWN'],QUEUED:['RUNNING','UNKNOWN'],RUNNING:['COMPLETED','FAILED','UNKNOWN']}[before.state]?.includes(state))throw Error('DIRECT_INVALID_TRANSITION');this.db.prepare('UPDATE direct_runs SET state=?,result=?,error_code=?,updated_at=? WHERE task_id=? AND iteration=?').run(state,result===null?before.result:safeOutput(result,8192).text,errorCode===null?null:diagnosisCode(errorCode),iso(),taskId,iteration);return this._get(taskId,iteration);}
 _view(r){return {task_id:r.task_id,run_id:runId(r.task_id,r.iteration),iteration:r.iteration,workspace_id:r.workspace_id,execution_mode:r.mode,state:r.state,result:r.result??null,reasonCode:storedDiagnosisCode(r.error_code),providerFinished:['COMPLETED','FAILED'].includes(r.state)};}
 start({task_id,iteration,instruction,execution_mode='read_only',workspace_id}={}){
  if(this.closed)throw Error('DIRECT_COORDINATOR_CLOSED');
  if(!validTask(task_id)||!Number.isInteger(iteration)||iteration<1||iteration>9999||typeof instruction!=='string'||!instruction.length||Buffer.byteLength(instruction)>12288||!['read_only','workspace_write'].includes(execution_mode))throw Error('INVALID_DIRECT_REQUEST');
  const workspace=workspace_id??(this.workspaces.size===1?[...this.workspaces.keys()][0]:null);if(!workspace||!this.workspaces.has(workspace))throw Error('DIRECT_WORKSPACE_NOT_REGISTERED');
  if(workspace==='theo-lab'&&execution_mode==='workspace_write')throw Error('DIRECT_LAB_READONLY');
  const existingTask=this.db.prepare('SELECT workspace_id,mode FROM direct_runs WHERE task_id=? LIMIT 1').get(task_id);
  if(existingTask&&(existingTask.workspace_id!==workspace||existingTask.mode!==execution_mode))throw Error('DIRECT_TASK_BINDING_CONFLICT');
  const digest=createHash('sha256').update(JSON.stringify({workspace,instruction,execution_mode,iteration})).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');let created=false,row,approval=null,controller=null;try{row=this._get(task_id,iteration);if(row){if(row.digest!==digest)throw Error('DIRECT_RUN_CONFLICT');}else{
   // Reject conflicting or over-budget work before displaying an Owner dialog.
   if(this.db.prepare(`SELECT COUNT(*) AS n FROM direct_runs WHERE state IN ${active}`).get().n)throw Error('DIRECT_ANOTHER_RUN_ACTIVE');
   const day=iso().slice(0,10),n=this.db.prepare('SELECT COUNT(*) AS n FROM direct_runs WHERE created_at>=? AND created_at<?').get(day+'T00:00:00',day+'T~').n;if(n>=8)throw Error('DIRECT_DAILY_LIMIT');
   if(execution_mode==='workspace_write'){
    controller=new AbortController();
    approval=this.ownerAuthorization({taskId:task_id,iteration,workspaceId:workspace,workspaceRoot:this.workspaces.get(workspace),instructionDigest:digest,timeoutMs:30000},{signal:controller.signal});
   }
   if(execution_mode==='workspace_write'&&approval!==true&&!(approval&&typeof approval.then==='function'))throw Error('DIRECT_OWNER_AUTHORIZATION_REQUIRED');
   const at=iso(),state=approval&&typeof approval.then==='function'?'APPROVAL_PENDING':'QUEUED';this.db.prepare('INSERT INTO direct_runs (task_id,iteration,workspace_id,mode,digest,state,result,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(task_id,iteration,workspace,execution_mode,digest,state,null,null,at,at);row=this._get(task_id,iteration);created=true;
  }this.db.exec('COMMIT');}catch(e){controller?.abort();if(approval&&typeof approval.catch==='function')approval.catch(()=>{});this.db.exec('ROLLBACK');throw e;}
  if(created&&row.state==='QUEUED')queueMicrotask(()=>this.run(task_id,iteration,instruction).catch(()=>{}));
  if(created&&row.state==='APPROVAL_PENDING')this.resolveApproval(task_id,iteration,instruction,approval,controller);
  return {...this._view(row),created};
 }
 async resolveApproval(taskId,iteration,instruction,approval,controller){
  this.approvals.set(runId(taskId,iteration),controller);
  try{const approved=await approval;if(this.closed||controller.signal.aborted||this._get(taskId,iteration)?.state!=='APPROVAL_PENDING')return;
   const row=this._get(taskId,iteration);const valid=approved===true&&await this.authorizationRecheck({taskId,iteration,workspaceId:row.workspace_id,workspaceRoot:this.workspaces.get(row.workspace_id),instructionDigest:row.digest});
   this._transition(taskId,iteration,valid?'QUEUED':'DENIED',null,valid?null:'DIRECT_OWNER_DENIED');if(valid)queueMicrotask(()=>this.run(taskId,iteration,instruction).catch(()=>{}));
  }catch{try{if(!this.closed&&this._get(taskId,iteration)?.state==='APPROVAL_PENDING')this._transition(taskId,iteration,'DENIED',null,'DIRECT_OWNER_DENIED');}catch{}}
  finally{this.approvals.delete(runId(taskId,iteration));}
 }
 async run(taskId,iteration,instruction){
  if(this.closed||this._get(taskId,iteration)?.state!=='QUEUED')return;this._transition(taskId,iteration,'RUNNING');const row=this._get(taskId,iteration),root=this.workspaces.get(row.workspace_id);let adapter,timer,terminal=false;
  try{adapter=this.adapterFactory({workspaceId:row.workspace_id,projectRoot:root,executionMode:row.mode,taskId,iteration});if(!adapter||typeof adapter.execute!=='function')throw Error('DIRECT_NO_ADAPTER');this.running.set(runId(taskId,iteration),adapter);
   const timeout=new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('DIRECT_TIMEOUT')),this.maxDurationMs));
   const aborted=new Promise((_,reject)=>this.abortWaiters.set(runId(taskId,iteration),()=>reject(Error('DIRECT_HOST_CLOSED'))));
   const execute=adapter.execute({
    projectRoot:root,prompt:instruction,executionMode:row.mode,
    onEvent:event=>{
     if(this.closed||event?.kind!=='terminal')return;
     const state={completed:'COMPLETED',failed:'FAILED',interrupted:'UNKNOWN'}[event.status];
     if(!state)throw Error('DIRECT_TERMINAL_UNVERIFIED');
     this._transition(taskId,iteration,state,state==='UNKNOWN'?null:String(event.output??''),state==='UNKNOWN'?'CODEX_TURN_INTERRUPTED':null);terminal=true;
    }
   });
   await Promise.race([execute,timeout,aborted]);
   if(!terminal)throw Error('DIRECT_MISSING_TERMINAL');
  }catch(error){if(!this.closed&&['QUEUED','RUNNING'].includes(this._get(taskId,iteration)?.state))this._transition(taskId,iteration,'UNKNOWN',null,diagnosisCode(error));}finally{clearTimeout(timer);this.abortWaiters.delete(runId(taskId,iteration));try{await adapter?.disconnect?.();}catch{}this.running.delete(runId(taskId,iteration));}
 }
 wait({task_id,run_id,workspace_id}={}){if(!validTask(task_id))throw Error('INVALID_DIRECT_TASK');const parts=typeof run_id==='string'?run_id.split(':'):[];const iteration=parts.length===2&&parts[0]===task_id&&/^[1-9]\d{0,3}$/.test(parts[1])?Number(parts[1]):null;if(!iteration)throw Error('DIRECT_RUN_ID_REQUIRED');const r=this._get(task_id,iteration);if(!r)throw Error('DIRECT_RUN_NOT_FOUND');if(workspace_id!==undefined&&workspace_id!==r.workspace_id)throw Error('DIRECT_WORKSPACE_MISMATCH');return this._view(r);}
 hasActiveRun(){return this.db.prepare(`SELECT COUNT(*) AS n FROM direct_runs WHERE state IN ${active}`).get().n>0;}
 close(){
  if(this.closed)return;
  this.closed=true;
  for(const controller of this.approvals.values())controller.abort();
  for(const abort of this.abortWaiters.values())abort();
  for(const adapter of this.running.values())try{adapter?.disconnect?.();}catch{}
  this.db.prepare("UPDATE direct_runs SET state='UNKNOWN',error_code='DIRECT_HOST_CLOSED',updated_at=? WHERE state IN ('APPROVAL_PENDING','QUEUED','RUNNING')").run(iso());
  this.db.close();
 }
}

export function codexDirectAdapterFactory({executable,ownerActionApproval=null}={}){
 if(typeof executable!=='string'||!executable.startsWith('/'))throw Error('INVALID_DIRECT_CODEX_EXECUTABLE');
 if(ownerActionApproval!==null&&typeof ownerActionApproval!=='function')throw Error('INVALID_DIRECT_OWNER_ACTION_APPROVAL');
 return ({projectRoot,executionMode,taskId,workspaceId})=>new CodexAppServer(executable,projectRoot,{
  taskId,ownerActionApproval:executionMode==='workspace_write'&&ownerActionApproval?
   (review,options)=>ownerActionApproval({...review,taskId,workspaceId,workspaceRoot:projectRoot},options):null
 });
}
