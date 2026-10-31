import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessParity} from '../scripts/mcp-schema-parity-smoke.mjs';

const names=['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop'];
const tools=names.map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:false}}));

test('schema parity accepts eight matching tools and a native registry without chappy-signal',()=>{
 const result=assessParity({legacyTools:tools,nativeTools:[...tools].reverse(),nativeProjects:['theo-lab']});
 assert.equal(result.verdict,'PASS');assert.equal(result.toolCount,8);assert.equal(result.modelTurnStarted,false);
});
test('schema parity has explicit failure codes',()=>{
 assert.throws(()=>assessParity({legacyTools:tools,nativeTools:tools,nativeProjects:['chappy-signal']}),/PARITY_NATIVE_FORBIDDEN_PROJECT/);
 assert.throws(()=>assessParity({legacyTools:tools,nativeTools:tools.slice(1),nativeProjects:['theo-lab']}),/PARITY_TOOL_COUNT/);
 const changed=tools.map(x=>({...x,inputSchema:{...x.inputSchema,title:x.name}}));
 assert.throws(()=>assessParity({legacyTools:tools,nativeTools:changed,nativeProjects:['theo-lab']}),/PARITY_TOOL_SCHEMA_MISMATCH/);
});
