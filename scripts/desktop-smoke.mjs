// Actual installed stdio MCP smoke, no Codex turn and no autostart of the daemon.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {TaskBridge} from '../src/task-bridge.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const bridge=new TaskBridge({root,autostart:false,timeout:2000});
const ping=await bridge.ping();
if(!ping.alive||!['read_only','direct'].includes(ping.mode))throw Error('INSTALLED_DAEMON_NOT_READY');
const c=new Client({name:'theo-desktop-acceptance',version:'0.1.0'});
const t=new StdioClientTransport({command:process.execPath,args:[resolve(root,'scripts/theo-task-entry.mjs')],cwd:root,env:{HOME:process.env.HOME,PATH:process.env.PATH}});
try{
 await c.connect(t);
 const names=(await c.listTools()).tools.map(t=>t.name).sort();
 const expected=(ping.mode==='direct'?
  ['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop','codex_turn_start','codex_turn_wait']:
  ['standalone_capabilities','standalone_codex_probe','standalone_list_projects','standalone_task_events','standalone_task_result','standalone_task_start','standalone_task_status','standalone_task_stop']).sort();
 if(JSON.stringify(names)!==JSON.stringify(expected))throw Error('UNEXPECTED_DESKTOP_MCP_TOOLS');
 const flags=await c.callTool({name:'standalone_capabilities',arguments:{}});
 const v=JSON.parse(flags.content[0].text);
 if(flags.isError||v.writeEnabled||v.candidateWriteEnabled||v.directEnabled!==(ping.mode==='direct'))throw Error('UNEXPECTED_DESKTOP_CAPABILITIES');
 const p=await c.callTool({name:'standalone_list_projects',arguments:{}});
 const ids=JSON.parse(p.content[0].text).map(x=>x.id);
 if(p.isError||!ids.includes('theo-lab'))throw Error('DESKTOP_PROJECT_SCOPE');
 console.log(JSON.stringify({verdict:'PASS',transport:'actual-stdio',mode:ping.mode,toolCount:names.length,projects:ids,directEnabled:ping.mode==='direct',writeEnabled:false,modelTurnStarted:false}));
}finally{await c.close();}
