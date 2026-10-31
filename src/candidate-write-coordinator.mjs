// Owner-mediated, one-shot candidate write orchestration.
// Disabled unless the host explicitly constructs an enabled instance.
// It never promotes a candidate into source or into a registered snapshot.
import {join} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';
import {OneTimeWriteGrants} from './write-grants.mjs';
import {
 prepareWritePlan,stageApprovedCandidate,verifyCandidateChanges,
 snapshotManifest,discardCandidate
} from './write-candidates.mjs';
import {CodexCandidateWriteAdapter} from './codex-write-adapter.mjs';
import {findCodexExecutable} from './codex-binary.mjs';
import {requestWriteOwnerApprovalDetailed} from './write-owner-approval.mjs';

const checkedError=e=>/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message??'')?e.message:'WRITE_ATTEMPT_UNVERIFIED';
export class CandidateWriteCoordinator{
 constructor({
  root,enabled=false,readStore=null,
  approval=requestWriteOwnerApprovalDetailed,
  adapterFactory=({projectRoot,allowedFiles})=>
   new CodexCandidateWriteAdapter(findCodexExecutable(),projectRoot,{allowedFiles}),
 grants=null,maxDurationMs=60000,writePolicy=null,reauthorize=null
 }={}){
  if(!enabled)throw Error('WRITE_MODE_NOT_ENABLED');
  if(typeof root!=='string'||!root.startsWith('/')||
     typeof approval!=='function'||typeof adapterFactory!=='function'||
     !Number.isInteger(maxDurationMs)||maxDurationMs<500||maxDurationMs>60000||
     (reauthorize!==null&&typeof reauthorize!=='function'))
   throw Error('WRITE_COORDINATOR_CONFIG_INVALID');
  this.root=root;
  const reg=loadReadOnlyRegistry(root);
  this.runtime=reg.runtime;
  this.readStore=readStore;
  this.grants=grants??new OneTimeWriteGrants(join(reg.runtime,'writes.sqlite'));
  this.approval=approval;
  this.adapterFactory=adapterFactory;
  this.maxDurationMs=maxDurationMs;
  this.writePolicy=writePolicy;
  this.reauthorize=reauthorize;
  this.running=new Map();
  this.work=new Set();
  this.closed=false;
 }
 _readTaskBusy(){
  return (this.readStore?.db.prepare(
   "SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')"
  ).get().n??0)>0;
 }
 hasActiveRequest(){
  return this.grants.db.prepare(
   "SELECT COUNT(*) AS n FROM theo_write_requests WHERE state IN ('APPROVAL_PENDING','AUTHORIZED','RUNNING')"
  ).get().n>0;
 }
 _assertWriteAuthorized(projectId,allowedFiles){
  // A production host must prove its local release gate for every request and
  // again after consent. Test-only injected coordinators deliberately omit it.
  const policy=this.reauthorize?this.reauthorize():this.writePolicy;
  if(policy?.enabled===true){
   if(!policy.projectIds.includes(projectId))throw Error('WRITE_PROJECT_NOT_RELEASED');
   if(!Array.isArray(allowedFiles)||allowedFiles.length>policy.maxFiles)
    throw Error('WRITE_RELEASE_FILE_LIMIT');
  }
 }
 request({id,projectId,instruction,allowedFiles}={}){
  if(this.closed)throw Error('WRITE_COORDINATOR_CLOSED');
  if(this._readTaskBusy())throw Error('READ_TASK_ACTIVE');
  if(projectId==='chappy-signal')throw Error('WRITE_FORBIDDEN_NATIVE_PROJECT');
  if(projectId==='theo-lab')throw Error('WRITE_NATIVE_PROJECT_REFUSED');
  this._assertWriteAuthorized(projectId,allowedFiles);
  const reg=loadReadOnlyRegistry(this.root);
  if(!Object.hasOwn(reg.projects,projectId))
   throw Error('WRITE_OWNER_SNAPSHOT_REQUIRED');
  const scope=prepareWritePlan({
   projectRoot:reg.projects[projectId],id,projectId,instruction,allowedFiles
  });
  const result=this.grants.propose(scope);
  if(result.created){
   queueMicrotask(()=>{
    const job=this._run(result.id).catch(()=>{});
    this.work.add(job);job.finally(()=>this.work.delete(job));
   });
  }
  return {id:result.id,created:result.created,state:result.state,
   allowedFiles:result.allowedFiles,planFingerprint:result.planFingerprint,
   ownerApprovalRequired:true,writeToOriginal:false};
 }
 async _settleChild(adapter){
  try{adapter?.disconnect?.();}catch{}
  const child=adapter?.child;
  if(!child)return true;
  if(child.exitCode!==null||child.signalCode!==null)return true;
  const ended=new Promise(resolve=>{
   child.once('close',()=>resolve(true));
   child.once('error',()=>resolve(true));
  });
  let clean=await Promise.race([ended,pause(2000).then(()=>false)]);
  if(!clean){
   try{child.kill('SIGKILL');}catch{}
   clean=await Promise.race([ended,pause(1500).then(()=>false)]);
  }
  return clean;
 }
 async _run(id){
  if(this.closed)return;
  const req=this.grants.get(id);
  if(!req||req.state!=='APPROVAL_PENDING')return;
  const controller=new AbortController();
  const job={phase:'approval',controller,adapter:null,candidateDir:null};
  this.running.set(id,job);
  let granted=false,consumed=false,terminalStatus=null,done=false;
  try{
   const reg=loadReadOnlyRegistry(this.root);
   const projectRoot=reg.projects[req.project_id];
   if(!projectRoot)throw Error('WRITE_PROJECT_UNREGISTERED');
   const planContext={
    id,projectId:req.project_id,instruction:req.instruction,
    allowedFiles:JSON.parse(req.paths_json),planHash:req.plan_hash
   };
   const answer=await this.approval(planContext,{signal:controller.signal});
   granted=answer===true||answer?.approved===true;
   const reason=typeof answer?.reason==='string'&&/^[A-Z_]{3,35}$/.test(answer.reason)?
     answer.reason:'OWNER_DENIED_OR_TIMEOUT';
   if(!granted||controller.signal.aborted){
    this.grants.deny(id,controller.signal.aborted?'OWNER_CANCELLED':reason);
    return;
   }
   if(this.closed||this._readTaskBusy())throw Error('WRITE_CONFLICT_AFTER_APPROVAL');
   // Owner consent cannot outlive a local release revocation.
   this._assertWriteAuthorized(req.project_id,JSON.parse(req.paths_json));
   const fresh=prepareWritePlan({
    projectRoot,id,projectId:req.project_id,instruction:req.instruction,
    allowedFiles:JSON.parse(req.paths_json)
   });
   if(fresh.snapshotHash!==req.snapshot_hash||
      JSON.stringify(fresh.fileHashes)!==JSON.stringify(JSON.parse(req.file_hashes_json)))
    throw Error('WRITE_SNAPSHOT_CHANGED_AFTER_APPROVAL');
   const token=this.grants.authorize(id);
   // Burn before staging any changes or spawning the Codex subprocess.
   const authorization=this.grants.consume(id,token);
   consumed=true;
   job.phase='running';
   const staged=stageApprovedCandidate({runtime:this.runtime,projectRoot,request:authorization});
   job.candidateDir=staged.candidateDir;
   job.adapter=this.adapterFactory({
    projectRoot:staged.candidateDir,allowedFiles:authorization.allowedFiles
   });
   let watchdog;
   const timeLimit=new Promise((_,reject)=>{
    watchdog=setTimeout(()=>reject(Error('WRITE_CANDIDATE_TIMEOUT')),this.maxDurationMs);
   });
   try{
    await Promise.race([job.adapter.execute({
     projectRoot:staged.candidateDir,prompt:authorization.instruction,
     onEvent:ev=>{
      if(ev?.kind==='terminal')terminalStatus=ev.status;
      else if(ev?.kind==='progress'&&typeof ev.stage==='string')
       this.grants._event(id,'PROGRESS',ev.stage.slice(0,64));
    }
    }),timeLimit]);
   }finally{clearTimeout(watchdog);}
   const exited=await this._settleChild(job.adapter);
   if(!exited)throw Error('WRITE_PROVIDER_EXIT_UNVERIFIED');
   if(terminalStatus!=='completed')throw Error('WRITE_PROVIDER_NOT_COMPLETED');
   const delta=verifyCandidateChanges({
    candidateDir:staged.candidateDir,before:staged.before,
    allowedFiles:authorization.allowedFiles
   });
   if(snapshotManifest(projectRoot).hash!==authorization.snapshotHash)
    throw Error('WRITE_ORIGINAL_SNAPSHOT_CHANGED');
   this.grants.complete(id,{state:'COMPLETED',outcome:{
    changedFiles:delta.changedFiles.map(x=>x.path),
    candidateId:id,baseDigest:staged.before.hash,candidateDigest:delta.manifestHash,
    changedHashes:delta.changedFiles.map(x=>({path:x.path,before:x.beforeSha256,after:x.afterSha256})),
    providerFinished:true,candidateVerified:true
   }});
   done=true;
  }catch(e){
   const error=checkedError(e);
   const row=this.grants.get(id);
   if(row?.state==='APPROVAL_PENDING'||row?.state==='AUTHORIZED'){
    this.grants.revoke(id,error);
   }else if(consumed&&row?.state==='RUNNING'){
    await this._settleChild(job.adapter);
    const knownRejection=error.startsWith('WRITE_UNAPPROVED')||
      ['WRITE_NO_CHANGES','WRITE_OUTPUT_NOT_SAFE_TEXT','WRITE_SYMLINK_DETECTED',
       'WRITE_SPECIAL_FILE_DETECTED','WRITE_SNAPSHOT_TOO_LARGE'].includes(error);
    this.grants.complete(id,{state:knownRejection?'REJECTED':'UNKNOWN',
     outcome:{reason:error,providerFinished:terminalStatus==='completed',candidateVerified:false}});
   }
  }finally{
   // A denied or unverified proposal cannot leave an executable candidate artifact.
   if(!done&&job.candidateDir){
    try{discardCandidate(job.candidateDir,this.runtime);}catch{}
   }
   this.running.delete(id);
  }
 }
 status(id){return this.grants.status(id);}
 events(id,after=0){return this.grants.events(id,after);}
 result(id){return this.grants.result(id);}
 cancel(id){
  const row=this.grants.get(id);
  if(!row)throw Error('WRITE_REQUEST_NOT_FOUND');
  const run=this.running.get(id);
  run?.controller.abort();
  if(row.state==='APPROVAL_PENDING'||row.state==='AUTHORIZED')
   return this.grants.revoke(id,'OWNER_CANCELLED');
  if(row.state==='RUNNING'){
   try{run?.adapter?.disconnect?.();}catch{}
   // Worker will settle UNKNOWN or REJECTED. No success is promised.
  }
  return this.status(id);
 }
 async close(){
  this.closed=true;
  for(const [id,run] of this.running){
   run.controller.abort();
   try{run.adapter?.disconnect?.();}catch{}
  }
  // Do not let a one-time grant survive a worker/host shutdown.
  // The ledger marks unresolved approvals DENIED and running tasks UNKNOWN upon reopen.
  await Promise.race([Promise.allSettled([...this.work]),pause(5000)]);
  this.grants.close();
 }
}
