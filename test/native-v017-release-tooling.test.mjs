import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=resolve(import.meta.dirname,'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
const compile=path=>{
 const r=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")',path],{cwd:root,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
};

test('v0.1.7 fixes real native DIRECT EX_CONFIG duration mismatch without changing direct turn budget',()=>{
 const entry=read('scripts/theo-direct-daemon-entry.mjs');
 const shared=read('src/task-coordinator.mjs');
 const direct=read('src/direct-native-factory.mjs');
 assert.match(entry,/startTaskDaemon\(\{\s*root,maxDurationMs:60000,/);
 assert.match(shared,/maxDurationMs>60000/);
 assert.match(direct,/maxDurationMs=300000/);
 assert.match(entry,/isNativeCoreRoot\(root\)/);
 assert.match(entry,/loadDirectWorkspaceRegistry/);
 assert.match(entry,/createOwnerApprovedDirectCoordinator/);
 assert.match(entry,/THEO_DIRECT_HOST_REFUSED/);
});

test('v0.1.7 candidate builder is private and advances Apple bundle number',()=>{
 const s=read('scripts/build-native-app-v017.py');
 assert.match(s,/APP_VERSION="0\.1\.7"/);
 assert.match(s,/CFBundleVersion':'10'/);
 assert.match(s,/existingAppModified':False/);
 assert.match(s,/BUNDLED_NATIVE_OR_SECRET_FILE_UNSAFE/);
 assert.match(s,/PORTABLE_SOURCE_HASH_MISMATCH/);
 assert.match(s,/PRIVATE_BUILD\.is_dir/);
 assert.doesNotMatch(s,/PRIVATE_BUILD\.mkdir/);
 assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.1\.9 · Core 0\.0\.5/);
 compile('scripts/build-native-app-v017.py');
});

test('v0.1.7 upgrade remains exact owner-reviewed 0.1.6-to-0.1.7 with rollback and preservation gates',()=>{
 const s=read('scripts/upgrade-native-installed-v017.py');
 assert.match(s,/CURRENT_APP_VERSION_UNEXPECTED/);
 assert.match(s,/get\('CFBundleShortVersionString'\)=='0\.1\.6'/);
 assert.match(s,/get\('CFBundleShortVersionString'\)=='0\.1\.7'/);
 assert.match(s,/get\('CFBundleVersion'\)=='10'/);
 assert.match(s,/OWNER_REVIEW_FINGERPRINT_MISMATCH/);
 assert.match(s,/DIRECT_HOST_ACTIVE_UPGRADE_DENIED/);
 assert.match(s,/ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED/);
 assert.match(s,/readonly_launchagent\(state\)/);
 assert.match(s,/codesign','--verify','--deep','--strict/);
 assert.match(s,/stapler','validate/);
 assert.match(s,/PASS_INSTALLED_V017/);
 assert.match(s,/FAIL_ROLLED_BACK/);
 assert.match(s,/UNKNOWN_MANUAL_RECOVERY_REQUIRED/);
 assert.match(s,/STAGED_CORE_PERMISSIONS_INVALID/);
 assert.match(s,/PRIVATE_RUNTIME_CHANGED/);
 assert.match(s,/STABLE_PRIVATE_STATE_CHANGED_AFTER_RESTART/);
 assert.match(s,/directHistoricalRecordsSHA256/);
 assert.match(s,/legacyTunnelModified':False/);
 assert.doesNotMatch(s,/report\['error'\]=str\(e\)/);
 compile('scripts/upgrade-native-installed-v017.py');
});

test('native Tunnel MCP never auto-spawns unmanaged readonly daemon while legacy behavior stays unchanged',()=>{
 const entry=read('scripts/theo-task-entry.mjs');
 const guard=read('src/native-core.mjs');
 const bridge=read('src/task-bridge.mjs');
 assert.match(entry,/import \{isNativeCoreRoot\} from '\.\.\/src\/native-core\.mjs'/);
 assert.match(entry,/autostart:!schemaProbe&&!isNativeCoreRoot\(root\)/);
 assert.match(entry,/const probe=new TaskBridge\(\{root,autostart:false/);
 assert.match(guard,/userInfo\(\)\.homedir/);
 assert.match(guard,/Library','Application Support','Theo Synapse','core/);
 assert.match(bridge,/constructor\(\{root,autostart=true/);
 assert.match(bridge,/if\(!this\.autostart\|\|!isMissing\(e\)\)throw e/);
});

test('v0.1.7 updater validates actual v0.1.6 READONLY(8) status without nonexistent serviceLabel',()=>{
 const python=[
  'import runpy',
  "m=runpy.run_path('scripts/upgrade-native-installed-v017.py',run_name='v017_test')",
  "f=m['readonly_managed']",
  "s={'appVersion':'0.1.6','hostState':'READONLY(8)','mode':'read_only','running':True,'launchAgentLoaded':True,'readonlyLaunchAgentLoaded':True,'directLaunchAgentLoaded':False,'readOnly':True,'writeEnabled':False,'activeTasks':0,'directActiveRuns':0}",
  "assert f(s), 'signed v0.1.6 READONLY status must pass'",
  "for key,bad in [('appVersion','0.1.7'),('hostState','UNMANAGED/UNKNOWN'),('mode','direct'),('running',False),('launchAgentLoaded',False),('readonlyLaunchAgentLoaded',False),('directLaunchAgentLoaded',True),('readOnly',False),('writeEnabled',True),('activeTasks',1),('directActiveRuns',1)]:",
  " t=dict(s);t[key]=bad;assert not f(t),key",
  "print('V017_NATIVE_READONLY_PREFLIGHT_PURE_FUNCTION_PASS')"
 ].join('\n');
 const r=spawnSync('python3',['-c',python],{cwd:root,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 assert.match(r.stdout,/V017_NATIVE_READONLY_PREFLIGHT_PURE_FUNCTION_PASS/);
 const s=read('scripts/upgrade-native-installed-v017.py');
 assert.match(s,/readonly_launchagent\(state\)/);
 assert.doesNotMatch(s,/state\.get\('serviceLabel'\)==READONLY/);
});
