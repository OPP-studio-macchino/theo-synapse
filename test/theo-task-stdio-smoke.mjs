import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolve} from 'node:path';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';
const c=new Client({name:'theo-production-stdio-smoke',version:'1'});
const t=new StdioClientTransport({command:process.execPath,
 args:[resolve('scripts/theo-task-entry.mjs')],cwd:process.cwd(),
 env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin'}});
try{
 await c.connect(t);
 const names=(await c.listTools()).tools.map(x=>x.name).sort();
 if(names.length!==8||!names.includes('standalone_task_start')||!names.includes('standalone_task_events')||
   !names.includes('standalone_task_result'))throw Error('INCOMPLETE_TASK_MCP_SURFACE');
 const cap=await c.callTool({name:'standalone_capabilities',arguments:{}});
 const flags=JSON.parse(cap.content[0].text);
 if(!flags.taskStartEnabled||!flags.realCodexTaskEnabled||flags.writeEnabled||flags.candidateWriteEnabled)
   throw Error('TASK_MCP_CAPABILITY_MISMATCH');
 const p=await c.callTool({name:'standalone_list_projects',arguments:{}});
 if(p.isError)throw Error('PROJECT_DISCOVERY_FAILED');
 const projects=JSON.parse(p.content[0].text);
 const expected=Object.keys(loadReadOnlyRegistry(process.cwd()).projects).sort();
 if(!expected.includes('theo-lab')||JSON.stringify(projects.map(x=>x.id).sort())!==JSON.stringify(expected))
   throw Error('PROJECT_ALLOWLIST_MISMATCH');
 console.log(JSON.stringify({status:'PASS',version:flags.version,tools:names,
  projects:projects.map(x=>x.id),writeEnabled:false,modelTurnStarted:false}));
}finally{await c.close();}
