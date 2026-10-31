import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

test('explicit direct host refuses development checkout without creating a runtime journal',()=>{
 const root=resolve(import.meta.dirname,'..');
 const journal=join(root,'.local','theo-runtime','direct.sqlite');
 const before=existsSync(journal);
 const result=spawnSync(process.execPath,[join(root,'scripts','theo-direct-daemon-entry.mjs')],{
  cwd:root,encoding:'utf8',timeout:7000,maxBuffer:4096,stdio:['ignore','pipe','pipe']
 });
 assert.equal(result.status,78);
 assert.match(result.stderr,/DIRECT_NATIVE_HOST_ONLY/);
 assert.equal(existsSync(journal),before);
 assert.doesNotMatch(result.stdout,/APPROVED|TOKEN|KEY/);
});
test('explicit direct host cannot accept caller flags or extra launch parameters',()=>{
 const root=resolve(import.meta.dirname,'..');
 const result=spawnSync(process.execPath,[join(root,'scripts','theo-direct-daemon-entry.mjs'),'--workspace','/private/tmp'],{
  cwd:root,encoding:'utf8',timeout:7000,maxBuffer:4096,stdio:['ignore','pipe','pipe']
 });
 assert.equal(result.status,78);
 assert.match(result.stderr,/DIRECT_HOST_ARGUMENTS_DENIED/);
});

// Regression for v0.1.6's signed DIRECT LaunchAgent EX_CONFIG / INVALID_DURATION.
test('native DIRECT entry config respects shared 60-second limit without reducing direct Codex turn budget',()=>{
 const root=resolve(import.meta.dirname,'..');
 const entry=readFileSync(join(root,'scripts/theo-direct-daemon-entry.mjs'),'utf8');
 const shared=readFileSync(join(root,'src/task-coordinator.mjs'),'utf8');
 const direct=readFileSync(join(root,'src/direct-native-factory.mjs'),'utf8');
 assert.match(shared,/maxDurationMs\s*>\s*60000/);
 assert.match(entry,/startTaskDaemon\(\{\s*root,maxDurationMs:60000,/);
 assert.doesNotMatch(entry,/startTaskDaemon\(\{\s*root,maxDurationMs:300000,/);
 assert.match(direct,/maxDurationMs=300000/);
});
