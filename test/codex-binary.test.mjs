import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,chmodSync,symlinkSync,rmSync
} from 'node:fs';
import {join} from 'node:path';
import {findCodexExecutable,codexExecutableInfo} from '../src/codex-binary.mjs';

test('Codex binary finder supports portable owner-home path and checks executable mode',()=>{
 const root=mkdtempSync('/private/tmp/theo-codex-bin-test-');
 try{
  const dir=join(root,'.local','bin');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const bin=join(dir,'codex');
  writeFileSync(bin,'#!/bin/sh\nexit 0\n',{mode:0o700});
  chmodSync(bin,0o700);
  assert.equal(findCodexExecutable({home:root,env:{PATH:''}}),bin);
  const present=codexExecutableInfo({home:root,env:{PATH:''}});
  assert.equal(present.present,true);
  assert.equal(present.symlink,false);
  chmodSync(bin,0o666);
  assert.throws(()=>findCodexExecutable({home:root,env:{
   THEO_CODEX_BIN:bin,PATH:''
  }}),/CODEX_BIN_OVERRIDE_UNSAFE/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Codex binary finder accepts verified owner binary symlinks but never executes them',()=>{
 const root=mkdtempSync('/private/tmp/theo-codex-bin-symlink-');
 try{
  const dir=join(root,'.local','bin');
  mkdirSync(dir,{recursive:true,mode:0o700});
  const target=join(root,'codex-real');
  writeFileSync(target,'#!/bin/sh\nprintf SHOULD_NOT_RUN\n',{mode:0o700});
  chmodSync(target,0o700);
  symlinkSync(target,join(dir,'codex'));
  const p=findCodexExecutable({home:root,env:{PATH:''}});
  assert.equal(p,join(dir,'codex'));
  assert.equal(codexExecutableInfo({home:root,env:{PATH:''}}).symlink,true);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid explicit Codex binary cannot be silently replaced with another executable',()=>{
 const root=mkdtempSync('/private/tmp/theo-codex-bin-unsafe-');
 try{
  assert.throws(()=>findCodexExecutable({
   home:root,env:{THEO_CODEX_BIN:join(root,'missing'),PATH:''}
  }),/CODEX_BIN_OVERRIDE_UNSAFE/);
  assert.throws(()=>findCodexExecutable({
   home:root,env:{THEO_CODEX_BIN:'codex',PATH:''}
  }),/CODEX_BIN_OVERRIDE_UNSAFE/);
  assert.throws(()=>findCodexExecutable({
   home:root,env:{THEO_CODEX_BIN:'/bin/sh',PATH:''},platform:'win32'
  }),/CODEX_MACOS_REQUIRED/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
