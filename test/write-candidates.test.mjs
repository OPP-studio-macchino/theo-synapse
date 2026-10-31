import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {prepareWritePlan,stageApprovedCandidate,verifyCandidateChanges,discardCandidate,snapshotManifest} from '../src/write-candidates.mjs';

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-write-candidate-');
 const privateDir=join(root,'runtime'),source=join(root,'snapshot');
 mkdirSync(privateDir,{mode:0o700});mkdirSync(source,{mode:0o700});
 mkdirSync(join(source,'extension'),{mode:0o700});
 writeFileSync(join(source,'README.md'),'Read-only snapshot metadata\n',{mode:0o600});
 writeFileSync(join(source,'extension','popup.js'),'export const LABEL = "BEFORE";\n',{mode:0o600});
 writeFileSync(join(source,'extension','watch.js'),'export const KEEP = 1;\n',{mode:0o600});
 const plan=()=>prepareWritePlan({projectRoot:source,id:'theo-write-0001',projectId:'chappy-signal',
  instruction:'Replace the LABEL in extension/popup.js with AFTER.',
  allowedFiles:['extension/popup.js']});
 return {root,privateDir,source,plan,
  cleanup(){rmSync(root,{recursive:true,force:true});}};
}
test('consumed staging copies only private workspace and changes ONLY allowed file',()=>{
 const f=fixture();
 try{
  const scope=f.plan();
  assert.equal(scope.allowedFiles.length,1);
  const digest=snapshotManifest(f.source).hash;
  const s=stageApprovedCandidate({runtime:f.privateDir,projectRoot:f.source,request:scope});
  assert.equal(s.before.hash,digest);
  const file=join(s.candidateDir,'extension','popup.js');
  writeFileSync(file,'export const LABEL = "AFTER";\n');
  const result=verifyCandidateChanges({candidateDir:s.candidateDir,before:s.before,
   allowedFiles:scope.allowedFiles});
  assert.deepEqual(result.changedFiles.map(x=>x.path),['extension/popup.js']);
  assert.equal(readFileSync(join(f.source,'extension','popup.js'),'utf8'),
   'export const LABEL = "BEFORE";\n');
  assert.equal(snapshotManifest(f.source).hash,digest);
 }finally{f.cleanup();}
});
test('changing an unapproved file or adding any file rejects candidate',()=>{
 const f=fixture();
 try{
  const req=f.plan();
  const stage=stageApprovedCandidate({runtime:f.privateDir,projectRoot:f.source,request:req});
  writeFileSync(join(stage.candidateDir,'extension','watch.js'),'unauthorized\n');
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_UNAPPROVED_FILE_MODIFIED/);
  writeFileSync(join(stage.candidateDir,'extension','watch.js'),'export const KEEP = 1;\n');
  writeFileSync(join(stage.candidateDir,'new.js'),'surprise\n',{mode:0o600});
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_UNAPPROVED_PATH_OR_DELETE/);
 }finally{f.cleanup();}
});
test('deletions, symlinks, secrets, no change and stale source digest all fail closed',()=>{
 const f=fixture();
 try{
  const req=f.plan(),stage=stageApprovedCandidate({runtime:f.privateDir,projectRoot:f.source,request:req});
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_NO_CHANGES/);
  const edited=join(stage.candidateDir,'extension','popup.js');
  writeFileSync(edited,'export const secret = "sk\u002dproj-THEO_PUBLIC_SYNTHETIC_001_AAAAAAAAAAAAAAAAAAAAAAAA";\n');
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_OUTPUT_NOT_SAFE_TEXT/);
  unlinkSync(edited);symlinkSync(join(f.source,'extension','popup.js'),edited);
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_SYMLINK_DETECTED/);
  unlinkSync(edited);
  assert.throws(()=>verifyCandidateChanges({candidateDir:stage.candidateDir,before:stage.before,
   allowedFiles:req.allowedFiles}),/WRITE_UNAPPROVED_PATH_OR_DELETE/);
  writeFileSync(join(f.source,'README.md'),'Snapshot unexpectedly changed\n');
  assert.throws(()=>stageApprovedCandidate({runtime:f.privateDir,projectRoot:f.source,request:{
   ...req,id:'theo-write-0002'}}),/WRITE_SNAPSHOT_HASH_CHANGED/);
 }finally{f.cleanup();}
});
test('invalid path scopes and duplicate allowed paths refuse requests',()=>{
 const f=fixture();
 try{
  assert.throws(()=>prepareWritePlan({projectRoot:f.source,id:'theo-write-0002',projectId:'chappy-signal',
   instruction:'Modify exactly requested file, no others.',allowedFiles:['../outside.txt']}),/WRITE_PATH_INVALID/);
  assert.throws(()=>prepareWritePlan({projectRoot:f.source,id:'theo-write-0002',projectId:'chappy-signal',
   instruction:'Use secret sk\u002dproj-THEO_PUBLIC_SYNTHETIC_002_AAAAAAAAAAAAAAAAAAAAAAAA for this change.',allowedFiles:['extension/popup.js']}),/WRITE_INSTRUCTION_CONTAINS_SECRET/);
  assert.throws(()=>prepareWritePlan({projectRoot:f.source,id:'theo-write-0002',projectId:'chappy-signal',
   instruction:'Modify exactly requested file, no others.',allowedFiles:['extension/popup.js','extension/popup.js']}),/WRITE_FILE_SELECTION_DUPLICATE/);
  assert.throws(()=>prepareWritePlan({projectRoot:f.source,id:'theo-write-0002',projectId:'chappy-signal',
   instruction:'Modify exactly requested file, no others.',allowedFiles:['README.md','other.pdf']}),/WRITE_FILE_NOT_PRESENT/);
 }finally{f.cleanup();}
});

test('candidate cleanup refuses paths outside the exact private stage parent',()=>{
 const f=fixture();
 try{
  const outside=join(f.source,'README.md');
  assert.throws(()=>discardCandidate(outside,f.privateDir),/WRITE_DISCARD_OUTSIDE_STAGE/);
  assert.equal(readFileSync(outside,'utf8'),'Read-only snapshot metadata\n');
 }finally{f.cleanup();}
});
