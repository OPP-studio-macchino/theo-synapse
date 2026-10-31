import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('owner project CLI emits one machine-readable read-only preview without approval',()=>{
 const source=mkdtempSync('/private/tmp/theo-native-preview-');
 try{
  writeFileSync(join(source,'README.md'),'Safe preview fixture.\n',{mode:0o600});
  const id=`native-preview-${process.pid}`;
  const result=spawnSync(process.execPath,['scripts/theo-projects.mjs','plan',id,source],{
   cwd:process.cwd(),encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']
  });
  assert.equal(result.status,0,result.stderr);
  const preview=JSON.parse(result.stdout);
  assert.equal(preview.operation,'OWNER_PROJECT_REVIEW');
  assert.equal(preview.id,id);assert.equal(preview.displayName,source.split('/').at(-1));
  assert.equal(preview.eligibleFiles,1);assert.deepEqual(preview.files.map(x=>x.path),['README.md']);
  assert.match(preview.digest,/^[a-f0-9]{64}$/);assert.equal(preview.fingerprint,preview.digest.slice(0,20));
  assert.equal(preview.sourceChanged,false);
 }finally{rmSync(source,{recursive:true,force:true});}
});

test('development and legacy-style CLI can still list the historical chappy-signal registry',()=>{
 const result=spawnSync(process.execPath,['scripts/theo-projects.mjs','list'],{
   cwd:process.cwd(),encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']
 });
 assert.equal(result.status,0,result.stderr);
 assert.ok(JSON.parse(result.stdout).projects.some(project=>project.id==='chappy-signal'));
});

test('native source keeps folder choice separate from preview and import approval',()=>{
 const host=readFileSync('macos/DesktopHost.swift','utf8');
 const ui=readFileSync('macos/TheoSynapse.swift','utf8');
 const daemon=readFileSync('src/task-daemon.mjs','utf8');
 assert.match(host,/func planSnapshot\(id:String,path:String\)/);
 assert.match(host,/func importSnapshot\(id:String,path:String,confirm:String\)/);
 assert.match(host,/\[script\.path,"plan",id,source\.path\]/);
 assert.match(host,/\[script\.path,"import",id,source\.path,confirm\]/);
 assert.doesNotMatch(host,/\/bin\/(?:zsh|sh)/);
 assert.match(ui,/canChooseFiles=false/);assert.match(ui,/canChooseDirectories=true/);
 assert.match(host,/id != "chappy-signal"/);
 assert.match(ui,/ChatGPT接続の状態/);
 assert.match(ui,/ChatGPTからの実接続はこの画面だけでは証明できないため、未確認と表示します/);
 assert.match(ui,/まだコピーしていません/);
 assert.match(daemon,/OWNER_REGISTRY_UPDATE_ACTIVE/);
 assert.match(daemon,/\.registry-owner-lock/);
});
