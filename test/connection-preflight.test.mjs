import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {runConnectionPreflight,classifyConnectionStatus} from '../src/connection-preflight.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const base=mkdtempSync('/private/tmp/theo-connection-preflight-'),legacy=join(base,'legacy'),native=join(base,'native'),profile=join(base,'profile.yaml'),manifest=join(base,'manifest.json');
 for(const root of [legacy,native]){const runtime=join(root,'.local/theo-runtime'),projects=join(runtime,'projects');mkdirSync(projects,{recursive:true,mode:0o700});const entries=root===legacy?['theo-lab','chappy-signal']:['theo-lab'];const registered={};for(const id of entries){const p=join(projects,id);mkdirSync(p,{mode:0o700});writeFileSync(join(p,'INPUT.md'),id==='theo-lab'?'same\n':'legacy only\n',{mode:0o600});registered[id]=p;}writeFileSync(join(runtime,'projects.json'),JSON.stringify({schema:1,projects:registered}),{mode:0o600});}
 mkdirSync(join(native,'src'),{mode:0o700});const source=Buffer.from('native core\n');writeFileSync(join(native,'src/core.mjs'),source,{mode:0o600});writeFileSync(manifest,JSON.stringify({schema:1,files:[{path:'src/core.mjs',bytes:source.length,sha256:sha(source)}]}),{mode:0o600});writeFileSync(profile,`mcp:\n  commands:\n    - channel: main\n      command: "/usr/local/bin/node ${native}/scripts/theo-task-entry.mjs"\n`,{mode:0o600});
 return {legacy,native,profile,manifest,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
test('preflight intentionally excludes chappy-signal from native registration and never exposes profile secrets',async()=>{
 const f=fixture();try{const report=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});assert.equal(report.verdict,'BLOCKED');assert.deepEqual(report.legacy.projects,['chappy-signal','theo-lab']);assert.deepEqual(report.native.projects,['theo-lab']);assert.ok(report.projects.some(x=>x.id==='chappy-signal'&&x.status==='EXCLUDED'&&x.reason==='OWNER_EXCLUDED_FROM_NATIVE_MIGRATION'));assert.equal(report.tunnel.target,'NATIVE');assert.equal(JSON.stringify(report).includes('api_key'),false);}finally{f.cleanup();}
});
test('preflight fails closed for a profile symlink and an altered native Core',async()=>{
 const f=fixture();try{rmSync(f.profile);symlinkSync('/dev/null',f.profile);let report=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});assert.equal(report.tunnel.status,'BLOCKED');assert.equal(report.verdict,'BLOCKED');rmSync(f.profile);writeFileSync(f.profile,`mcp:\n  commands:\n    - channel: main\n      command: "/usr/local/bin/node ${f.native}/scripts/theo-task-entry.mjs"\n`,{mode:0o600});writeFileSync(join(f.native,'src/core.mjs'),'tampered\n',{mode:0o600});report=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});assert.equal(report.core.status,'BLOCKED');assert.equal(report.core.reason,'CORE_HASH_MISMATCH');}finally{f.cleanup();}
});


test('pre-cutover and post-cutover states remain distinct from acceptance',()=>{
 assert.equal(classifyConnectionStatus([], 'LEGACY'),'READY_FOR_OWNER_APPROVAL');
 assert.equal(classifyConnectionStatus([], 'NATIVE'),'POST_CUTOVER_VALIDATION_REQUIRED');
 assert.equal(classifyConnectionStatus(['FORBIDDEN_NATIVE_PROJECT_REGISTERED'],'LEGACY'),'BLOCKED');
 assert.equal(classifyConnectionStatus([], 'UNKNOWN'),'BLOCKED');
});

test('profile executable injection or multiple channels fail closed',async()=>{
 const f=fixture();
 try{
  writeFileSync(f.profile,`mcp:\n  commands:\n    - channel: main\n      command: \"/bin/sh -c /usr/local/bin/node ${f.native}/scripts/theo-task-entry.mjs\"\n`,{mode:0o600});
  let report=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});
  assert.equal(report.tunnel.status,'BLOCKED');
  assert.equal(report.tunnel.reason,'PROFILE_EXECUTABLE_UNEXPECTED');
  writeFileSync(f.profile,`mcp:\n  commands:\n    - channel: main\n      command: \"/usr/local/bin/node ${f.native}/scripts/theo-task-entry.mjs\"\n    - channel: rogue\n      command: \"/usr/local/bin/node ${f.native}/scripts/theo-task-entry.mjs\"\n`,{mode:0o600});
  report=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});
  assert.equal(report.tunnel.status,'BLOCKED');
  assert.equal(report.tunnel.reason,'PROFILE_AMBIGUOUS');
 }finally{f.cleanup();}
});

test('forbidden chappy-signal in a native registry is a hard blocker',async()=>{
 const f=fixture();
 try{
  const runtime=join(f.native,'.local','theo-runtime');
  const projects=join(runtime,'projects');
  const chappy=join(projects,'chappy-signal');
  mkdirSync(chappy,{mode:0o700});
  writeFileSync(join(chappy,'INPUT.md'),'legacy only\n',{mode:0o600});
  writeFileSync(join(runtime,'projects.json'),JSON.stringify({
   schema:1,projects:{'theo-lab':join(projects,'theo-lab'),'chappy-signal':chappy}
  }),{mode:0o600});
  const report=await runConnectionPreflight({
   legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest
  });
  assert.equal(report.verdict,'BLOCKED');
  assert.ok(report.projects.some(x=>x.id==='chappy-signal'&&
   x.status==='BLOCKED'&&x.reason==='FORBIDDEN_NATIVE_PROJECT_REGISTERED'));
 }finally{f.cleanup();}
});


test('native tunnel command accepts a single quoted Core script path without extra arguments',async()=>{
 const f=fixture();
 try{
  writeFileSync(f.profile,`mcp:\n  commands:\n    - channel: main\n      command: "/usr/local/bin/node '${f.native}/scripts/theo-task-entry.mjs'"\n`,{mode:0o600});
  const result=await runConnectionPreflight({legacyRoot:f.legacy,nativeCore:f.native,profile:f.profile,manifestPath:f.manifest});
  assert.equal(result.tunnel.status,'PASS');
  assert.equal(result.tunnel.target,'NATIVE');
 }finally{f.cleanup();}
});
