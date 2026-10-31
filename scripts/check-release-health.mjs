// Read-only Theo release gate. No model/API calls, no permission changes.
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFileSync,lstatSync} from 'node:fs';
import {inspectReleaseReadiness} from '../src/release-health.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
process.umask(0o077);
const evidence=join(root,'.local','evidence','phase2-task-tools');
const s=lstatSync(evidence);
if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
 (s.mode&0o077)!==0)throw Error('EVIDENCE_DIRECTORY_UNSAFE');

const report=inspectReleaseReadiness({
 root,expectedProjectIds:['theo-lab','chappy-signal'],
 checkOriginalHashes:true,expectedFileCount:69,
 sourceProject:'/Volumes/OPP_ARCHIVE/O.P.P Studio/Chappy Sound'
});
const stamp=report.inspectedAt.replace(/[:.]/g,'-');
const path=join(evidence,'theo-release-health-'+stamp+'.json');
writeFileSync(path,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({
 verdict:report.verdict,passed:report.passed,failed:report.failed,
 checked:report.checked,
 checks:report.checks,
 evidenceFile:path,writeEnabled:report.writeFeatureEnabled,modelTurnStarted:false
},null,2));
if(report.failed)process.exitCode=1;
