import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');
const direct=['src/direct-coordinator.mjs','src/direct-native-factory.mjs','src/direct-workspace-registry.mjs','src/direct-owner-approval.mjs','scripts/theo-direct-workspaces.mjs','scripts/theo-direct-daemon-entry.mjs','scripts/theo-task-entry.mjs'];

test('v0.1.5 builder is private, has the 0.1.5 bundle transition, and binds the diagnostic repair into its manifest',()=>{
 const source=read('scripts/build-native-app-v015.py');
 assert.match(source,/APP_VERSION="0\.1\.5"/);assert.match(source,/CORE_VERSION="0\.0\.5"/);assert.match(source,/CFBundleVersion":"7"/);
 assert.match(source,/uuid\.uuid4\(\)\.hex/);assert.match(source,/BUILD_PARENT_MISSING/);assert.doesNotMatch(source,/PRIVATE_BUILD\.mkdir/);
 assert.match(source,/DIRECT_DIAGNOSTIC_FIX_MISSING/);assert.match(source,/PORTABLE_SOURCE_HASH_MISMATCH/);assert.match(source,/ALTER TABLE direct_runs ADD COLUMN error_code TEXT/);assert.match(source,/providerFinished:\['COMPLETED','FAILED'\]\.includes\(r\.state\)/);
 assert.match(source,/既定は読み取り専用です/);assert.match(source,/恒久無効ではありません/);assert.match(source,/native Ownerの明示承認と公開済みツール・host認可が必要/);
 for(const path of direct)assert.match(source,new RegExp(path.replaceAll('.','\\.')));
});

test('v0.1.5 installer is exactly a signed 0.1.4 to 0.1.5, owner-reviewed, fail-closed transition',()=>{
 const source=read('scripts/upgrade-native-installed-v015.py');
 assert.match(source,/bundle_meta\(INSTALLED\)\[1\]=="0\.1\.4"/);assert.match(source,/bundle_meta\(candidate\)\[1\]=="0\.1\.5"/);assert.match(source,/CFBundleVersion\"\)==\"7\"/);
 assert.match(source,/OWNER_REVIEW_FINGERPRINT_MISMATCH/);assert.match(source,/codesign","--verify","--deep","--strict"/);assert.match(source,/Authority=Developer ID Application:/);assert.match(source,/stapler","validate"/);assert.match(source,/spctl","--assess","--type","execute"/);
 assert.match(source,/DIRECT_HOST_ACTIVE_UPGRADE_DENIED/);assert.match(source,/theo-direct-daemon-entry\.mjs/);assert.match(source,/ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED/);assert.match(source,/launchAgentLoaded"\) is True/);assert.match(source,/activeTasks"\)==0/);
 assert.match(source,/safe_preflight\(\)==facts\["privateRuntimeInventorySHA256"\]/);assert.match(source,/PRIVATE_RUNTIME_CHANGED_BEFORE_STOP/);
 assert.match(source,/CORE_DIRECT_DIAGNOSTIC_FIX_MISSING/);assert.match(source,/DIRECT_EXECUTION_UNVERIFIED/);assert.match(source,/NEW_MCP_SMOKE_FAILED/);assert.match(source,/toolCount"\)==8/);assert.match(source,/writeEnabled"\) is False/);
 assert.match(source,/\(backup_core\/"\.local"\)\.rename\(stage_core\/"\.local"\)/);assert.match(source,/PRIVATE_NATIVE_STATE_PRESERVED_BY_RENAME/);assert.match(source,/privateRuntimeInventorySHA256/);assert.doesNotMatch(source,/copytree\(CORE\/"\.local"/);
 assert.match(source,/readonlyRegistrySHA256/);assert.match(source,/NEW_READONLY_REGISTRY_CHANGED/);assert.match(source,/quiescent_runtime_sha=runtime_inventory\(CORE\/"\.local"\)/);assert.match(source,/runtime_inventory\(stage_core\/"\.local"\)==quiescent_runtime_sha/);assert.doesNotMatch(source,/NEW_PRIVATE_RUNTIME_CHANGED/);
 assert.match(source,/backup-0\.1\.4/);assert.match(source,/PASS_INSTALLED_V015/);assert.match(source,/FAIL_ROLLED_BACK/);assert.match(source,/native\("start",timeout=35\)/);assert.match(source,/native\("smoke",timeout=35\)/);assert.doesNotMatch(source,/native\("(?:start|smoke)",35\)/);
 assert.doesNotMatch(source,/p8|p12|Authorization: Bearer|OPENAI_API_KEY/);
});

test('v0.1.5 release tooling compiles and the native caption advances without changing Core compatibility',()=>{
 for(const path of ['scripts/build-native-app-v015.py','scripts/upgrade-native-installed-v015.py']){
  const result=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")',path],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
 }
 assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.\d+\.\d+ · Core 0\.0\.5/);
});
