// Owner-run, one-time, wholly isolated allowlist. NEVER modifies pre-existing project paths.
import {mkdirSync,writeFileSync,readFileSync,lstatSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
const root=realpathSync.native(resolve(import.meta.dirname,'..'));
const local=join(root,'.local');
const rt=join(local,'theo-runtime');
const base=join(rt,'projects');
const lab=join(base,'theo-lab');
const doc=join(lab,'INPUT.md');
const config=join(rt,'projects.json');
const text='Theo Synapse read-only lab.\nVerification label: THEO_LAB_20261027.\nValues: 11, 13, 18.\nThe exact sum is 42.\n';
process.umask(0o077);
for(const dir of [local,rt,base,lab]){
 try{mkdirSync(dir,{mode:0o700});}
 catch(e){if(e.code!=='EEXIST')throw e;}
 const s=lstatSync(dir);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0)
   throw Error('UNSAFE_RUNTIME_DIRECTORY');
}
for(const [p,value] of [[doc,text],[config,JSON.stringify({schema:1,projects:{'theo-lab':lab}},null,2)+'\n']]){
 try{writeFileSync(p,value,{flag:'wx',mode:0o600});}
 catch(e){
  if(e.code!=='EEXIST'||readFileSync(p,'utf8')!==value)throw Error('EXISTING_RUNTIME_FILE_DIFFERS');
 }
 const s=lstatSync(p);
 if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||
  (s.mode&0o077)!==0)throw Error('UNSAFE_RUNTIME_FILE');
}
console.log('READONLY_DEMO_ALLOWLIST_READY',JSON.stringify({projectId:'theo-lab',allowedPaths:1,permissions:'PRIVATE'}));
