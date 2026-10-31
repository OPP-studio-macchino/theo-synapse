import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const direct=['src/direct-coordinator.mjs','src/direct-native-factory.mjs','src/direct-workspace-registry.mjs','src/direct-owner-approval.mjs','scripts/theo-direct-workspaces.mjs','scripts/theo-direct-daemon-entry.mjs','scripts/theo-task-entry.mjs'];

test('v0.1.4 builder has a unique private staging area and keeps direct mode disabled',()=>{
 const source=read('scripts/build-native-app-v014.py');
 assert.match(source,/APP_VERSION="0\.1\.4"/); assert.match(source,/CORE_VERSION="0\.0\.5"/); assert.match(source,/CFBundleVersion":"6"/);
 assert.match(source,/uuid\.uuid4\(\)\.hex/); assert.match(source,/BUILD_PARENT_MISSING/); assert.match(source,/REQUIRED_DIRECT_SOURCE_MISSING/);
 assert.match(source,/ライブ書き込みとdirect modeは無効/); assert.doesNotMatch(source,/PRIVATE_BUILD\.mkdir/);
 for(const path of direct) assert.match(source,new RegExp(path.replaceAll('.','\\.')));
});

test('v0.1.4 is exactly the signed 0.1.3 to 0.1.4 rollback-capable read-only transition',()=>{
 const source=read('scripts/upgrade-native-installed-v014.py');
 assert.match(source,/bundle_meta\(INSTALLED\)\[1\]=="0\.1\.3"/); assert.match(source,/bundle_meta\(candidate\)\[1\]=="0\.1\.4"/); assert.doesNotMatch(source,/"0\.1\.2"/);
 assert.match(source,/OWNER_REVIEW_FINGERPRINT_MISMATCH/); assert.match(source,/codesign","--verify","--deep","--strict"/); assert.match(source,/Authority=Developer ID Application:/); assert.match(source,/stapler","validate"/); assert.match(source,/spctl","--assess","--type","execute"/);
 assert.match(source,/ABORT_FORWARDING="ownerAuthorization:\(context,options\)=>ownerApproval\(context,options\)"/); assert.match(source,/CORE_ABORT_SIGNAL_FORWARDING_MISSING/);
 assert.match(source,/activeTasks"\)==0/); assert.match(source,/readOnly"\) is True/); assert.match(source,/toolCount"\)==8/); assert.match(source,/writeEnabled"\) is False/);
 assert.match(source,/NEW_CORE_VERIFY_FAILED/); assert.doesNotMatch(source,/smoke\.get\("readOnly"\)/);
 assert.doesNotMatch(source,/native\("(?:start|smoke)",35\)/);
 assert.match(source,/native\("start",timeout=35\)/); assert.match(source,/native\("smoke",timeout=35\)/);
 assert.match(source,/backup-0\.1\.3/); assert.match(source,/\(backup_core\/"\.local"\)\.rename\(stage_core\/"\.local"\)/); assert.match(source,/FAIL_ROLLED_BACK/); assert.match(source,/ROLLBACK_RUNTIME_MISSING/); assert.match(source,/PASS_INSTALLED_V014/); assert.doesNotMatch(source,/copytree\(CORE\/"\.local"/);
});

test('v0.1.4 tooling compiles and the native caption matches',()=>{
 for(const path of ['scripts/build-native-app-v014.py','scripts/upgrade-native-installed-v014.py']){
  const result=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")',path],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
 assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.\d+\.\d+ · Core 0\.0\.5/);
});
