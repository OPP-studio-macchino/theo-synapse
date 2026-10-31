import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,chmodSync,rmSync,symlinkSync
} from 'node:fs';
import {join} from 'node:path';
import {readWriteRelease,assertHostWriteGate} from '../src/write-release.mjs';

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-write-release-audit-');
 const local=join(root,'.local'),runtime=join(local,'theo-runtime'),
 projects=join(runtime,'projects'),folder=join(projects,'candidate-lab');
 for(const dir of [local,runtime,projects,folder])mkdirSync(dir,{mode:0o700});
 writeFileSync(join(runtime,'projects.json'),JSON.stringify({
  schema:1,projects:{'candidate-lab':folder}
 }),{mode:0o600});
 const path=join(runtime,'write-release.json');
 const config={schema:1,enabled:false,sourceWriteEnabled:false,
  candidateOnly:true,projectIds:['candidate-lab'],maxFiles:1};
 return {
  root,path,config,
  save(obj=config,mode=0o600){
   writeFileSync(path,JSON.stringify(obj),{mode});
   chmodSync(path,mode);
  },
  cleanup:()=>rmSync(root,{recursive:true,force:true})
 };
}
test('missing local write-release config means disabled, never an implied authorization',()=>{
 const f=fixture();
 try{
  assert.equal(readWriteRelease(f.root).enabled,false);
  assert.equal(readWriteRelease(f.root).maxFiles,0);
  assert.throws(()=>readWriteRelease(f.root,{required:true}),/WRITE_RELEASE_NOT_CONFIGURED/);
  assert.throws(()=>assertHostWriteGate(f.root,f.config),/WRITE_RELEASE_NOT_CONFIGURED/);
 }finally{f.cleanup();}
});
test('a valid explicitly disabled policy remains read-only and frozen',()=>{
 const f=fixture();
 try{
  f.save();
  const v=readWriteRelease(f.root);
  assert.equal(v.enabled,false);
  assert.equal(v.candidateOnly,true);
  assert.equal(v.maxFiles,1);
  assert.deepEqual(v.projectIds,['candidate-lab']);
  assert.equal(Object.isFrozen(v),true);
  assert.equal(Object.isFrozen(v.projectIds),true);
  assert.throws(()=>assertHostWriteGate(f.root,v),/WRITE_RELEASE_NOT_AUTHORIZED/);
 }finally{f.cleanup();}
});
test('world-readable config, symlink and wrong owner-project are all refused',()=>{
 const f=fixture();
 try{
  f.save(f.config,0o644);
  assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_CONFIG_UNSAFE/);
  const invalid={...f.config,projectIds:['unregistered-project']};
  f.save(invalid);
  assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_PROJECT_NOT_REGISTERED/);
  rmSync(f.path,{force:true});
  const fake=join(f.root,'alternate.json');
  writeFileSync(fake,JSON.stringify(f.config),{mode:0o600});
  symlinkSync(fake,f.path);
  assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_CONFIG_UNSAFE/);
 }finally{f.cleanup();}
});
test('unexpected fields, source-write mode, broad file count and reserved lab are rejected',()=>{
 const f=fixture();
 try{
  const cases=[
   {...f.config,unreviewedFlag:true},
   {...f.config,sourceWriteEnabled:true},
   {...f.config,maxFiles:10},
   {...f.config,candidateOnly:false},
   {...f.config,projectIds:['theo-lab']},
   {...f.config,projectIds:['candidate-lab','candidate-lab']},
   {...f.config,enabled:'true'}
  ];
  for(const obj of cases){
   f.save(obj);
   assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_CONFIG_INVALID/);
  }
 }finally{f.cleanup();}
});
test('garbage/oversized JSON cannot unlock permissions',()=>{
 const f=fixture();
 try{
  writeFileSync(f.path,'{ broken json...',{mode:0o600});
  assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_CONFIG_INVALID/);
  writeFileSync(f.path,JSON.stringify(f.config)+' '.repeat(2500));
  assert.throws(()=>readWriteRelease(f.root),/WRITE_RELEASE_CONFIG_UNSAFE/);
 }finally{f.cleanup();}
});
