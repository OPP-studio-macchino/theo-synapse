// Single authorized real Codex read-only E2E. Creates only a new isolated fixture and evidence.
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readdirSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CodexAppServer} from '../src/codex-adapter.mjs';
import {TaskStore} from '../src/task-store.mjs';
import {TaskCoordinator} from '../src/task-coordinator.mjs';
import {makeServer} from '../src/mcp.mjs';

const root=realpathSync.native(resolve('.'));
const evidenceParent=join(root,'.local','evidence');
const runDir=mkdtempSync(join(evidenceParent,'real-codex-readonly-'));
const fixture=join(runDir,'fixture-project');
mkdirSync(fixture,{mode:0o700});
const code='OPP_READONLY_'+randomBytes(6).toString('hex').toUpperCase();
const fixtureBody=`# Isolated fixture for Codex read-only E2E
Validation code: ${code}
Values: 6, 14, 22
Expected operation: inspect the file and compute the sum. Do not modify anything.
`;
writeFileSync(join(fixture,'INPUT.md'),fixtureBody,{flag:'wx',mode:0o600});

function manifest(dir){
 const out=[];
 function walk(p){
  for(const entry of readdirSync(p,{withFileTypes:true})){
   const child=join(p,entry.name),st=lstatSync(child);
   const rel=relative(dir,child);
   if(st.isSymbolicLink())throw Error('SYMLINK_IN_FIXTURE');
   if(st.isDirectory()){out.push({path:rel,type:'directory'});walk(child);}
   else if(st.isFile())out.push({path:rel,type:'file',sha256:createHash('sha256').update(readFileSync(child)).digest('hex'),bytes:st.size});
   else out.push({path:rel,type:'other'});
  }
 }
 walk(dir);
 return out.sort((a,b)=>a.path.localeCompare(b.path));
}
const before=manifest(fixture);
const store=new TaskStore(join(runDir,'journal.sqlite'));
const coordinator=new TaskCoordinator({
 projects:{only_test_fixture:fixture},
 store,maxDurationMs:60000,
 adapterFactory:()=>new CodexAppServer('/Users/THEO_PUBLIC_EXAMPLE/.local/bin/codex',fixture,{
  turnEffort:'low',rpcTimeoutMs:8000
 })
});
const server=makeServer({codexPath:'/Users/THEO_PUBLIC_EXAMPLE/.local/bin/codex',workspace:fixture,
 fixtureCoordinator:coordinator,internalRealCodexE2E:true});
