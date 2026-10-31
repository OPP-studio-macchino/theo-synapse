import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const read=path=>readFileSync(resolve(root,path),'utf8');

test('v0.1.2 builder has an isolated owner-private candidate path and packaging guards',()=>{
 const source=read('scripts/build-native-app-v012.py');
 assert.match(source,/APP_VERSION = "0\.1\.2"/);
 assert.match(source,/CFBundleVersion":"4"/);
 assert.match(source,/native-macos-20261029" \/ "native-build/);
 assert.match(source,/AppIcon\.icns/);
 assert.match(source,/credentialIncluded":False/);
 assert.match(source,/native-core\.mjs/);
 assert.match(source,/mcp-schema-parity-smoke\.mjs/);
});

test('v0.1.2 upgrade requires an explicit signed candidate digest and preserves native state by rename',()=>{
 const source=read('scripts/upgrade-native-installed-v012.py');
 assert.match(source,/def candidate_plan\(raw_candidate,expected_candidate_sha\)/);
 assert.match(source,/CANDIDATE_PATH_NOT_ABSOLUTE/);
 assert.match(source,/CANDIDATE_SHA256_MISMATCH/);
 assert.match(source,/CURRENT_APP_VERSION_UNEXPECTED/);
 assert.match(source,/FORBIDDEN_NATIVE_PROJECT_REGISTERED/);
 assert.match(source,/PRIVATE_NATIVE_STATE_PRESERVED_BY_RENAME/);
 assert.match(source,/\(backup_core\/"\.local"\)\.rename\(stage_core\/"\.local"\)/);
 assert.doesNotMatch(source,/copytree\(CORE\/"\.local"/);
 assert.match(source,/verify_signed\(candidate\)/);
 assert.match(source,/stapler","validate"/);
 assert.match(source,/spctl","--assess"/);
});
