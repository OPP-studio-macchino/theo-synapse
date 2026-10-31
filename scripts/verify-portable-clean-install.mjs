// Extract & exercise a fresh Theo Synapse READONLY PREVIEW in /private/tmp.
// No live service changes, no Tunnel, no real Codex turn, no Owner grant.
// Uses npm --offline --ignore-scripts: never downloads or runs dependency scripts.
import {
 mkdtempSync,rmSync,readFileSync,writeFileSync,lstatSync,existsSync
} from 'node:fs';
import {resolve,join,basename,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const dev=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const archive=process.argv[2];
if(typeof archive!=='string'||!archive.startsWith('/')||
   !archive.includes('/.local/releases/theo-synapse-readonly-preview-')||
   !archive.endsWith('.tar.gz')||!existsSync(archive))
 throw Error('PORTABLE_TEST_ARCHIVE_INVALID');
const parent=dirname(archive);
if(parent!==join(dev,'.local','releases'))
 throw Error('PORTABLE_TEST_NOT_FROM_STANDALONE');
const archiveStat=lstatSync(archive);
if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||
   archiveStat.uid!==process.getuid()||(archiveStat.mode&0o077)!==0)
 throw Error('PORTABLE_TEST_ARCHIVE_UNSAFE');
const baseName=basename(archive).replace(/-20\d{2}-.*\.tar\.gz$/,'');
if(!/^theo-synapse-readonly-preview-\d+\.\d+\.\d+$/.test(baseName))
 throw Error('PORTABLE_TEST_PACKAGE_NAME_INVALID');
const tmp=mkdtempSync('/private/tmp/theo-clean-install-');
const install=join(tmp,baseName);
const checks=[];
let failure=null;
function step(name,command,args,workdir=tmp,timeout=90000){
 const r=spawnSync(command,args,{
  cwd:workdir,encoding:'utf8',timeout,maxBuffer:500000,
  stdio:['ignore','pipe','pipe'],
  env:{...process.env,CI:'1'}
 });
 const success=r.status===0&&!r.error;
 checks.push({name,passed:success,exitCode:r.status,error:r.error?.code??null});
 console.log((success?'PASS':'FAIL')+' '+name+' exit='+r.status);
 if(!success)throw Error('PORTABLE_STEP_'+name.toUpperCase().replace(/[^A-Z0-9_]/g,'_')+'_FAILED');
 return r.stdout;
}
try{
 const listing=step('tar_listing','/usr/bin/tar',['-tf',archive]);
 const paths=listing.split('\n').filter(Boolean);
 if(paths.some(p=>p.startsWith('/')||p.includes('..')||p.includes('/.local/')||
    p.includes('/node_modules/')||p.includes('/.git/')))
  throw Error('PORTABLE_ARCHIVE_UNSAFE_PATH');
 step('tar_extract','/usr/bin/tar',['-C',tmp,'-xzf',archive]);
 step('bundle_sha256_check',process.execPath,['scripts/verify-portable-bundle.mjs'],install);
 step('npm_ci_offline','/usr/bin/env',['npm','ci','--offline','--ignore-scripts','--no-audit','--no-fund'],install,90000);
 step('readonly_initial_setup',process.execPath,['scripts/setup-readonly-lab.mjs'],install);
 step('readonly_setup_idempotence',process.execPath,['scripts/setup-readonly-lab.mjs'],install);
 const doctor=step('portable_doctor',process.execPath,['scripts/portable-doctor.mjs'],install);
 const parsed=JSON.parse(doctor);
 if(parsed.verdict!=='READY_FOR_OWNER_TUNNEL_SETUP')
  throw Error('PORTABLE_DOCTOR_NOT_READY');
 const smoke=step('in_memory_mcp_8_tools_no_model',process.execPath,['scripts/portable-smoke.mjs'],install);
 const mcp=JSON.parse(smoke);
 if(mcp.verdict!=='PASS'||mcp.toolCount!==8||mcp.writeEnabled!==false||mcp.realCodexTurnStarted!==false)
  throw Error('PORTABLE_MCP_UNEXPECTED');
 const staged=step('stage_launchagent_only',process.execPath,['scripts/stage-launchagent.mjs'],install);
 const obj=JSON.parse(staged.slice(staged.indexOf('{'),staged.indexOf('}')+1));
 if(obj.state!=='STAGED_ONLY'||obj.installed!==false||obj.started!==false)
  throw Error('PORTABLE_LAUNCHAGENT_UNEXPECTED');
 step('launchagent_plutil', '/usr/bin/plutil',['-lint',obj.path]);
 step('bundle_hash_after_setup',process.execPath,['scripts/verify-portable-bundle.mjs'],install);
 const release=join(install,'.local','theo-runtime');
 for(const f of ['writes.sqlite','promotions.sqlite','write-release.json'])
  if(existsSync(join(release,f)))throw Error('PORTABLE_WRITE_UNEXPECTED');
}catch(e){failure=String(e?.message??e).slice(0,100);}
finally{
 const report={
  product:'Theo Synapse',
  at:new Date().toISOString(),
  verdict:failure?'FAIL':'PASS_PORTABLE_ISOLATED',
  archiveName:basename(archive),
  checks,issue:failure,
  installedOnLiveMac:false,launchAgentInstalled:false,
  existingServicesModified:false,modelTurnStarted:false,
  originalSourceModified:false,writeEnabled:false
 };
 const evidence=join(dev,'.local','evidence','phase2-task-tools',
  'theo-portable-clean-install-'+report.at.replace(/[:.]/g,'-')+'.json');
 writeFileSync(evidence,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('PORTABLE_E2E_VERDICT',report.verdict,'checks',checks.length,'evidence',evidence);
 // Only the freshly-created isolated /private/tmp directory.
 rmSync(tmp,{recursive:true,force:true});
 if(failure)process.exitCode=1;
}
