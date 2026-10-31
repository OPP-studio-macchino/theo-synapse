import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,
 lstatSync,symlinkSync,unlinkSync,rmSync,chmodSync
} from 'node:fs';
import {join} from 'node:path';
import {planReadOnlySnapshot,importReadOnlySnapshot} from '../src/project-snapshots.mjs';
import {loadReadOnlyRegistry} from '../src/readonly-registry.mjs';

function fixture(){
 const root=mkdtempSync('/private/tmp/theo-snapshot-root-');
 const src=mkdtempSync('/private/tmp/theo-snapshot-source-');
 const rt=join(root,'.local','theo-runtime');
 const allowed=join(rt,'projects');
 const lab=join(allowed,'theo-lab');
 for(const p of [join(root,'.local'),rt,allowed,lab,mkdirTarget(src,'src'),mkdirTarget(src,'docs'),mkdirTarget(src,'node_modules')]){
  if(p)try{mkdirSync(p,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 }
 writeFileSync(join(rt,'projects.json'),JSON.stringify({schema:1,projects:{'theo-lab':lab}})+'\n',{mode:0o600});
 writeFileSync(join(lab,'INPUT.md'),'Old lab fixture unchanged.\n',{mode:0o600});
 writeFileSync(join(src,'README.md'),'Project overview.\n',{mode:0o600});
 writeFileSync(join(src,'src','app.ts'),'export const value = 42;\n',{mode:0o600});
 writeFileSync(join(src,'docs','PRODUCT_SPEC.md'),'MVP: read-only project import.\n',{mode:0o600});
 writeFileSync(join(src,'.env'),'SK_DO_NOT_READ=1\n',{mode:0o600});
 writeFileSync(join(src,'src','auth-token.ts'),'const sk = "SECRET";\n',{mode:0o600});
 writeFileSync(join(src,'src','looks-ok.ts'),'export const safeExample = true;\n',{mode:0o600});
 writeFileSync(join(src,'node_modules','index.ts'),'untrusted dependency', {mode:0o600});
 writeFileSync(join(src,'docs','bad.png'),Buffer.from([0,1,2]),{mode:0o600});
 symlinkSync(join(src,'.env'),join(src,'docs','token-link.md'));
 const after=()=>({
  readme:readFileSync(join(src,'README.md'),'utf8'),
  app:readFileSync(join(src,'src','app.ts'),'utf8'),
  lab:readFileSync(join(lab,'INPUT.md'),'utf8')
 });
 return {root,src,rt,allowed,lab,after,cleanup:()=>{rmSync(root,{recursive:true,force:true});rmSync(src,{recursive:true,force:true});}};
}
function mkdirTarget(base,name){return join(base,name);}
test('owner plan is READ-ONLY, secret material and symlinks excluded, snapshot digest stable',()=>{
 const x=fixture();
 try{
  const old=x.after();
  const plan=planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'example-one'});
  assert.deepEqual(plan.files.map(f=>f.relative),['docs/PRODUCT_SPEC.md','README.md','src/app.ts','src/looks-ok.ts'].sort((a,b)=>a.localeCompare(b,'en')));
  assert.equal(plan.files.length,4);
  assert.equal(plan.excluded.symlink,1);
  assert.ok(plan.excluded.protected>=2);
  assert.ok(plan.totalBytes>20);
  assert.deepEqual(x.after(),old);
  const again=planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'example-one'});
  assert.equal(plan.digest,again.digest);
  assert.equal(readdirSync(x.allowed).length,1);
 }finally{x.cleanup();}
});
test('owner import requires exact fingerprint AND native owner approval callback',()=>{
 const x=fixture();
 try{
  const plan=planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'example-two'});
  const args={standaloneRoot:x.root,sourcePath:x.src,id:'example-two'};
  assert.throws(()=>importReadOnlySnapshot({...args,confirm:'not-right',approveOwner:()=>true}),/OWNER_CONFIRMATION_REQUIRED/);
  assert.throws(()=>importReadOnlySnapshot({...args,confirm:plan.digest.slice(0,20)}),/OWNER_NATIVE_APPROVAL_DENIED/);
  let asked=0;
  assert.throws(()=>importReadOnlySnapshot({...args,confirm:plan.digest.slice(0,20),approveOwner:()=>{asked++;return false;}}),/OWNER_NATIVE_APPROVAL_DENIED/);
  assert.equal(asked,1);
  const old=x.after();
  const imported=importReadOnlySnapshot({...args,confirm:plan.digest.slice(0,20),approveOwner:request=>{
   asked++;
   assert.equal(request.id,'example-two');
   assert.equal(request.digest,plan.digest);
   return true;
  }});
  assert.equal(imported.registered,true);
  assert.equal(imported.snapshot,true);
  assert.equal(asked,2);
  const reg=loadReadOnlyRegistry(x.root);
  assert.deepEqual(Object.keys(reg.projects).sort(),['example-two','theo-lab']);
  const to=reg.projects['example-two'];
  assert.deepEqual(readdirSync(to).sort(),['README.md','docs','src']);
  assert.equal(statSync(join(to,'README.md')).mode&0o077,0);
  assert.equal(readFileSync(join(to,'src','app.ts'),'utf8'),'export const value = 42;\n');
  assert.deepEqual(x.after(),old);
  assert.throws(()=>importReadOnlySnapshot({...args,confirm:plan.digest.slice(0,20),approveOwner:()=>true}),/PROJECT_ID_ALREADY_REGISTERED/);
 }finally{x.cleanup();}
});
test('snapshot plan denies broad roots, source inside standalone and source symlink alias',()=>{
 const x=fixture();
 try{
  assert.throws(()=>planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.root,id:'reject-one'}),/SOURCE_OVERLAPS_STANDALONE/);
  assert.throws(()=>planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:'/private/tmp',id:'reject-two'}),/SOURCE_ROOT_TOO_BROAD|SOURCE_OVERLAPS_STANDALONE/);
  if(process.env.HOME) assert.throws(()=>planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:process.env.HOME,id:'reject-home'}),/SOURCE_ROOT_TOO_BROAD/);
  const alias=x.src+'-symlink';
  symlinkSync(x.src,alias);
  assert.throws(()=>planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:alias,id:'reject-three'}),/SOURCE_ALIAS_DENIED/);
  unlinkSync(alias);
 }finally{x.cleanup();}
});
test('source change invalidates confirmation; errors leave registry intact',()=>{
 const x=fixture();
 try{
  const before=planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'change-check'});
  writeFileSync(join(x.src,'README.md'),'Changed overview.\n',{mode:0o600});
  assert.throws(()=>importReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'change-check',
    confirm:before.digest.slice(0,20),approveOwner:()=>true}),/OWNER_CONFIRMATION_REQUIRED/);
  assert.deepEqual(Object.keys(loadReadOnlyRegistry(x.root).projects),['theo-lab']);
  assert.equal(readdirSync(x.allowed).length,1);
 }finally{x.cleanup();}
});
test('secret-looking file content fails closed instead of silently importing a partial project',()=>{
 const x=fixture();
 try{
  writeFileSync(join(x.src,'src','public-config.ts'),'export const token = "ghp_abcdefghijklmnopqrstuvwxyz";\n',{mode:0o600});
  assert.throws(()=>planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'secret-check'}),/SOURCE_SECRETS_DETECTED/);
  assert.deepEqual(Object.keys(loadReadOnlyRegistry(x.root).projects),['theo-lab']);
 }finally{x.cleanup();}
});
test('owner import checks for active work before approval and again before committing',()=>{
 const x=fixture();
 try{
  const plan=planReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'idle-check'});
  let checks=0,approvals=0;
  assert.throws(()=>importReadOnlySnapshot({standaloneRoot:x.root,sourcePath:x.src,id:'idle-check',confirm:plan.digest.slice(0,20),
   approveOwner:()=>{approvals++;return true;},assertIdle:()=>{checks++;throw Error('ACTIVE_JOBS_BLOCK_IMPORT');}}),/ACTIVE_JOBS_BLOCK_IMPORT/);
  assert.equal(checks,1);assert.equal(approvals,0);
  assert.deepEqual(Object.keys(loadReadOnlyRegistry(x.root).projects),['theo-lab']);
 }finally{x.cleanup();}
});
