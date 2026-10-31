import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const read=name=>readFileSync(resolve(root,name),'utf8');
const py=path=>spawnSync('python3',['-c','import sys;compile(open(sys.argv[1],encoding="utf8").read(),sys.argv[1],"exec")',path],{cwd:root,encoding:'utf8'});

test('v0.1.8 release builder bundles no runtime or secrets and advances native version',()=>{
 const s=read('scripts/build-native-app-v018.py');
 assert.match(s,/APP_VERSION="0\.1\.8"/);
 assert.match(s,/CFBundleVersion':'11'/);
 assert.match(s,/BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE/);
 assert.match(s,/PORTABLE_SOURCE_HASH_MISMATCH/);
 assert.match(s,/existingAppModified':False/);
 assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.1\.9 · Core 0\.0\.5/);
 assert.equal(py('scripts/build-native-app-v018.py').status,0);
});

test('v0.1.8 upgrade requires exact signed 0.1.7->0.1.8, preserves private history, rolls back',()=>{
 const s=read('scripts/upgrade-native-installed-v018.py');
 for(const x of ['0.1.7','0.1.8','PASS_INSTALLED_V018','FAIL_ROLLED_BACK','UNKNOWN_MANUAL_RECOVERY_REQUIRED',
  'OWNER_REVIEW_FINGERPRINT_MISMATCH','DIRECT_HOST_ACTIVE_UPGRADE_DENIED',
  'ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED','STABLE_PRIVATE_STATE_CHANGED_AFTER_RESTART',
  'directHistoricalRecordsSHA256','sourceManifestSHA256','candidateManifestSHA256',
  'UNRECOGNIZED_LAUNCHAGENT','ROLLBACK_RUNTIME_MISSING'])assert.ok(s.includes(x),x);
 assert.match(s,/get\('CFBundleVersion'\)=='11'/);
 assert.match(s,/state\.get\('appVersion'\)=='0\.1\.7'/);
 assert.match(s,/get\('CFBundleShortVersionString'\)=='0\.1\.8'/);
 assert.match(s,/legacyTunnelModified':False/);
 assert.match(s,/modelTurnStarted':False/);
 assert.equal(py('scripts/upgrade-native-installed-v018.py').status,0);
});

test('new direct diagnostics never persist raw Codex error text or weaken Owner approval',()=>{
 const d=read('src/direct-coordinator.mjs');
 const c=read('src/codex-adapter.mjs');
 assert.match(d,/APPROVAL_REQUEST_DENIED/);
 assert.match(d,/CODEX_RPC_THREAD_START_REJECTED/);
 assert.match(d,/CODEX_RPC_TURN_START_REJECTED/);
 assert.match(d,/CODEX_TURN_INTERRUPTED/);
 assert.match(d,/diagnosisCodes\.has\(code\)\?code:'DIRECT_EXECUTION_UNVERIFIED'/);
 assert.match(d,/ownerAuthorization/);
 assert.match(c,/approvalPolicy:'on-request'/);
 assert.match(c,/approvalsReviewer:'user'/);
 assert.match(c,/networkAccess:false,writableRoots:\[\],excludeTmpdirEnvVar:true,excludeSlashTmp:true/);
 assert.match(c,/message:'Owner approval unavailable; denied'/);
 assert.doesNotMatch(c,/p\.reject\(Error\(msg\.error\.message\)\)/);
});
