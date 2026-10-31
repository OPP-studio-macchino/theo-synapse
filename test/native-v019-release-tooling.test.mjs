import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
const compile=path=>{
 const x=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1],encoding="utf8").read(),sys.argv[1],"exec")',path],{cwd:root,encoding:'utf8'});
 assert.equal(x.status,0,x.stderr);
};
test('v0.1.9 Mac builder is private-only and contains exact action approval source',()=>{
 const s=read('scripts/build-native-app-v019.py');
 assert.match(s,/APP_VERSION="0\.1\.9"/);
 assert.match(s,/CFBundleVersion':'12'/);
 assert.match(s,/src\/direct-action-review\.mjs/);
 assert.match(s,/BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE/);
 assert.match(s,/PORTABLE_SOURCE_HASH_MISMATCH/);
 assert.match(s,/existingAppModified':False/);
 assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.1\.9 · Core 0\.0\.5/);
 compile('scripts/build-native-app-v019.py');
});
test('v0.1.9 upgrade is exact 0.1.8-to-0.1.9 owner-reviewed, rollback-safe',()=>{
 const s=read('scripts/upgrade-native-installed-v019.py');
 for(const v of ['CURRENT_APP_VERSION_UNEXPECTED','CANDIDATE_VERSION_UNEXPECTED','OWNER_REVIEW_FINGERPRINT_MISMATCH',
 'DIRECT_HOST_ACTIVE_UPGRADE_DENIED','ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED','STABLE_PRIVATE_STATE_CHANGED_AFTER_RESTART',
 'PASS_INSTALLED_V019','FAIL_ROLLED_BACK','UNKNOWN_MANUAL_RECOVERY_REQUIRED',
 'src/direct-action-review.mjs','sourceManifestSHA256','directHistoricalRecordsSHA256','legacyTunnelModified'])assert.ok(s.includes(v),v);
 assert.match(s,/get\('CFBundleShortVersionString'\)=='0\.1\.8'/);
 assert.match(s,/get\('CFBundleShortVersionString'\)=='0\.1\.9'/);
 assert.match(s,/state\.get\('appVersion'\)=='0\.1\.8'/);
 assert.match(s,/get\('CFBundleVersion'\)=='12'/);
 assert.match(s,/modelTurnStarted':False/);
 assert.doesNotMatch(s,/report\['error'\]=str\(e\)/);
 compile('scripts/upgrade-native-installed-v019.py');
});
test('native direct action approval is physical, one-time, fail-closed with no automatic grant',()=>{
 const native=read('src/direct-native-factory.mjs');
 const adapter=read('src/codex-adapter.mjs');
 const owner=read('src/direct-owner-approval.mjs');
 const review=read('src/direct-action-review.mjs');
 assert.match(native,/ownerActionApproval=requestDirectActionApproval/);
 assert.match(adapter,/this\.ownerActionApproval\(review,\{signal:this\.actionAbort\.signal\}\)/);
 assert.match(adapter,/result:\{decision:'accept'\}/);
 assert.ok(!adapter.includes("result:{decision:'acceptForSession'}"));
 assert.match(owner,/default button "拒否する" cancel button "拒否する"/);
 assert.match(owner,/giving up after 30/);
 assert.match(review,/networkApprovalContext!==undefined/);
 assert.match(review,/additionalPermissions!==undefined/);
 assert.match(review,/!isInside\(root,full\)/);
});
