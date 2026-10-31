// One authorized, read-only real-Codex E2E through the NORMAL MCP task surface.
// This script is deliberately NOT included in npm test, because it consumes model quota.
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync,readdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

const root=resolve('.');
const demo=join(root,'.local/theo-runtime/projects/theo-lab');
const lab=join(demo,'INPUT.md');
const report=join(root,'.local/evidence/phase2-task-tools/real-codex-task-tools.json');
const before=readdirSync(demo).sort();
const input=readFileSync(lab);
const digest=createHash('sha256').update(input).digest('hex');
const expected='THEO_LAB_20261027';
const taskId='theo-codex-real-20261027-01';
async function client(){
 const c=new Client({name:'theo-real-task-acceptance',version:'1'});
 const t=new StdioClientTransport({command:process.execPath,args:[resolve('scripts/theo-task-entry.mjs')],
   cwd:root,env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin'}});
 await c.connect(t);
 return c;
}
async function invoke(c,name,args={}){
 const r=await c.callTool({name:'standalone_'+name,arguments:args});
 const value=JSON.parse(r.content[0].text);
 if(r.isError)throw Error('MCP_'+name+'_FAILED:'+value.error);
 return value;
}
let initial=null,last=null,ev=[],final=null,verification=null;
const began=new Date().toISOString();
const prompt='Inspect only INPUT.md in this directory, using actual file contents, and report the exact Verification label plus the sum of all Values in the file. Reply in two short lines: LABEL=<label> and SUM=<sum>. Do not modify or create files; do not use the network, Git, or read any other path. If unable to read the file, say so. Never guess the label.';
try{
 const a=await client();
 try{
  const projects=await invoke(a,'list_projects');
  if(projects.length!==1||projects[0].id!=='theo-lab')throw Error('UNEXPECTED_ALLOWLIST');
  initial=await invoke(a,'task_start',{id:taskId,projectId:'theo-lab',prompt,mode:'read_only'});
  console.log('REAL_MCP_TASK_STARTED',JSON.stringify({id:initial.id,created:initial.created,projectId:'theo-lab',state:initial.state}));
 }finally{await a.close();}
 const b=await client();
 try{
  const deadline=Date.now()+71000;
  let lastCursor=0;
  while(Date.now()<deadline){
   last=await invoke(b,'task_status',{id:taskId});
   const page=await invoke(b,'task_events',{id:taskId,after:lastCursor});
   if(page.length){
    ev.push(...page);lastCursor=page.at(-1).seq;
   }
   if(['COMPLETED','FAILED','STOPPED','UNKNOWN'].includes(last.state))break;
   await pause(350);
  }
  final=await invoke(b,'task_result',{id:taskId});
 }finally{await b.close();}
 verification={
  realModelAccepted:Boolean(initial?.created),
  providerFinished:final?.providerFinished===true,
  completed:last?.state==='COMPLETED',
  labelMatched:final?.output?.includes(expected)===true,
  sumMatched:/SUM\s*=\s*42\b/.test(final?.output??''),
  hasProgress:ev.some(x=>['agent_delta','agent_message','command_report'].includes(x.kind)),
  fileHashUnchanged:digest===createHash('sha256').update(readFileSync(lab)).digest('hex'),
  directoryUnchanged:JSON.stringify(before)===JSON.stringify(readdirSync(demo).sort())
 };
 const okay=Object.values(verification).every(Boolean);
 console.log('REAL_TASK_TOOL_E2E',JSON.stringify({pass:okay,state:last?.state,progressCount:ev.length,
   progressKinds:[...new Set(ev.map(x=>x.kind))],verification}));
 if(!okay)process.exitCode=1;
}catch(e){
 verification={error:String(e.message).slice(0,250)};
 console.log('REAL_TASK_TOOL_E2E',JSON.stringify({pass:false,verification}));
 process.exitCode=1;
}finally{
 const summary={timeStarted:began,timeFinished:new Date().toISOString(),taskId,
  actualCodexTaskAttempted:true,created:initial?.created??null,state:last?.state??null,
  progressKinds:[...new Set(ev.map(x=>x.kind))],progressCount:ev.length,
  providerFinished:final?.providerFinished??false,result:final?.output?.slice(0,4096)??null,verification,
  projectPath:demo,readOnly:true};
 writeFileSync(report,JSON.stringify(summary,null,2)+'\n',{mode:0o600,flag:'wx'});
}
