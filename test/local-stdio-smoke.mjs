// Local-only smoke: actual MCP stdio process + actual Codex App Server initialize. NO model turn.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {resolve} from 'node:path';
const client=new Client({name:'opp-local-smoke',version:'1'});
const transport=new StdioClientTransport({
 command:process.execPath,args:[resolve('src/mcp.mjs')],cwd:process.cwd(),
 env:{HOME:process.env.HOME,PATH:process.env.PATH,STANDALONE_CODEX_PATH:'/Users/THEO_PUBLIC_EXAMPLE/.local/bin/codex'}
});
try{
 await client.connect(transport);
 const tools=await client.listTools();
 const names=tools.tools.map(t=>t.name).sort();
 if(JSON.stringify(names)!==JSON.stringify(['standalone_capabilities','standalone_codex_probe']))
  throw Error('UNEXPECTED_MCP_TOOLS:'+names.join(','));
 const p=await client.callTool({name:'standalone_codex_probe',arguments:{}});
 const probe=JSON.parse(p.content[0].text);
 if(p.isError||probe.connected!==true)throw Error('CODEX_PROBE_FAILED');
 const c=await client.callTool({name:'standalone_capabilities',arguments:{}});
 const cap=JSON.parse(c.content[0].text);
 if(cap.realCodexTaskEnabled||cap.writeEnabled)throw Error('UNEXPECTED_EXECUTION_EXPOSURE');
 console.log(JSON.stringify({mcpStdio:true,tools:names,realCodexInitialize:true,
  realCodexTaskExecuted:false,writeEnabled:false}));
}finally{await client.close();}
