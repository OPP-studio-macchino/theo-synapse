import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,symlinkSync,unlinkSync
} from 'node:fs';
import {join} from 'node:path';
import {inspectReleaseReadiness} from '../src/release-health.mjs';

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-health-lab-');
 const local=join(root,'.local'),runtime=join(local,'theo-runtime');
 const projects=join(runtime,'projects'),lab=join(projects,'chappy-signal');
 const source=mkdtempSync('/private/tmp/theo-health-source-');
 for(const dir of [local,runtime,projects,lab,join(root,'scripts'),join(root,'src')])
  mkdirSync(dir,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({
  schema:1,projects:{'chappy-signal':lab}
 }),{mode:0o600});
 writeFileSync(join(lab,'README.md'),'Synthetic approved read-only snapshot.\n',{mode:0o600});
 writeFileSync(join(source,'README.md'),'Synthetic approved read-only snapshot.\n',{mode:0o600});
 writeFileSync(join(root,'scripts','theo-task-entry.mjs'),
  'remoteCoordinator:client\n// excludes write coordinator\n',{mode:0o600});
 writeFileSync(join(root,'scripts','task-daemon-entry.mjs'),
  'startTaskDaemon({root,maxDurationMs:60000})\n',{mode:0o600});
 writeFileSync(join(root,'src','mcp.mjs'),
  'if(writeCoordinator){\nstandalone_write_request\n}\n',{mode:0o600});
 const inspect=()=>inspectReleaseReadiness({
  root,sourceProject:source,expectedProjectIds:['chappy-signal'],
  checkOriginalHashes:true,expectedFileCount:1
 });
 return {
  root,local,runtime,projects,lab,source,inspect,
  cleanup(){rmSync(root,{recursive:true,force:true});rmSync(source,{recursive:true,force:true});}
 };
}
test('release gate passes a private read-only fixture without starting any model',()=>{
 const f=fixture();
 try{
  const report=f.inspect();
  assert.equal(report.verdict,'PASS_READONLY_ONLY');
  assert.equal(report.failed,0);
  assert.equal(report.testOrGrantStarted,false);
  assert.equal(report.writeFeatureEnabled,false);
  assert.ok(report.checked>=9);
  assert.ok(report.checks.every(c=>c.status==='PASS'));
 }finally{f.cleanup();}
});
test('release gate refuses a newly present live write database',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.runtime,'writes.sqlite'),'synthetic-not-a-real-db',{mode:0o600});
  const report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='no_live_write_journal_or_promotion'&&c.status==='FAIL'));
 }finally{f.cleanup();}
});
test('release gate detects an unregistered or mismatched project list',()=>{
 const f=fixture();
 try{
  const report=inspectReleaseReadiness({
   root:f.root,expectedProjectIds:['chappy-signal','unexpected-project']
  });
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='registered_project_allowlist'&&c.status==='FAIL'));
 }finally{f.cleanup();}
});
test('release gate rejects world-readable private snapshots',()=>{
 const f=fixture();
 try{
  chmodSync(join(f.lab,'README.md'),0o644);
  const report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='snapshot_files_private_and_non_symlink'&&c.status==='FAIL'));
 }finally{f.cleanup();}
});
test('release gate rejects a symlink and mismatched original without exposing contents',()=>{
 const f=fixture();
 try{
  const link=join(f.lab,'extra-link.md');
  symlinkSync(join(f.source,'README.md'),link);
  let report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='snapshot_files_private_and_non_symlink'&&c.status==='FAIL'));
  unlinkSync(link);
  writeFileSync(join(f.source,'README.md'),'The source changed independently.\n');
  report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='chappy_original_vs_registered_snapshot'&&c.status==='FAIL'));
 }finally{f.cleanup();}
});
test('release gate rejects a changed public MCP entrypoint',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.root,'scripts','theo-task-entry.mjs'),
   'remoteCoordinator:client\nwriteCoordinator:client\n',{mode:0o600});
  const report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='mcp_entrypoint_not_write_enabled'&&c.status==='FAIL'));
 }finally{f.cleanup();}
});
test('release gate rejects unexpected world-readable secret files',()=>{
 const f=fixture();
 try{
  const dir=join(f.local,'secrets');
  mkdirSync(dir,{mode:0o700});
  const secret=join(dir,'runtime.key');
  writeFileSync(secret,'synthetic-fixture-value',{mode:0o600});
  chmodSync(secret,0o644); // explicit after creation: node test runner may set umask 077
  const report=f.inspect();
  assert.equal(report.verdict,'FAIL');
  assert.ok(report.checks.some(c=>c.name==='private_runtime_credentials'&&c.status==='FAIL'));
  assert.equal(JSON.stringify(report).includes('synthetic-fixture-value'),false);
 }finally{f.cleanup();}
});
test('release gate detects a disabled release policy error without enabling writes',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.runtime,'write-release.json'),JSON.stringify({
   schema:1,enabled:false,candidateOnly:true,
   projectIds:['chappy-signal'],sourceWriteEnabled:false,maxFiles:1
  }),{mode:0o600});
  const report=f.inspect();
  assert.equal(report.verdict,'PASS_READONLY_ONLY');
  assert.equal(report.writeFeatureEnabled,false);
  assert.ok(report.checks.some(c=>c.name==='live_write_release_not_enabled'&&c.status==='PASS'));
 }finally{f.cleanup();}
});
