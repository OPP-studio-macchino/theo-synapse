import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),read=p=>readFileSync(resolve(root,p),'utf8');
test('v0.1.6 native direct management is opt-in, exact-owned, and never an MCP setup command',()=>{
 const host=read('macos/DesktopHost.swift'),ui=read('macos/TheoSynapse.swift'),daemon=read('src/task-daemon.mjs'),inspect=read('scripts/desktop-inspect.mjs');
 assert.match(host,/tech\.oppstudio\.theosynapse\.desktop\.direct/);assert.match(host,/scripts\/theo-direct-daemon-entry\.mjs/);assert.match(host,/ownedAgent\(/);assert.match(host,/管理外または別モードのプロセスは停止できません/);assert.match(host,/directActiveRuns/);assert.match(host,/directWorkspaces/);assert.doesNotMatch(host,/case "direct-start"/);assert.doesNotMatch(host,/case "direct-restart"/);
 assert.match(ui,/DIRECT\(10\)/);assert.match(ui,/READONLY\(8\)/);assert.match(ui,/UNMANAGED\/UNKNOWN/);assert.match(ui,/NSAlert/);assert.match(ui,/asyncAfter\(deadline:\.now\(\)\+30/);assert.match(ui,/let timeout=DispatchWorkItem \{window\.endSheet\(alert\.window,returnCode:\.alertFirstButtonReturn\)\}/);assert.match(ui,/addButton\(withTitle:"許可しない"\).*addButton\(withTitle:"起動を許可"\)/s);assert.match(ui,/guard response == \.alertSecondButtonReturn else/);assert.match(host,/expiresAt-plan.createdAt==300000/);
 assert.match(daemon,/mode:directEnabled\(\)\?'direct':'read_only'/);assert.match(inspect,/directWorkspaces/);assert.match(inspect,/directActiveRuns/);
});
test('v0.1.6 candidate builder is source-private and compiles without touching installed software',()=>{
 const source=read('scripts/build-native-app-v016.py');assert.match(source,/APP_VERSION="0\.1\.6"/);assert.match(source,/CFBundleVersion':'8'/);assert.match(source,/existingAppModified':False/);assert.match(source,/theo-direct-daemon-entry\.mjs/);assert.match(source,/desktop-inspect\.mjs/);assert.match(source,/PRIVATE_BUILD\.is_dir/);assert.doesNotMatch(source,/PRIVATE_BUILD\.mkdir/);
 const r=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")','scripts/build-native-app-v016.py'],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(read('macos/TheoSynapse.swift'),/Macアプリ 0\.1\.9 · Core 0\.0\.5/);
});
test('v0.1.6 upgrade tooling is an owner-reviewed 0.1.5 to 0.1.6 fail-closed transition',()=>{
 const source=read('scripts/upgrade-native-installed-v016.py');
 assert.match(source,/CURRENT_APP_VERSION_UNEXPECTED/);assert.match(source,/0\.1\.5/);assert.match(source,/0\.1\.6/);assert.match(source,/CFBundleVersion'\)==?'8'/);
 assert.match(source,/OWNER_REVIEW_FINGERPRINT_MISMATCH/);assert.match(source,/DIRECT_HOST_ACTIVE_UPGRADE_DENIED/);assert.match(source,/ACTIVE_DIRECT_OR_WRITE_TASKS_UPGRADE_DENIED/);assert.match(source,/ORIGINAL_READONLY_LAUNCHAGENT_NOT_RUNNING/);assert.match(source,/UNRECOGNIZED_LAUNCHAGENT/);
 assert.match(source,/codesign','--verify','--deep','--strict/);assert.match(source,/stapler','validate/);assert.match(source,/PRIVATE_RUNTIME_CHANGED/);assert.match(source,/PASS_INSTALLED_V016/);assert.match(source,/FAIL_ROLLED_BACK/);assert.match(source,/UNKNOWN_MANUAL_RECOVERY_REQUIRED/);assert.match(source,/directHostTouched':False/);
 assert.match(source,/STAGED_CORE_PERMISSIONS_INVALID/);assert.match(source,/p\.chmod\(0o700 if p\.is_dir\(\) else 0o600\)/);assert.match(source,/private_tree\(stage_core\)/);assert.match(source,/st_nlink==1/);
 assert.match(source,/app_swapped=core_swapped=runtime_moved=False/);assert.match(source,/ROLLBACK_RUNTIME_MISSING/);assert.match(source,/ORIGINAL_RESTORED/);assert.match(source,/restored\.get\('launchAgentLoaded'\) is True/);
 assert.match(source,/candidateManifestSHA256/);assert.match(source,/sourceManifestSHA256/);assert.match(source,/INSTALLED_MANIFEST_CHANGED/);assert.match(source,/STABLE_PRIVATE_STATE_CHANGED_AFTER_RESTART/);assert.match(source,/directHistoricalRecordsSHA256/);assert.match(source,/directRegistrySHA256/);
 assert.match(source,/owned_dir\(AUDIT\)/);assert.match(source,/p\.chmod\(0o600\)/);assert.match(source,/code_for\(e\)/);assert.doesNotMatch(source,/report\['error'\]=str\(e\)/);
 assert.match(source,/readonly_launchagent\(state\)/);assert.match(source,/task-daemon-entry\.mjs/);assert.match(source,/state\.get\('serviceLabel'\)==READONLY/);assert.doesNotMatch(source,/state\.get\('hostState'\)=='READONLY\(8\)'/);
 const r=spawnSync('python3',['-c','import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")','scripts/upgrade-native-installed-v016.py'],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
