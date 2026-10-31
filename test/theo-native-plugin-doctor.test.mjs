import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {EXPECTED_TOOLS,inspectNativeCore,runNativePluginDoctor} from '../src/theo-native-plugin-doctor.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const base=mkdtempSync('/private/tmp/theo-native-doctor-'),core=join(base,'core'),app=join(base,'Theo Synapse.app'),manifest=join(base,'core-manifest.json');
 mkdirSync(join(core,'.local/theo-runtime/projects/theo-lab'),{recursive:true,mode:0o700});
 mkdirSync(join(core,'scripts'),{recursive:true,mode:0o700});
 const entry=Buffer.from('export {};\n');writeFileSync(join(core,'scripts/theo-task-entry.mjs'),entry,{mode:0o600});
 writeFileSync(join(core,'.local/theo-runtime/projects/theo-lab/INPUT.md'),'demo\n',{mode:0o600});
 writeFileSync(join(core,'.local/theo-runtime/projects.json'),JSON.stringify({schema:1,projects:{'theo-lab':join(core,'.local/theo-runtime/projects/theo-lab')}}),{mode:0o600});
 writeFileSync(manifest,JSON.stringify({schema:1,files:[{path:'scripts/theo-task-entry.mjs',bytes:entry.length,sha256:sha(entry)}]}),{mode:0o600});
 return {core,app,manifest,cleanup:()=>rmSync(base,{recursive:true,force:true})};
}
const readySeam={daemonPing:async()=>({alive:true,mode:'read_only'}),mcpProbe:async()=>({tools:EXPECTED_TOOLS,capabilities:{writeEnabled:false,candidateWriteEnabled:false}}),appInspector:()=>({status:'NOT_CHECKED',code:'APP_NOT_INSTALLED'}),tunnelHealth:async()=>({status:'PASS',code:'TUNNEL_CONTROL_PLANE_POLL_OK'})};
test('native-only doctor reaches local+tunnel readiness without legacy state',async()=>{
 const f=fixture();try{
  const health=f.manifest+'.health-url';writeFileSync(health,'https://example.invalid\n',{mode:0o600});
  const report=await runNativePluginDoctor({nativeCore:f.core,manifestPath:f.manifest,app:f.app,healthUrlFile:health,requireControlPlanePoll:true},readySeam);
  assert.equal(report.verdict,'LOCAL_TUNNEL_READY_CHATGPT_E2E_REQUIRED');
  assert.deepEqual(report.checks.registry.projects,['theo-lab']);
  assert.equal(JSON.stringify(report).includes(f.core),false);
 }finally{f.cleanup();}
});
test('native doctor rejects Chappy, modified manifests, and symlinks',async()=>{
 const f=fixture();try{
  const registry=join(f.core,'.local/theo-runtime/projects.json');
  writeFileSync(registry,JSON.stringify({schema:1,projects:{'theo-lab':join(f.core,'.local/theo-runtime/projects/theo-lab'),'chappy-signal':join(f.core,'.local/theo-runtime/projects/theo-lab')}}),{mode:0o600});
  let report=await runNativePluginDoctor({nativeCore:f.core,manifestPath:f.manifest,app:f.app},readySeam);
  assert.equal(report.checks.registry.status,'FAIL');
  writeFileSync(registry,JSON.stringify({schema:1,projects:{'theo-lab':join(f.core,'.local/theo-runtime/projects/theo-lab')}}),{mode:0o600});
  writeFileSync(join(f.core,'scripts/theo-task-entry.mjs'),'changed\n',{mode:0o600});
  assert.equal(inspectNativeCore({nativeCore:f.core,manifestPath:f.manifest}).code,'CORE_HASH_MISMATCH');
  writeFileSync(join(f.core,'scripts/theo-task-entry.mjs'),'export {};\n',{mode:0o600});
  symlinkSync('/dev/null',join(f.core,'rogue'));
  assert.equal(inspectNativeCore({nativeCore:f.core,manifestPath:f.manifest}).code,'CORE_SYMLINK_DETECTED');
 }finally{f.cleanup();}
});
test('missing native software is explicit and never reported ready',async()=>{
 const report=await runNativePluginDoctor({nativeCore:'/private/tmp/missing-theo-core',manifestPath:'/private/tmp/missing-theo-manifest',app:'/private/tmp/missing-theo-app'},readySeam);
 assert.equal(report.verdict,'SETUP_REQUIRED');
 assert.equal(report.checks.core.status,'FAIL');
 assert.equal(report.checks.core.code,'NATIVE_CORE_NOT_INSTALLED');
 assert.equal(report.checks.app.code,'APP_NOT_INSTALLED');
 assert.equal(report.checks.tunnel.code,'TUNNEL_HEALTH_URL_FILE_REQUIRED');
});

test('additional approved native projects remain valid, but a failing app signature blocks readiness',async()=>{
 const f=fixture();
 try{
  const extra=join(f.core,'.local/theo-runtime/projects/owner-demo');
  mkdirSync(extra,{mode:0o700});
  writeFileSync(join(extra,'README.md'),'owner approved demo\n',{mode:0o600});
  writeFileSync(join(f.core,'.local/theo-runtime/projects.json'),JSON.stringify({
   schema:1,projects:{
    'theo-lab':join(f.core,'.local/theo-runtime/projects/theo-lab'),
    'owner-demo':extra
   }
  }),{mode:0o600});
  const health=f.manifest+'.health-url';
  writeFileSync(health,'http://127.0.0.1:12345\n',{mode:0o600});
  const options={nativeCore:f.core,manifestPath:f.manifest,app:f.app,healthUrlFile:health,requireControlPlanePoll:true};
  const valid=await runNativePluginDoctor(options,readySeam);
  assert.equal(valid.checks.registry.status,'PASS');
  assert.deepEqual(valid.checks.registry.projects,['owner-demo','theo-lab']);
  assert.equal(valid.verdict,'LOCAL_TUNNEL_READY_CHATGPT_E2E_REQUIRED');
  const invalid=await runNativePluginDoctor(options,{
   ...readySeam,appInspector:()=>({status:'FAIL',code:'APP_SIGNATURE_INVALID'})
  });
  assert.equal(invalid.checks.app.code,'APP_SIGNATURE_INVALID');
  assert.equal(invalid.verdict,'SETUP_REQUIRED');
 }finally{f.cleanup();}
});
