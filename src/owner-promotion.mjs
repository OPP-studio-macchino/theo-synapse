// Theo Synapse local OWNER-ONLY promotion of a verified Codex candidate.
// The live MCP server NEVER invokes this module. One file per independent consent.
import {
  lstatSync,realpathSync,openSync,readSync,writeSync,fstatSync,fsyncSync,closeSync,
  existsSync,mkdirSync,renameSync,unlinkSync,chmodSync,readFileSync,constants
} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,join,dirname,relative,sep,basename} from 'node:path';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';
import {snapshotManifest,verifyCandidateChanges} from './write-candidates.mjs';
import {PromotionLedger} from './promotion-ledger.mjs';
import {requestPromotionConsent} from './promotion-owner-approval.mjs';
import {safeOutput} from './redaction.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const validId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(s);
const hashOK=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const noSymlinks=path=>{
 const s=lstatSync(path);
 if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid()||(s.mode&0o022))
  throw Error('PROMOTION_DIRECTORY_UNSAFE');
 if(realpathSync.native(path)!==path)throw Error('PROMOTION_DIRECTORY_ALIAS');
};
function safeTargetRoot(sourceRoot,standaloneRoot){
 if(typeof sourceRoot!=='string'||!sourceRoot.startsWith('/')||
   /[\x00-\x1f]/.test(sourceRoot)||resolve(sourceRoot)!==sourceRoot||sourceRoot.length>450||
   realpathSync.native(sourceRoot)!==sourceRoot)
   throw Error('PROMOTION_SOURCE_ALIAS');
 const root=resolve(standaloneRoot);
 if(sourceRoot===root||sourceRoot.startsWith(root+sep)||root.startsWith(sourceRoot+sep))
  throw Error('PROMOTION_SOURCE_OVERLAP');
 const home=process.env.HOME??'';
 const banned=['/','/Users','/Volumes','/private','/private/tmp',home,
  join(home,'Documents'),join(home,'Desktop'),join(home,'Downloads'),
  join(home,'Library')];
 if(banned.includes(sourceRoot)||
   /^\/Volumes\/[^/]+$/.test(sourceRoot))
  throw Error('PROMOTION_SOURCE_TOO_BROAD');
 if(sourceRoot.split(sep).filter(Boolean).some(x=>x.startsWith('.')||
   ['.git','node_modules','secrets','.ssh','Keychains','Library'].includes(x)))
  throw Error('PROMOTION_SOURCE_PROTECTED');
 noSymlinks(sourceRoot);
 return sourceRoot;
}
function targetFile(root,relativeName){
 if(typeof relativeName!=='string'||!relativeName||
   relativeName.startsWith('/')||relativeName.includes('\\')||
   relativeName.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.')))
  throw Error('PROMOTION_FILE_INVALID');
 let part=root;
 const pieces=relativeName.split('/');
 for(const name of pieces.slice(0,-1)){
  part=join(part,name);noSymlinks(part);
 }
 const path=join(part,pieces.at(-1));
 if(!path.startsWith(root+sep))throw Error('PROMOTION_FILE_OUTSIDE_ROOT');
 return path;
}
function readOwnedFile(path,{strictPrivate=false,maxBytes=131072}={}){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const s=fstatSync(fd);
  if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||
     (s.mode&0o022)!==0||(strictPrivate&&(s.mode&0o077)!==0)||
     s.size>maxBytes||s.size<0)
   throw Error('PROMOTION_FILE_UNSAFE');
  const bytes=Buffer.alloc(s.size);
  let offset=0;
  while(offset<bytes.length){
   const n=readSync(fd,bytes,offset,bytes.length-offset,offset);
   if(n<=0)throw Error('PROMOTION_FILE_CHANGED');
   offset+=n;
  }
  const after=fstatSync(fd);
  if(after.size!==s.size||after.ino!==s.ino||after.mtimeMs!==s.mtimeMs)
   throw Error('PROMOTION_FILE_CHANGED');
  return {bytes,hash:sha(bytes),mode:s.mode&0o777,size:s.size,ino:s.ino,gid:s.gid};
 }finally{closeSync(fd);}
}
function strictFile(path){
 const s=lstatSync(path);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||
    (s.mode&0o077)!==0)throw Error('PROMOTION_EVIDENCE_FILE_UNSAFE');
}
function completedWriteEvidence(runtime,id){
 const path=join(runtime,'writes.sqlite');
 strictFile(path);
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const row=db.prepare('SELECT * FROM theo_write_requests WHERE id=?').get(id);
  if(!row||row.state!=='COMPLETED'||row.consumed_ms===null)
   throw Error('PROMOTION_NO_APPROVED_CANDIDATE');
  const meta=JSON.parse(row.outcome_json??'null');
  const files=JSON.parse(row.paths_json);
  if(!meta||meta.candidateVerified!==true||meta.providerFinished!==true||
     meta.candidateId!==id||!hashOK(meta.baseDigest)||!hashOK(meta.candidateDigest)||
     !Array.isArray(meta.changedFiles)||meta.changedFiles.length!==1||
     !Array.isArray(meta.changedHashes)||meta.changedHashes.length!==1||
     !files.includes(meta.changedFiles[0])||
     meta.changedHashes[0].path!==meta.changedFiles[0]||
     !hashOK(meta.changedHashes[0].before)||!hashOK(meta.changedHashes[0].after))
   throw Error('PROMOTION_EVIDENCE_INVALID');
  return {id,projectId:row.project_id,file:meta.changedFiles[0],meta};
 }finally{db.close();}
}
function checkIdle(reg){
 const taskFile=join(reg.runtime,'tasks.sqlite');
 if(existsSync(taskFile)){
  strictFile(taskFile);
  const db=new DatabaseSync(taskFile,{readOnly:true});
  try{
   const busy=db.prepare("SELECT COUNT(*) AS n FROM standalone_tasks WHERE state IN ('QUEUED','RUNNING','STOP_REQUESTED')").get().n;
   if(busy!==0)throw Error('PROMOTION_READ_TASK_BUSY');
  }finally{db.close();}
 }
 const writeFile=join(reg.runtime,'writes.sqlite');
 if(existsSync(writeFile)){
  strictFile(writeFile);
  const db=new DatabaseSync(writeFile,{readOnly:true});
  try{
   const busy=db.prepare("SELECT COUNT(*) AS n FROM theo_write_requests WHERE state IN ('APPROVAL_PENDING','AUTHORIZED','RUNNING')").get().n;
   if(busy!==0)throw Error('PROMOTION_WRITE_TASK_BUSY');
  }finally{db.close();}
 }
}
function checkedBackup(reg,row){
 const expected=join(reg.runtime,'promotion-recovery',row.id,'before.bin');
 if(row.backup_path!==expected||row.backup_hash!==row.before_hash)
  throw Error('PROMOTION_RECOVERY_PATH_INVALID');
 const parent=dirname(expected),recoveryRoot=dirname(parent);
 noSymlinks(recoveryRoot);noSymlinks(parent);
 for(const p of [recoveryRoot,parent]){
  if(lstatSync(p).mode&0o077)throw Error('PROMOTION_RECOVERY_DIR_NOT_PRIVATE');
 }
 const content=readOwnedFile(expected,{strictPrivate:true});
 if(content.hash!==row.before_hash)throw Error('PROMOTION_RECOVERY_BACKUP_CHANGED');
 return content;
}

