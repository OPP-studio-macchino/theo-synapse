// One-command, model-free acceptance of Theo's currently supported read-only path.
// This is not a runtime permission switch, installer, or a write enablement tool.
import {spawnSync} from 'node:child_process';
import {
 readdirSync,statSync,writeFileSync,lstatSync,existsSync
} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.umask(0o077);
const evidence=join(root,'.local','evidence','phase2-task-tools');
const d=lstatSync(evidence);
if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==process.getuid()||
 (d.mode&0o077)!==0)throw Error('ACCEPTANCE_EVIDENCE_DIR_UNSAFE');

const stages=[
 {name:'source_syntax',args:[
  '--check','src/release-health.mjs'
 ]},
 {name:'all_synthetic_tests',args:[
  '--test',...readdirSync(join(root,'test')).filter(n=>n.endsWith('.test.mjs'))
   .sort().map(n=>join(root,'test',n))
 ]},
 {name:'real_mcp_tool_discovery_without_model',args:[
  join(root,'test','theo-task-stdio-smoke.mjs')
 ]},
 {name:'read_only_release_audit',args:[
  join(root,'scripts','check-release-health.mjs')
 ]}
];
const results=[];
for(const stage of stages){
 const started=Date.now();
 const result=spawnSync(process.execPath,stage.args,{
  cwd:root,shell:false,encoding:'utf8',timeout:90000,maxBuffer:2*1024*1024,
  stdio:['ignore','pipe','pipe'],
  env:{...process.env,CI:'1'}
 });
 const stdout=result.stdout??'';
 const m=/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/.exec(stdout);
 const completed=result.status===0&&!result.error;
 const item={
  name:stage.name,status:completed?'PASS':'FAIL',
  exitCode:result.status,elapsedMs:Date.now()-started,
  testCount:m?Number(m[1]):null,passCount:m?Number(m[2]):null,
  failCount:m?Number(m[3]):null,errorCode:result.error?.code??null
 };
 if(stage.name==='read_only_release_audit'){
  try{
   const i=stdout.indexOf('{'),report=JSON.parse(stdout.slice(i));
   item.releaseVerdict=report.verdict;
   item.releaseChecks=report.checked;
   item.releaseFailed=report.failed;
   if(report.verdict!=='PASS_READONLY_ONLY')item.status='FAIL';
  }catch{item.status='FAIL';item.errorCode='RELEASE_AUDIT_NOT_PARSED';}
 }
 results.push(item);
 console.log(item.status,stage.name,
  JSON.stringify({elapsedMs:item.elapsedMs,tests:item.testCount,
   releaseVerdict:item.releaseVerdict??null,releaseChecks:item.releaseChecks??null}));
 if(item.status==='FAIL')break; // do not retry a failed stage
}
const passed=results.length===stages.length&&results.every(x=>x.status==='PASS');
const report={
 product:'Theo Synapse',performedAt:new Date().toISOString(),
 verdict:passed?'PASS_READONLY_ACCEPTANCE':'FAIL',
 currentPlanWriteActions:'NOT_TESTED_OR_ENABLED',
 actualCodexModelStarted:false,originalProjectsModified:false,
 authorizationChanged:false,
 stages:results
};
const path=join(evidence,'theo-acceptance-batch-'+report.performedAt.replace(/[:.]/g,'-')+'.json');
writeFileSync(path,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
console.log('BATCH_VERDICT',report.verdict,'EVIDENCE',path);
if(!passed)process.exitCode=1;
