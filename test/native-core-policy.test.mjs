import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FORBIDDEN_NATIVE_PROJECT_ID,assertNativeProjectAllowed,isNativeCoreRoot,nativeCorePath} from '../src/native-core.mjs';

const home='/private/tmp/theo-native-policy-home';
const native=nativeCorePath(home);

test('chappy-signal is denied only for the account-bound native Core root',()=>{
 assert.equal(isNativeCoreRoot(native,home),true);
 assert.throws(()=>assertNativeProjectAllowed(native,FORBIDDEN_NATIVE_PROJECT_ID,home),/FORBIDDEN_NATIVE_PROJECT/);
 assert.doesNotThrow(()=>assertNativeProjectAllowed('/private/tmp/legacy-standalone',FORBIDDEN_NATIVE_PROJECT_ID,home));
 assert.doesNotThrow(()=>assertNativeProjectAllowed(native,'theo-lab',home));
});