function diffSummary(before,after){
 const a=before.toString('utf8').split('\n');
 const b=after.toString('utf8').split('\n');
 let prefix=0;
 while(prefix<Math.min(a.length,b.length)&&a[prefix]===b[prefix])prefix++;
 let suffix=0;
 while(suffix<Math.min(a.length,b.length)-prefix&&
   a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const removed=a.slice(prefix,a.length-suffix);
 const added=b.slice(prefix,b.length-suffix);
 const lines=['@@ '+(prefix+1)+' @@',
  ...removed.slice(0,16).map(x=>'- '+x),
  ...added.slice(0,16).map(x=>'+ '+x)];
 if(removed.length>16||added.length>16)lines.push('[additional modified lines omitted]');
 const raw=lines.join('\n');
 return {changedFromLine:prefix+1,removedLines:removed.length,addedLines:added.length,
  diffPreview:safeOutput(raw,2400).text};
}
export function previewPromotion({standaloneRoot,requestId,sourceRoot}={}){
 if(!validId(requestId))throw Error('PROMOTION_REQUEST_ID_INVALID');
 const root=resolve(standaloneRoot);
 if(realpathSync.native(root)!==root)throw Error('PROMOTION_ROOT_ALIAS');
 const reg=loadReadOnlyRegistry(root);
 checkIdle(reg);
 const evidence=completedWriteEvidence(reg.runtime,requestId);
 if(evidence.projectId==='theo-lab'||!Object.hasOwn(reg.projects,evidence.projectId))
  throw Error('PROMOTION_PROJECT_NOT_REGISTERED');
 const before=snapshotManifest(reg.projects[evidence.projectId]);
 const candidateRoot=join(reg.runtime,'write-candidates',requestId);
 const delta=verifyCandidateChanges({
  candidateDir:candidateRoot,before,allowedFiles:[evidence.file]
 });
 const after=snapshotManifest(candidateRoot);
 if(before.hash!==evidence.meta.baseDigest||
    after.hash!==evidence.meta.candidateDigest||
    delta.changedFiles.length!==1||
    delta.changedFiles[0].path!==evidence.file||
    delta.changedFiles[0].beforeSha256!==evidence.meta.changedHashes[0].before||
    delta.changedFiles[0].afterSha256!==evidence.meta.changedHashes[0].after)
  throw Error('PROMOTION_CANDIDATE_HASH_MISMATCH');
 const targetRoot=safeTargetRoot(sourceRoot,root);
 const p=targetFile(targetRoot,evidence.file);
 const target=readOwnedFile(p);
 const original=before.data.get(evidence.file);
 const proposed=after.data.get(evidence.file);
 if(!original||!proposed||sha(original)!==target.hash)
  throw Error('PROMOTION_SOURCE_HAS_CHANGED');
 if(!hashOK(target.hash)||!hashOK(sha(proposed)))
  throw Error('PROMOTION_HASH_INVALID');
 const normalized={
  kind:'THEO_PROMOTION_V1',
  requestId,projectId:evidence.projectId,sourceRoot:targetRoot,
  relativeFile:evidence.file,beforeHash:target.hash,afterHash:sha(proposed),
  baseDigest:before.hash,candidateDigest:after.hash,
  sourceMode:target.mode
 };
 const fingerprint=sha(JSON.stringify(normalized));
 return {
  ...normalized,fingerprint,reviewCode:fingerprint.slice(0,20),
  beforeBytes:original.length,afterBytes:proposed.length,
  ...diffSummary(original,proposed)
 };
}
function recoveryRoot(runtime,id){
 const home=join(runtime,'promotion-recovery');
 if(!existsSync(home))mkdirSync(home,{mode:0o700});
 const st=lstatSync(home);
 if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||
    (st.mode&0o077)!==0)throw Error('PROMOTION_RECOVERY_DIR_UNSAFE');
 const d=join(home,id);
 if(existsSync(d))throw Error('PROMOTION_BACKUP_ALREADY_EXISTS');
 mkdirSync(d,{mode:0o700});
 return d;
}
function durableWrite(file,buf,mode){
 const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,mode);
 try{
  let done=0;
  while(done<buf.length){
   const n=writeSync(fd,buf,done,buf.length-done,done);
   if(n<=0)throw Error('PROMOTION_FILE_WRITE_FAILED');
   done+=n;
  }
  fsyncSync(fd);
 }finally{closeSync(fd);}
}
function metadataFingerprint(path){
 if(process.platform!=='darwin')throw Error('PROMOTION_MAC_METADATA_REQUIRED');
 const options={encoding:'utf8',timeout:4000,maxBuffer:131072,stdio:['ignore','pipe','ignore']};
 const acl=spawnSync('/bin/ls',['-le',path],options);
 if(acl.status!==0||acl.error)throw Error('PROMOTION_ACL_CHECK_FAILED');
 if(/^\s*[0-9]+:\s/m.test(acl.stdout))
  throw Error('PROMOTION_ACL_UNSUPPORTED');
 const list=spawnSync('/usr/bin/xattr',[path],options);
 if(list.status!==0||list.error)throw Error('PROMOTION_XATTR_CHECK_FAILED');
 const names=list.stdout.trim()?list.stdout.trim().split('\n').sort():[];
 if(names.length>50||names.some(x=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(x)))
  throw Error('PROMOTION_XATTR_UNSUPPORTED');
 const values=[];
 for(const name of names){
  const r=spawnSync('/usr/bin/xattr',['-px',name,path],options);
  if(r.status!==0||r.error)throw Error('PROMOTION_XATTR_READ_FAILED');
  values.push({name,hex:r.stdout.replace(/\s/g,'').toLowerCase()});
 }
 return sha(JSON.stringify(values));
}
function atomicReplace(target,content,mode,{expectedHash=null}={}){
 const parent=dirname(target);
 noSymlinks(parent);
 const original=readOwnedFile(target);
 if(original.mode!==mode||(expectedHash&&original.hash!==expectedHash))
  throw Error('PROMOTION_SOURCE_CHANGED_BEFORE_RENAME');
 const metadata=metadataFingerprint(target);
 const tmp=join(parent,'.theo-replace-'+randomBytes(12).toString('hex')+'.tmp');
 let created=false;
 try{
  // macOS /bin/cp -pP preserves extended attributes and ownership metadata.
  // Node fs.copyFile intentionally does NOT preserve xattrs on this host.
  const copy=spawnSync('/bin/cp',['-pP',target,tmp],{
   timeout:5000,maxBuffer:4096,stdio:['ignore','pipe','pipe']
  });
  if(copy.status!==0||copy.error)throw Error('PROMOTION_METADATA_COPY_FAILED');
  created=true;
  const copied=readOwnedFile(tmp);
  if(copied.hash!==original.hash||copied.mode!==original.mode||copied.gid!==original.gid)
   throw Error('PROMOTION_SOURCE_CHANGED_DURING_COPY');
  if(metadataFingerprint(tmp)!==metadata)
   throw Error('PROMOTION_XATTR_NOT_PRESERVED');
  const fd=openSync(tmp,constants.O_WRONLY|constants.O_TRUNC|constants.O_NOFOLLOW);
  try{
   const st=fstatSync(fd);
   if(!st.isFile()||st.nlink!==1||st.uid!==process.getuid())
    throw Error('PROMOTION_TEMP_UNSAFE');
   let done=0;
   while(done<content.length){
    const n=writeSync(fd,content,done,content.length-done,done);
    if(n<=0)throw Error('PROMOTION_TEMP_WRITE_FAILED');
    done+=n;
   }
   fsyncSync(fd);
  }finally{closeSync(fd);}
  chmodSync(tmp,mode);
  if(readOwnedFile(tmp).hash!==sha(content))
   throw Error('PROMOTION_TEMP_HASH_INVALID');
  if(metadataFingerprint(tmp)!==metadata)
   throw Error('PROMOTION_METADATA_CHANGED');
  // Final best-effort CAS validation. A non-cooperating editor could still race.
  if(readOwnedFile(target).hash!==original.hash||
     metadataFingerprint(target)!==metadata)
   throw Error('PROMOTION_SOURCE_RACE');
  noSymlinks(parent);
  renameSync(tmp,target);created=false;
  const d=openSync(parent,constants.O_RDONLY|constants.O_DIRECTORY);
  try{fsyncSync(d);}finally{closeSync(d);}
 }finally{
  if(created&&existsSync(tmp))unlinkSync(tmp);
 }
}
const reasonCode=e=>/^[A-Z][A-Z0-9_]{2,80}$/.test(e?.message??'')?
  e.message:'PROMOTION_OPERATION_UNVERIFIED';
