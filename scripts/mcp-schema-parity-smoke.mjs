// Read-only, local-only comparison for an Owner-authorized cutover check.
// It does not call tools, start a model turn, start a daemon, or write config.
import {realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
import {FORBIDDEN_NATIVE_PROJECT_ID} from '../src/native-core.mjs';

const expectedNames=[
 'standalone_capabilities','standalone_codex_probe','standalone_list_projects',
 'standalone_task_events','standalone_task_result','standalone_task_start',
 'standalone_task_status','standalone_task_stop'
];
const fail=code=>{throw Error(code);};
const safeRoot=value=>{
 if(typeof value!=='string'||!value.startsWith('/'))fail('PARITY_ROOT_INVALID');
 try {return realpathSync.native(resolve(value));}catch {fail('PARITY_ROOT_INVALID');}
};
const normalized=tools=>tools.map(tool=>({name:tool.name,inputSchema:tool.inputSchema})).sort((a,b)=>a.name.localeCompare(b.name,'en'));

export function assessParity({legacyTools,nativeTools,nativeProjects}){
 const legacy=normalized(legacyTools),native=normalized(nativeTools);
 if(legacy.length!==8||native.length!==8)fail('PARITY_TOOL_COUNT');
 if(JSON.stringify(legacy.map(x=>x.name))!==JSON.stringify(expectedNames)||
    JSON.stringify(native.map(x=>x.name))!==JSON.stringify(expectedNames))fail('PARITY_TOOL_NAME_MISMATCH');
 if(JSON.stringify(legacy)!==JSON.stringify(native))fail('PARITY_TOOL_SCHEMA_MISMATCH');
 if(nativeProjects.includes(FORBIDDEN_NATIVE_PROJECT_ID))fail('PARITY_NATIVE_FORBIDDEN_PROJECT');
 return {verdict:'PASS',code:'PARITY_OK',toolCount:8,nativeProjects:[...nativeProjects].sort(),modelTurnStarted:false,configModified:false};
}

async function listTools(root,label){
 const client=new Client({name:'theo-schema-parity-'+label,version:'0.0.5'});
 const transport=new StdioClientTransport({
  command:process.execPath,args:[join(root,'scripts/theo-task-entry.mjs')],cwd:root,
  env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin',THEO_SCHEMA_PROBE:'1'}
 });
 try {await client.connect(transport);return (await client.listTools()).tools;}
 catch {fail('PARITY_MCP_LAUNCH_FAILED');}
 finally {try{await client.close();}catch{}}
}

async function main(){
 const [legacyArg,nativeArg]=process.argv.slice(2);
 if(!legacyArg||!nativeArg||process.argv.length!==4)fail('PARITY_USAGE');
 const legacyRoot=safeRoot(legacyArg),nativeRoot=safeRoot(nativeArg);
 const nativeProjects=Object.keys(loadReadOnlyRegistry(nativeRoot).projects);
 const [legacyTools,nativeTools]=await Promise.all([listTools(legacyRoot,'legacy'),listTools(nativeRoot,'native')]);
 return assessParity({legacyTools,nativeTools,nativeProjects});
}

if(import.meta.url===new URL('file://'+process.argv[1]).href){
 try{console.log(JSON.stringify(await main()));}
 catch(error){const code=/^PARITY_[A-Z_]{2,80}$/.test(error?.message??'')?error.message:'PARITY_FAILED';console.log(JSON.stringify({verdict:'FAIL',code,modelTurnStarted:false,configModified:false}));process.exitCode=1;}
}
