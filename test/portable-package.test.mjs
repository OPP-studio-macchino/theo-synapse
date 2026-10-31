import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync
} from 'node:fs';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {verifyPortableBundle} from '../scripts/verify-portable-bundle.mjs';
import {renderLaunchAgent,stageLaunchAgent} from '../scripts/stage-launchagent.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const baseFiles=[
 'package.json','package-lock.json','README.md',
 'src/mcp.mjs','src/native-core.mjs','src/task-daemon.mjs','src/direct-action-review.mjs','scripts/setup-readonly-lab.mjs',
 'scripts/theo-task-entry.mjs','scripts/mcp-schema-parity-smoke.mjs','scripts/theo-native-plugin-doctor.mjs',
 'scripts/theo-direct-workspaces.mjs','scripts/theo-direct-daemon-entry.mjs','assets/theo-synapse-icon-64.png',
 'src/foo.mjs','src/bar.mjs','scripts/doctor.mjs','scripts/agent.mjs'
];
function fixture(){
 const root=mkdtempSync('/private/tmp/theo-portable-verify-unit-');
 const items=baseFiles.map(p=>{
  const bytes=Buffer.from('synthetic preview fixture: '+p+'\n');
  const path=join(root,p);
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path,bytes,{mode:0o600});
  return {path:p,bytes:bytes.length,sha256:sha(bytes)};
 });
 const manifest={
  schema:1,product:'Theo Synapse',version:'0.0.5',releaseType:'READONLY_PREVIEW',
  files:items
 };
 const path=join(root,'release-manifest.json');
 const save=()=>writeFileSync(path,JSON.stringify(manifest),{mode:0o600});
 save();
 return {root,manifest,save,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('portable manifest checks every declared file without running any model',()=>{
 const f=fixture();
 try{
  const result=verifyPortableBundle(f.root);
  assert.equal(result.verdict,'PASS');
  assert.equal(result.fileCount,baseFiles.length);
  assert.deepEqual(result.failures,[]);
 }finally{f.cleanup();}
});
test('portable bundle rejects source tampering and unexpected files',()=>{
 const f=fixture();
 try{
  writeFileSync(join(f.root,'README.md'),'content was replaced\n');
  let result=verifyPortableBundle(f.root);
  assert.equal(result.verdict,'FAIL');
  assert.ok(result.failures.some(x=>x.path==='README.md'));
  writeFileSync(join(f.root,'README.md'),'synthetic preview fixture: README.md\n');
  writeFileSync(join(f.root,'src','extra.mjs'),'surprise\n',{mode:0o600});
  result=verifyPortableBundle(f.root);
  assert.equal(result.verdict,'FAIL');
  assert.ok(result.failures.some(x=>x.path==='src/extra.mjs'&&x.code==='UNEXPECTED_FILE'));
 }finally{f.cleanup();}
});
test('portable manifest refuses archive path tricks and credential paths',()=>{
 const f=fixture();
 try{
  f.manifest.files[0].path='../outside.txt';
  f.save();
  assert.throws(()=>verifyPortableBundle(f.root),/PORTABLE_MANIFEST_ENTRY_INVALID/);
  f.manifest.files[0].path='.local/secrets/api.key';
  f.save();
  assert.throws(()=>verifyPortableBundle(f.root),/PORTABLE_MANIFEST_SECRET_PATH/);
 }finally{f.cleanup();}
});
test('portable manifest rejects symlink entries and duplicate names',()=>{
 const f=fixture();
 try{
  const src=join(f.root,'src','foo.mjs');
  rmSync(src);
  symlinkSync(join(f.root,'README.md'),src);
  assert.equal(verifyPortableBundle(f.root).verdict,'FAIL');
  f.manifest.files[1].path=f.manifest.files[0].path;
  f.save();
  assert.throws(()=>verifyPortableBundle(f.root),/PORTABLE_MANIFEST_DUPLICATE/);
 }finally{f.cleanup();}
});
test('runtime and node_modules are excluded from package hash enforcement',()=>{
 const f=fixture();
 try{
  mkdirSync(join(f.root,'.local'),{mode:0o700});
  writeFileSync(join(f.root,'.local','private.json'),'not in manifest',{mode:0o600});
  mkdirSync(join(f.root,'node_modules'),{mode:0o700});
  writeFileSync(join(f.root,'node_modules','ignored.txt'),'module',{mode:0o600});
  assert.equal(verifyPortableBundle(f.root).verdict,'PASS');
 }finally{f.cleanup();}
});
test('macOS LaunchAgent content is review-only; does not install or start anything',()=>{
 if(process.platform!=='darwin')return;
 const f=fixture();
 try{
  const runtime=join(f.root,'.local','theo-runtime');
  mkdirSync(runtime,{recursive:true,mode:0o700});
  const result=stageLaunchAgent(f.root);
  assert.equal(result.state,'STAGED_ONLY');
  assert.equal(result.installed,false);
  assert.equal(result.started,false);
  assert.equal(result.manualOwnerActionRequired,true);
  const xml=readFileSync(result.path,'utf8');
  assert.match(xml,/<key>KeepAlive<\/key><false\/>/);
  assert.match(xml,/<key>RunAtLoad<\/key><true\/>/);
  assert.match(xml,/<key>Umask<\/key><integer>63<\/integer>/);
  assert.doesNotMatch(xml,/launchctl|launchdaemon/i);
  const checked=spawnSync('/usr/bin/plutil',['-lint',result.path],{
   encoding:'utf8',timeout:7000
  });
  assert.equal(checked.status,0,String(checked.stderr).slice(0,200));
  assert.equal(stageLaunchAgent(f.root).state,'STAGED_ONLY');
 }finally{f.cleanup();}
});