const client=new Client({name:'opp-real-codex-readonly-e2e',version:'1'});
const [serverTransport,clientTransport]=InMemoryTransport.createLinkedPair();
let connected=false,start=null,lastStatus=null,result=null,events=[],problems=[],lastCursor=0;
const startedAt=new Date().toISOString();
function record(){
 const after=manifest(fixture);
 const progressKinds=[...new Set(events.map(x=>x.kind).filter(x=>!['QUEUED','RUNNING','COMPLETED','FAILED','STOP_REQUESTED','STOPPED','UNKNOWN'].includes(x)))];
 const text=result?.output??'';
 const succeeded=lastStatus?.state==='COMPLETED'&&result?.providerFinished===true&&
  text.includes(code)&&/\b42\b/.test(text)&&progressKinds.length>0&&JSON.stringify(before)===JSON.stringify(after);
 const report={
  test:'ONE_REAL_CODEX_READONLY_E2E',dateJst:new Date().toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}),
  startedAt,finishedAt:new Date().toISOString(),realModelTurnAttempted:true,
  transport:'MCP InMemoryTransport -> Standalone Coordinator -> actual Codex App Server stdio',
  codexCli:'/Users/THEO_PUBLIC_EXAMPLE/.local/bin/codex',executionMode:'read_only',modelSelection:'Codex local default',effort:'low',
  ephemeralThread:true,projectRoot:fixture,taskId:start?.id??null,
  state:lastStatus?.state??null,providerFinished:result?.providerFinished??false,
  independentVerification:{codeReadFromFixture:text.includes(code),mathCorrect:/\b42\b/.test(text),
   progressEvents:progressKinds.length,progressKinds,
   fixtureUnmodified:JSON.stringify(before)===JSON.stringify(after),modelCompleted:lastStatus?.state==='COMPLETED'},
  initialManifest:before,finalManifest:after,
  statusEvents:events.map(({seq,at,kind,text})=>({seq,at,kind,text:text.slice(0,300)})),
  providerResult:result?.output?.slice(0,4096)??null,
  acceptanceFlags:result?{testsVerified:result.testsVerified,artifactsVerified:result.artifactsVerified,
    requirementsMet:result.requirementsMet,ownerAccepted:result.ownerAccepted,userReported:result.userReported}:null,
  problems,pass:Boolean(succeeded)
 };
 writeFileSync(join(runDir,'E2E_RESULT.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('FINAL_E2E_REPORT',JSON.stringify({
  runDir,pass:report.pass,state:report.state,providerFinished:report.providerFinished,
  progressKinds,codeReadFromFixture:report.independentVerification.codeReadFromFixture,
  mathCorrect:report.independentVerification.mathCorrect,fixtureUnmodified:report.independentVerification.fixtureUnmodified,
  issues:problems
 }));
 if(!succeeded)process.exitCode=1;
}
async function invoke(tool,args={}){
 const reply=await client.callTool({name:'standalone_'+tool,arguments:args});
 const raw=reply?.content?.[0]?.text??'';
 if(reply.isError)throw Error('MCP_TOOL_'+tool+': '+raw.slice(0,300));
 return JSON.parse(raw);
}
try {
 await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
 connected=true;
 const cap=await invoke('capabilities');
 if(!cap.realCodexTaskEnabled||cap.writeEnabled)throw Error('UNEXPECTED_CAPABILITIES');
 const projects=await invoke('list_projects');
 if(projects.length!==1||projects[0].id!=='only_test_fixture')throw Error('PROJECT_SCOPE_ERROR');
 const prompt='Only inspect INPUT.md in this working directory. Read its actual Validation code and Values; do not guess the code. Return one short final answer containing CODE=<the exact validation code> and SUM=<the arithmetic sum of the three Values>. Do not modify, create or delete files; do not install packages; do not use the network or Git; do not open files outside this directory. If a command is necessary, use only read-only inspection. Do not execute anything requiring elevated permissions.';
 start=await invoke('task_start',{id:'real-e2e-'+randomBytes(8).toString('hex'),projectId:'only_test_fixture',mode:'read_only',prompt});
 if(!start.created)throw Error('TASK_NOT_FRESH');
 console.log('REAL_CODEX_E2E_STARTED',JSON.stringify({runDir,taskId:start.id,fixture}));
 const until=Date.now()+68000;
 let previous='';
 while(Date.now()<until){
  lastStatus=await invoke('task_status',{id:start.id});
  const fresh=await invoke('task_events',{id:start.id,after:lastCursor});
  if(fresh.length){
   events.push(...fresh);lastCursor=fresh.at(-1).seq;
   for(const item of fresh){
    if(!['QUEUED','RUNNING'].includes(item.kind))
     console.log('E2E_EVENT',JSON.stringify({kind:item.kind,seq:item.seq}));
   }
  }
  if(previous!==lastStatus.state){
   console.log('E2E_STATE',lastStatus.state);
   previous=lastStatus.state;
  }
  if(['COMPLETED','FAILED','STOPPED','UNKNOWN'].includes(lastStatus.state))break;
  await delay(250);
 }
 result=await invoke('task_result',{id:start.id});
 if(!['COMPLETED','FAILED','STOPPED','UNKNOWN'].includes(lastStatus?.state??''))problems.push('NO_TERMINAL_WITHIN_RUNNER_DEADLINE');
}catch(e){
 problems.push(String(e?.message??e).slice(0,400));
 try{
  if(start?.id){lastStatus=await invoke('task_status',{id:start.id});result=await invoke('task_result',{id:start.id});
   const rest=await invoke('task_events',{id:start.id,after:lastCursor});events.push(...rest);}
 }catch(err){problems.push('REPORT_READ_ERROR:'+String(err.message).slice(0,200));}
}finally{
 try {if(connected)await client.close();}catch{}
 try {await server.close();}catch{}
 try {coordinator.close();}catch{}
 try {record();}catch(err){console.error('REPORT_WRITE_ERROR',String(err.message));process.exitCode=1;}
}