export async function applyPromotion({
 standaloneRoot,requestId,sourceRoot,confirm,approveOwner=requestPromotionConsent,
 failpoint=null
}={}){
 const plan=previewPromotion({standaloneRoot,requestId,sourceRoot});
 if(confirm!==plan.reviewCode)throw Error('PROMOTION_OWNER_REVIEW_REQUIRED');
 if(typeof approveOwner!=='function')throw Error('PROMOTION_APPROVER_INVALID');
 const root=resolve(standaloneRoot),reg=loadReadOnlyRegistry(root);
 const ledger=new PromotionLedger(join(reg.runtime,'promotions.sqlite'));
 let consumed=false,swapped=false,backupFile=null;
 try{
  ledger.reserve(plan);
  const result=await approveOwner({
   action:'APPLY',id:requestId,projectId:plan.projectId,
   sourceRoot:plan.sourceRoot,file:plan.relativeFile,fingerprint:plan.fingerprint,
   beforeHash:plan.beforeHash,afterHash:plan.afterHash
  });
  if(result!==true&&result?.approved!==true){
   const reason=/^[A-Z_]{3,40}$/.test(result?.reason??'')?
     result.reason:'OWNER_DENIED';
   ledger.change(requestId,'PENDING','DENIED',{error_code:reason});
   return {state:'DENIED',reason,sourceModified:false};
  }
  const fresh=previewPromotion({standaloneRoot:root,requestId,sourceRoot});
  if(fresh.fingerprint!==plan.fingerprint)
   throw Error('PROMOTION_PLAN_CHANGED_AFTER_APPROVAL');
  const target=targetFile(plan.sourceRoot,plan.relativeFile);
  const original=readOwnedFile(target);
  if(original.hash!==plan.beforeHash||original.mode!==plan.sourceMode)
   throw Error('PROMOTION_SOURCE_HAS_CHANGED');
  const candidate=join(reg.runtime,'write-candidates',requestId,plan.relativeFile);
  const proposed=readOwnedFile(candidate,{strictPrivate:true});
  if(proposed.hash!==plan.afterHash)throw Error('PROMOTION_CANDIDATE_CHANGED');
  const recovery=recoveryRoot(reg.runtime,requestId);
  backupFile=join(recovery,'before.bin');
  durableWrite(backupFile,original.bytes,0o600);
  if(readOwnedFile(backupFile,{strictPrivate:true}).hash!==plan.beforeHash)
   throw Error('PROMOTION_BACKUP_UNVERIFIED');
  // One-time decision is burned BEFORE the original file is replaced.
  ledger.change(requestId,'PENDING','APPLYING',{
   owner_approved_ms:Date.now(),consumed_ms:Date.now(),
   backup_path:backupFile,backup_hash:plan.beforeHash
  });
  consumed=true;
  if(failpoint==='beforeSwap')throw Error('PROMOTION_TEST_BEFORE_SWAP');
  if(readOwnedFile(target).hash!==plan.beforeHash)
   throw Error('PROMOTION_SOURCE_RACE');
  atomicReplace(target,proposed.bytes,original.mode);
  swapped=true;
  if(failpoint==='afterSwap')throw Error('PROMOTION_TEST_AFTER_SWAP');
  if(readOwnedFile(target).hash!==plan.afterHash)
   throw Error('PROMOTION_POSTCHECK_FAILED');
  if(snapshotManifest(reg.projects[plan.projectId]).hash!==plan.baseDigest)
   throw Error('PROMOTION_SNAPSHOT_WAS_MODIFIED');
  if(snapshotManifest(join(reg.runtime,'write-candidates',requestId)).hash!==plan.candidateDigest)
   throw Error('PROMOTION_CANDIDATE_WAS_MODIFIED');
  ledger.change(requestId,'APPLYING','APPLIED');
  return {state:'APPLIED',id:requestId,projectId:plan.projectId,
   relativeFile:plan.relativeFile,beforeHash:plan.beforeHash,
   afterHash:plan.afterHash,reviewCode:plan.reviewCode,backupRetained:true};
 }catch(e){
  const code=reasonCode(e);
  const row=ledger.get(requestId);
  if(row?.state==='PENDING')
   ledger.change(requestId,'PENDING','CONFLICT',{error_code:code});
  else if(consumed&&row?.state==='APPLYING'){
   let recovered=!swapped;
   try{
    const target=targetFile(plan.sourceRoot,plan.relativeFile);
    const before=readOwnedFile(backupFile,{strictPrivate:true});
    const current=readOwnedFile(target);
    if(before.hash!==plan.beforeHash)throw Error('PROMOTION_RECOVERY_HASH_MISMATCH');
    if(current.hash!==before.hash){
     // Do NOT overwrite a third-party modification that is not the expected candidate.
     if(current.hash!==plan.afterHash)throw Error('PROMOTION_RECOVERY_CONFLICT');
     atomicReplace(target,before.bytes,plan.sourceMode);
    }
    recovered=readOwnedFile(target).hash===plan.beforeHash;
   }catch{recovered=false;}
   ledger.change(requestId,'APPLYING',recovered?'ROLLED_BACK':'UNKNOWN',{error_code:code});
  }
  throw Error(code);
 }finally{ledger.close();}
}
export async function restorePromotion({
 standaloneRoot,requestId,confirm,approveOwner=requestPromotionConsent
}={}){
 if(!validId(requestId))throw Error('PROMOTION_REQUEST_ID_INVALID');
 const reg=loadReadOnlyRegistry(resolve(standaloneRoot));
 const ledger=new PromotionLedger(join(reg.runtime,'promotions.sqlite'));
 try{
  const row=ledger.get(requestId);
  if(!row||row.state!=='APPLIED')throw Error('PROMOTION_NOT_RESTORABLE');
  const fingerprint=sha(JSON.stringify({
   action:'RESTORE',id:row.id,target:row.source_root,file:row.file,
   before:row.before_hash,after:row.after_hash,plan:row.plan_digest
  }));
  if(confirm!==fingerprint.slice(0,20))throw Error('PROMOTION_RESTORE_REVIEW_REQUIRED');
  checkIdle(reg);
  const before=checkedBackup(reg,row);
  const currentPath=targetFile(safeTargetRoot(row.source_root,resolve(standaloneRoot)),row.file);
  const current=readOwnedFile(currentPath);
  if(before.hash!==row.before_hash||current.hash!==row.after_hash)
   throw Error('PROMOTION_RESTORE_CONFLICT');
  const decision=await approveOwner({
   action:'RESTORE',id:row.id,projectId:row.project_id,
   sourceRoot:row.source_root,file:row.file,fingerprint,
   beforeHash:row.before_hash,afterHash:row.after_hash
  });
  if(decision!==true&&decision?.approved!==true)
   return {state:'APPLIED',restored:false,reason:'RESTORE_NOT_APPROVED'};
  if(readOwnedFile(currentPath).hash!==row.after_hash)
   throw Error('PROMOTION_RESTORE_CONFLICT');
  ledger.change(row.id,'APPLIED','RESTORING',{restore_approved_ms:Date.now()});
  atomicReplace(currentPath,before.bytes,current.mode);
  if(readOwnedFile(currentPath).hash!==row.before_hash){
   ledger.change(row.id,'RESTORING','UNKNOWN',{error_code:'RESTORE_POSTCHECK_FAILED'});
   throw Error('RESTORE_POSTCHECK_FAILED');
  }
  ledger.change(row.id,'RESTORING','RESTORED');
  return {state:'RESTORED',restored:true,id:row.id,file:row.file};
 }finally{ledger.close();}
}
export function previewRestore({standaloneRoot,requestId}={}){
 const reg=loadReadOnlyRegistry(resolve(standaloneRoot));
 const file=join(reg.runtime,'promotions.sqlite');
 strictFile(file);
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const row=db.prepare('SELECT * FROM promotion_decisions WHERE id=?').get(requestId);
  if(!row||row.state!=='APPLIED')throw Error('PROMOTION_NOT_RESTORABLE');
  checkIdle(reg);
  checkedBackup(reg,row);
  const fingerprint=sha(JSON.stringify({
   action:'RESTORE',id:row.id,target:row.source_root,file:row.file,
   before:row.before_hash,after:row.after_hash,plan:row.plan_digest
  }));
  return {id:row.id,projectId:row.project_id,
   sourceRoot:row.source_root,relativeFile:row.file,
   beforeHash:row.before_hash,afterHash:row.after_hash,
   reviewCode:fingerprint.slice(0,20)};
 }finally{db.close();}
}

