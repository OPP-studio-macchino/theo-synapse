// Theo Synapse LOCAL Owner-only review + apply + restore CLI.
// Never exposed through the public MCP plugin or its Secure Tunnel.
import {realpathSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {previewPromotion,applyPromotion,previewRestore,restorePromotion,previewRecovery,recoverUnknownPromotion} from '../src/owner-promotion.mjs';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';

const root=realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const [cmd,requestId,sourceRoot,confirmation]=process.argv.slice(2);
function status(id){
 const registry=loadReadOnlyRegistry(root);
 const path=join(registry.runtime,'promotions.sqlite');
 if(!existsSync(path))return {status:'NO_PROMOTIONS_YET'};
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const row=db.prepare('SELECT id,state,project_id,file,created_ms,updated_ms,error_code FROM promotion_decisions WHERE id=?').get(id);
  if(!row) return {status:'NOT_FOUND'};
  return {requestId:row.id,state:row.state,projectId:row.project_id,
   file:row.file,createdAt:new Date(row.created_ms).toISOString(),
   updatedAt:new Date(row.updated_ms).toISOString(),
   outcomeCode:row.error_code};
 }finally{db.close();}
}
const help=()=>{
 console.log('Theo Synapse | Owner-only promotion (NOT a ChatGPT MCP tool)');
 console.log('  npm run promotion:owner -- review WRITE_REQUEST_ID "/path/to/source"');
 console.log('  npm run promotion:owner -- apply WRITE_REQUEST_ID "/path/to/source" 20-CHAR-REVIEW-CODE');
 console.log('  npm run promotion:owner -- restore-review WRITE_REQUEST_ID');
 console.log('  npm run promotion:owner -- restore WRITE_REQUEST_ID 20-CHAR-RESTORE-CODE');
 console.log('  npm run promotion:owner -- recover-review WRITE_REQUEST_ID');
 console.log('  npm run promotion:owner -- recover WRITE_REQUEST_ID 20-CHAR-RECOVERY-CODE');
 console.log('  npm run promotion:owner -- status WRITE_REQUEST_ID');
 console.log('No write will occur for review/status commands. Apply and restore require a NEW physical Mac Owner approval.');
};
try{
 if(!cmd||cmd==='help'){help();}
 else if(cmd==='review'){
  const p=previewPromotion({standaloneRoot:root,requestId,sourceRoot});
  console.log(JSON.stringify({
   type:'OWNER_PROMOTION_REVIEW',projectId:p.projectId,
   requestId:p.requestId,sourceRoot:p.sourceRoot,file:p.relativeFile,
   originalHash:p.beforeHash,candidateHash:p.afterHash,
   oldBytes:p.beforeBytes,newBytes:p.afterBytes,
   removedLines:p.removedLines,addedLines:p.addedLines,
   diffPreview:p.diffPreview,reviewCode:p.reviewCode
  },null,2));
  console.log('READ_ONLY_REVIEW: no source changes.');
  console.log('Run the exact apply command manually ONLY AFTER reviewing the diff:');
  console.log('npm run promotion:owner -- apply '+requestId+' '+
   "'"+sourceRoot.replace(/'/g,"'\\''")+"' "+p.reviewCode);
 }else if(cmd==='apply'){
  if(!confirmation)throw Error('PROMOTION_REVIEW_CODE_REQUIRED');
  const p=previewPromotion({standaloneRoot:root,requestId,sourceRoot});
  if(p.reviewCode!==confirmation)throw Error('PROMOTION_REVIEW_CODE_MISMATCH');
  console.log('Mac will request a SECOND approval before changing the real file. Default = DENY.');
  const outcome=await applyPromotion({
   standaloneRoot:root,requestId,sourceRoot,confirm:confirmation
  });
  console.log(JSON.stringify(outcome,null,2));
  if(outcome.state!=='APPLIED')process.exitCode=1;
 }else if(cmd==='restore-review'){
  const r=previewRestore({standaloneRoot:root,requestId});
  console.log(JSON.stringify({type:'OWNER_RESTORE_REVIEW',...r},null,2));
  console.log('NO_CHANGES: restore requires another physical Owner approval.');
  console.log('Run: npm run promotion:owner -- restore '+requestId+' '+r.reviewCode);
 }else if(cmd==='restore'){
  // For this command the third positional token is the review code.
  const code=sourceRoot;
  if(!code)throw Error('PROMOTION_RESTORE_REVIEW_CODE_REQUIRED');
  const r=previewRestore({standaloneRoot:root,requestId});
  if(code!==r.reviewCode)throw Error('PROMOTION_RESTORE_REVIEW_CODE_MISMATCH');
  const outcome=await restorePromotion({standaloneRoot:root,requestId,confirm:code});
  console.log(JSON.stringify(outcome,null,2));
  if(outcome.state!=='RESTORED')process.exitCode=1;
 }else if(cmd==='recover-review'){
  const r=previewRecovery({standaloneRoot:root,requestId});
  console.log(JSON.stringify({type:'OWNER_INTERRUPTED_RECOVERY_REVIEW',...r},null,2));
  console.log('NO_CHANGES: an UNKNOWN interrupted write needs another physical Owner approval.');
  console.log('Run: npm run promotion:owner -- recover '+requestId+' '+r.reviewCode);
 }else if(cmd==='recover'){
  const code=sourceRoot;
  if(!code)throw Error('PROMOTION_RECOVERY_REVIEW_CODE_REQUIRED');
  const r=previewRecovery({standaloneRoot:root,requestId});
  if(code!==r.reviewCode)throw Error('PROMOTION_RECOVERY_REVIEW_CODE_MISMATCH');
  const result=await recoverUnknownPromotion({
   standaloneRoot:root,requestId,confirm:code
  });
  console.log(JSON.stringify(result,null,2));
  if(!result.recovered)process.exitCode=1;
 }else if(cmd==='status'){
  if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{8,80}$/.test(requestId))
   throw Error('PROMOTION_REQUEST_ID_INVALID');
  console.log(JSON.stringify(status(requestId),null,2));
 }else{help();process.exitCode=2;}
}catch(e){
 const safe=/^[A-Z][A-Z0-9_]{2,80}$/.test(e.message)?e.message:'PROMOTION_OWNER_OPERATION_FAILED';
 console.error('THEO_OWNER_PROMOTION_STOPPED',safe);
 process.exitCode=1;
}
