// One-command, no-model-token release gate for STAGED owner promotion.
// Never changes live projects, plugin, Tunnel, Keychain, or source files.
import {spawnSync} from 'node:child_process';
import {
 readFileSync,writeFileSync,existsSync,lstatSync,realpathSync
} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const evidence=join(root,'.local','evidence','phase2-task-tools');
const checks=[];
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const check=(name,passed,details=null)=>{
 checks.push({name,pass:Boolean(passed),details});
 console.log((passed?'PASS ':'FAIL ')+name+(details?' '+JSON.stringify(details):''));
};
function run(command,args,label){
 const r=spawnSync(command,args,{
  cwd:root,encoding:'utf8',timeout:60000,maxBuffer:250000,
  env:{...process.env,CI:'1'},
  stdio:['ignore','pipe','pipe']
 });
 check(label,r.status===0,{
  exitCode:r.status,signal:r.signal??null,
  errorCode:r.error?.code??null,
  summary:(r.stdout??'').match(/ℹ tests [0-9]+|ℹ pass [0-9]+|ℹ fail [0-9]+/g)?.join(' / ')??null
 });
}
try{
 run(process.execPath,['--test','test/owner-promotion.test.mjs'],'promotion_and_recovery_tests');
 run(process.execPath,['--test','test/promotion-ledger.test.mjs'],'ledger_restart_tests');
 run(process.execPath,['--test','test/write-mcp-gated.test.mjs'],'live_gate_is_off_in_isolated_test');
 run(process.execPath,['test/theo-task-stdio-smoke.mjs'],'live_stdio_surface_smoke');
 const reg=JSON.parse(readFileSync(join(root,'.local','theo-runtime','projects.json'),'utf8'));
 const ids=Object.keys(reg.projects).sort();
 check('registered_project_ids',JSON.stringify(ids)===JSON.stringify(['chappy-signal','theo-lab']),ids);
 const prodWrites=join(root,'.local','theo-runtime','writes.sqlite');
 const prodPromotion=join(root,'.local','theo-runtime','promotions.sqlite');
 check('write_and_promotion_persistence_not_enabled_in_live',!existsSync(prodWrites)&&!existsSync(prodPromotion));
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
 check('owner_local_cli_present',manifest.scripts?.['promotion:owner']==='node scripts/theo-promote.mjs');
 const original='/Volumes/OPP_ARCHIVE/O.P.P Studio/Chappy Sound';
 const snap=join(root,'.local','theo-runtime','projects','chappy-signal');
 let mismatches=0,files=0;
 const {readdirSync}=await import('node:fs');
 const walk=p=>{
  for(const e of readdirSync(p,{withFileTypes:true})){
   const full=join(p,e.name);
   if(e.isDirectory())walk(full);
   else if(e.isFile()){
    files++;
    const rel=full.slice(snap.length+1),source=join(original,rel);
    if(!existsSync(source)||sha(source)!==sha(full))mismatches++;
   }else mismatches++;
  }
 };
 walk(snap);
 check('chappy_69_file_snapshot_preserved',files===69&&mismatches===0,
  {count:files,hashMismatches:mismatches});
 const protect={
  '/Users/THEO_PUBLIC_EXAMPLE/Documents/Codex/C2C-Greenfield-20261020/implementation/src/safe-output.ts':'0a33de0e4ed32febf2ca4963698bc7b99776bc40b58b5f4d804399d8ff4dbc61',
  '/Users/THEO_PUBLIC_EXAMPLE/Documents/Codex/C2C-Greenfield-20261020/implementation/src/ledger.ts':'150baf6105d1d07f36f1664ee5ca10195d60640f63a81d0c7e0e15770a97103a',
  '/Users/THEO_PUBLIC_EXAMPLE/Documents/Codex/C2C-Greenfield-20261020/implementation/src/codex-stdio.ts':'c6612148e9633faa446ec151062f98fd56195f3592461cd065dedb95dd1c0efd'
 };
 check('protected_greenfield_code_hashes_preserved',
  Object.entries(protect).every(([p,hash])=>existsSync(p)&&sha(p)===hash));
}catch(e){
 check('gate_execution',false,{code:String(e?.code??e?.message??'ERROR').slice(0,80)});
}
const passed=checks.every(x=>x.pass);
const result={
 startedAt:new Date().toISOString(),verdict:passed?'PASS_STAGE_ONLY':'FAIL',
 writeModePublished:false,realSourceChangedByGate:false,
 checks,realCodexStarted:false,
 report:'Staged local promotion only; no authorization for live source mutation.'
};
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const path=join(evidence,'OWNER_PROMOTION_STAGE_GATE_'+stamp+'.json');
try{
 if(existsSync(path))throw Error('REPORT_ALREADY_EXISTS');
 writeFileSync(path,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log('EVIDENCE_SAVED',path);
}catch(e){console.error('EVIDENCE_NOT_SAVED',String(e?.message??e).slice(0,80));process.exitCode=1;}
if(!passed)process.exitCode=1;