function unknownRecoveryPlan(reg,row,standaloneRoot){
 if(!row||row.state!=='UNKNOWN')throw Error('PROMOTION_NOT_UNKNOWN');
 const expected=join(reg.runtime,'promotion-recovery',row.id,'before.bin');
 if(row.backup_path!==expected||row.backup_hash!==row.before_hash)
  throw Error('PROMOTION_RECOVERY_PATH_INVALID');
 const source=safeTargetRoot(row.source_root,resolve(standaloneRoot));
 const path=targetFile(source,row.file);
 const original=checkedBackup(reg,row);
 const target=readOwnedFile(path);
 if(original.hash!==row.before_hash)throw Error('PROMOTION_RECOVERY_BACKUP_CHANGED');
 const currentState=target.hash===row.before_hash?'ORIGINAL_UNCHANGED':
  target.hash===row.after_hash?'CANDIDATE_PRESENT':'THIRD_PARTY_CHANGE';
 if(currentState==='THIRD_PARTY_CHANGE')
  throw Error('PROMOTION_RECOVERY_CONFLICT');
 const plan={
  action:'RECOVER',requestId:row.id,projectId:row.project_id,
  sourceRoot:source,relativeFile:row.file,currentState,
  beforeHash:row.before_hash,afterHash:row.after_hash,
  planDigest:row.plan_digest,targetHash:target.hash
 };
 const fingerprint=sha(JSON.stringify(plan));
 return {...plan,fingerprint,reviewCode:fingerprint.slice(0,20)};
}
export function previewRecovery({standaloneRoot,requestId}={}){
 if(!validId(requestId))throw Error('PROMOTION_REQUEST_ID_INVALID');
 const root=resolve(standaloneRoot),reg=loadReadOnlyRegistry(root);
 const path=join(reg.runtime,'promotions.sqlite');
 strictFile(path);
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const row=db.prepare('SELECT * FROM promotion_decisions WHERE id=?').get(requestId);
  return unknownRecoveryPlan(reg,row,root);
 }finally{db.close();}
}
export async function recoverUnknownPromotion({
 standaloneRoot,requestId,confirm,approveOwner=requestPromotionConsent
}={}){
 if(!validId(requestId))throw Error('PROMOTION_REQUEST_ID_INVALID');
 const root=resolve(standaloneRoot),reg=loadReadOnlyRegistry(root);
 const ledger=new PromotionLedger(join(reg.runtime,'promotions.sqlite'));
 try{
  const row=ledger.get(requestId);
  const plan=unknownRecoveryPlan(reg,row,root);
  if(confirm!==plan.reviewCode)throw Error('PROMOTION_RECOVERY_REVIEW_REQUIRED');
  const decision=await approveOwner({
   action:'RECOVER',id:requestId,projectId:plan.projectId,
   sourceRoot:plan.sourceRoot,file:plan.relativeFile,fingerprint:plan.fingerprint,
   beforeHash:plan.beforeHash,afterHash:plan.afterHash
  });
  if(decision!==true&&decision?.approved!==true)
   return {state:'UNKNOWN',recovered:false,reason:'OWNER_DENIED'};
  const fresh=unknownRecoveryPlan(reg,ledger.get(requestId),root);
  if(fresh.fingerprint!==plan.fingerprint)
   throw Error('PROMOTION_RECOVERY_CHANGED_AFTER_APPROVAL');
  const target=targetFile(plan.sourceRoot,plan.relativeFile);
  const before=checkedBackup(reg,row);
  if(plan.currentState==='ORIGINAL_UNCHANGED'){
   const resolution=row.restore_approved_ms?'RESTORED':'ROLLED_BACK';
   if(resolution==='RESTORED'){
    ledger.change(requestId,'UNKNOWN','RESTORING',{restore_approved_ms:Date.now()});
    ledger.change(requestId,'RESTORING','RESTORED');
   }else ledger.change(requestId,'UNKNOWN','ROLLED_BACK');
   return {state:resolution,recovered:true,file:plan.relativeFile,actualFileChanged:false};
  }
  ledger.change(requestId,'UNKNOWN','RESTORING',{restore_approved_ms:Date.now()});
  let safe=false;
  try{
   const current=readOwnedFile(target);
   if(current.hash!==row.after_hash)throw Error('PROMOTION_RECOVERY_CONFLICT');
   atomicReplace(target,before.bytes,current.mode);
   safe=readOwnedFile(target).hash===row.before_hash;
   if(!safe)throw Error('PROMOTION_RECOVERY_POSTCHECK_FAILED');
   ledger.change(requestId,'RESTORING','RESTORED');
  }catch(e){
   const state=ledger.get(requestId)?.state;
   if(state==='RESTORING')
    ledger.change(requestId,'RESTORING','UNKNOWN',{error_code:reasonCode(e)});
   throw Error(reasonCode(e));
  }
  return {state:'RESTORED',recovered:true,file:plan.relativeFile,actualFileChanged:true};
 }finally{ledger.close();}
}
