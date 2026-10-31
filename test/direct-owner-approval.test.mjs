import {test} from 'node:test';
import assert from 'node:assert/strict';
import {directWriteApprovalScript,directRegistrationApprovalScript} from '../src/direct-owner-approval.mjs';

test('real-workspace dialogs are deny-by-default and task-scoped',()=>{
 const write=directWriteApprovalScript({taskId:'factory-write-0001',workspaceId:'real-project',workspaceRoot:'/private/tmp/real-source',instructionDigest:'a'.repeat(64)});
 assert.match(write,/real-project/);assert.match(write,/factory-write-0001/);assert.match(write,/aaaaaaaaaaaaaaaaaaaa/);assert.match(write,/default button "拒否する" cancel button "拒否する"/);assert.match(write,/giving up after 30/);assert.doesNotMatch(write,/do shell script/);
 const registration=directRegistrationApprovalScript({id:'real-project',source:'/private/tmp/real-source',fingerprint:'b'.repeat(64)});
 assert.match(registration,/登録を許可/);assert.match(registration,/default button "許可しない" cancel button "許可しない"/);assert.match(registration,/giving up after 90/);
});
