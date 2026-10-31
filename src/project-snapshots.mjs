// Owner-local, read-only project snapshot import.
// External source files are never exposed directly to Codex or Tunnel MCP.
import {
  lstatSync, realpathSync, readdirSync, openSync, fstatSync, readSync, closeSync,
  existsSync, mkdirSync, rmdirSync, writeFileSync, readFileSync, renameSync, rmSync, constants
} from 'node:fs';
import {resolve,join,relative,dirname,extname,sep,basename} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {loadReadOnlyRegistry} from './readonly-registry.mjs';
import {assertNativeProjectAllowed} from './native-core.mjs';

export const MAX_SNAPSHOT_FILES=180;
export const MAX_SNAPSHOT_BYTES=10*1024*1024;
export const MAX_FILE_BYTES=128*1024;
const MAX_SCAN_ENTRIES=4000;
const MAX_DEPTH=7;
const extensions=new Set([
  '.md','.txt','.js','.mjs','.cjs','.jsx','.ts','.tsx','.py','.swift',
  '.css','.scss','.html','.json','.yaml','.yml','.toml','.sql',
  '.sh','.go','.rs','.java','.c','.h','.cpp','.hpp','.m','.mm',
  '.graphql','.xml','.vue','.svelte'
]);
const allowedSpecial=new Set(['Dockerfile','Makefile','Gemfile','Podfile']);
const blockedDirs=new Set([
  '.git','.hg','.svn','node_modules','.next','dist','build','coverage',
  '.venv','venv','__pycache__','vendor','.cache','tmp','temp',
  '.local','.idea','.vscode','.ssh','.aws','.config','.gnupg','DerivedData',
  'Pods','.gradle','target','backups','secrets','private',
  'Library','Keychains','Mail','Safari','Calendars','Caches','AddressBook'
]);
const bannedName=/(\.env|secret|token|password|credential|private|keychain|api.?key|\.pem$|\.p12$|\.key$|\.mobileprovision$|\.sqlite|\.db$|\.lock$|id_rsa)/i;
const secretContent=[
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{14,}/,
  /\b(?:ghp_|github_pat_|glpat-|xox[baprs]-)[A-Za-z0-9_-]{12,}/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;}]{10,}/i
];
const sha256=data=>createHash('sha256').update(data).digest('hex');
function sourceDir(path){
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||
    (stat.mode&0o022)!==0||realpathSync.native(path)!==path)
    throw Error('SOURCE_DIRECTORY_UNSAFE');
}
function textBuffer(path,size){
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid()||
      (stat.mode&0o022)!==0||stat.size>MAX_FILE_BYTES||stat.size!==size)
      throw Error('SOURCE_FILE_CHANGED');
    const b=Buffer.alloc(size);
    let pos=0;
    while(pos<size){
      const n=readSync(fd,b,pos,size-pos,pos);
      if(n<=0)throw Error('SOURCE_FILE_CHANGED');
      pos+=n;
    }
    if(fstatSync(fd).size!==size)throw Error('SOURCE_FILE_CHANGED');
    return b;
  }finally{closeSync(fd);}
}
function eligibleName(name){
  if(name.startsWith('.')||bannedName.test(name))return false;
  return extensions.has(extname(name).toLowerCase())||allowedSpecial.has(name);
}
function dangerousSourcePath(p,standaloneRoot){
  if(!p.startsWith('/')||p.length>320||/[\x00-\x1f]/.test(p))throw Error('SOURCE_PATH_INVALID');
  if(p===standaloneRoot||p.startsWith(standaloneRoot+sep)||
     standaloneRoot.startsWith(p+sep))throw Error('SOURCE_OVERLAPS_STANDALONE');
  const home=process.env.HOME ? realpathSync.native(process.env.HOME) : '';
  const broadHome=home?[join(home,'Documents'),join(home,'Desktop'),join(home,'Downloads'),
    join(home,'Library'),join(home,'Applications')]:[];
  const volumeRoot=p.startsWith('/Volumes/')&&p.split(sep).filter(Boolean).length<=2;
  if(p==='/'||p==='/Users'||p===home||p==='/Volumes'||volumeRoot||
     broadHome.includes(p)||p==='/private'||p==='/private/tmp'||p==='/tmp')
    throw Error('SOURCE_ROOT_TOO_BROAD');
  const segments=p.split(sep).filter(Boolean);
  if(segments.some((seg,i)=>(seg.startsWith('.')||blockedDirs.has(seg)||
     /(^|[-_])secret(s)?([-_]|$)/i.test(seg))&&
     !((i===0&&seg==='private'&&segments[1]==='tmp')||
       (i===1&&seg==='tmp'&&segments[0]==='private'))))
    throw Error('SOURCE_PATH_PROTECTED');
}
export function planReadOnlySnapshot({standaloneRoot,sourcePath,id}){
  const root=resolve(standaloneRoot);
  assertNativeProjectAllowed(root,id);
  if(realpathSync.native(root)!==root)throw Error('STANDALONE_ROOT_ALIAS');
  if(typeof id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{2,39}$/.test(id)||id==='theo-lab')
    throw Error('INVALID_SNAPSHOT_ID');
  if(typeof sourcePath!=='string'||!sourcePath.startsWith('/')||
     resolve(sourcePath)!==sourcePath)throw Error('SOURCE_PATH_INVALID');
  const source=realpathSync.native(sourcePath);
  if(source!==sourcePath)throw Error('SOURCE_ALIAS_DENIED');
  dangerousSourcePath(source,root);
  sourceDir(source);
  const files=[],counts={unsupported:0,protected:0,symlink:0,oversized:0,binary:0,unsafe:0};
  let entries=0,totalBytes=0;
  const walk=(directory,depth)=>{
    if(depth>MAX_DEPTH)throw Error('SOURCE_DEPTH_LIMIT');
    sourceDir(directory);
    const items=readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'));
    for(const item of items){
      if(++entries>MAX_SCAN_ENTRIES)throw Error('SOURCE_SCAN_LIMIT');
      const name=item.name;
      const pathname=join(directory,name);
      if(item.isSymbolicLink()){counts.symlink++;continue;}
      if(item.isDirectory()){
        if(name.startsWith('.')||blockedDirs.has(name)||bannedName.test(name)){
          counts.protected++;continue;
        }
        // Ignore other-user or writable directory trees rather than follow them.
        try{sourceDir(pathname);}catch{counts.unsafe++;continue;}
        walk(pathname,depth+1);continue;
      }
      if(!item.isFile()){counts.unsafe++;continue;}
      if(!eligibleName(name)){
        counts[bannedName.test(name)||name.startsWith('.')?'protected':'unsupported']++;
        continue;
      }
      const st=lstatSync(pathname);
      if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||
         st.nlink!==1||(st.mode&0o022)!==0){counts.unsafe++;continue;}
      if(st.size>MAX_FILE_BYTES||st.size===0){counts.oversized++;continue;}
      let buf,txt;
      try{
        buf=textBuffer(pathname,st.size);
        txt=new TextDecoder('utf-8',{fatal:true}).decode(buf);
      }catch{counts.unsafe++;continue;}
      if(txt.includes('\0')){counts.binary++;continue;}
      // A content match is different from an excluded filename: fail closed so
      // the Owner knows the selected source needs attention before any import.
      if(secretContent.some(regex=>regex.test(txt)))throw Error('SOURCE_SECRETS_DETECTED');
      if(files.length+1>MAX_SNAPSHOT_FILES)throw Error('SNAPSHOT_FILE_LIMIT');
      totalBytes+=buf.length;
      if(totalBytes>MAX_SNAPSHOT_BYTES)throw Error('SNAPSHOT_TOTAL_SIZE_LIMIT');
      const rel=relative(source,pathname);
      if(rel.startsWith('..')||rel.startsWith('/')||rel.includes('\\'))throw Error('SOURCE_TRAVERSAL_DENIED');
      files.push({relative:rel,sha256:sha256(buf),bytes:buf.length});
    }
  };
  walk(source,0);
  if(files.length===0)throw Error('SNAPSHOT_NO_ELIGIBLE_FILES');
  files.sort((a,b)=>a.relative.localeCompare(b.relative,'en'));
  const proof=sha256(JSON.stringify(files));
  return {id,source,files,totalBytes,excluded:counts,digest:proof};
}
function privateFile(path){
  const s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid()||
     (s.mode&0o077)!==0)throw Error('PRIVATE_REGISTRY_REQUIRED');
}
function commitRegistry(config,objects){
  privateFile(config);
  const temp=config+'.'+randomBytes(8).toString('hex')+'.tmp';
  try{
    writeFileSync(temp,JSON.stringify(objects,null,2)+'\n',{flag:'wx',mode:0o600});
    renameSync(temp,config);
  }catch(e){
    if(existsSync(temp))rmSync(temp,{force:true});
    throw e;
  }
}
export function importReadOnlySnapshot({standaloneRoot,sourcePath,id,confirm,approveOwner,assertIdle}){
  const root=resolve(standaloneRoot);
  assertNativeProjectAllowed(root,id);
  if(assertIdle!==undefined&&typeof assertIdle!=='function')throw Error('IDLE_CHECK_INVALID');
  assertIdle?.();
  const registry=loadReadOnlyRegistry(root);
  const plan=planReadOnlySnapshot({standaloneRoot:root,sourcePath,id});
  if(typeof confirm!=='string'||confirm!==plan.digest.slice(0,20))
    throw Error('OWNER_CONFIRMATION_REQUIRED');
  if(Object.hasOwn(registry.projects,id))throw Error('PROJECT_ID_ALREADY_REGISTERED');
  if(typeof approveOwner!=='function'||approveOwner({id,source:plan.source,digest:plan.digest,files:plan.files.length})!==true)
    throw Error('OWNER_NATIVE_APPROVAL_DENIED');
  if(Object.keys(registry.projects).length>=12)throw Error('PROJECT_REGISTRY_FULL');
  const target=join(registry.runtime,'projects',id);
  if(existsSync(target))throw Error('SNAPSHOT_TARGET_ALREADY_EXISTS');
  // An exclusive owner-local lock prevents two importers from rewriting the registry.
  const lock=join(registry.runtime,'.registry-owner-lock');
  mkdirSync(lock,{mode:0o700});
  let targetCreated=false,committed=false;
  try{
    // Check the registry again under the lock before modifying it.
    assertIdle?.();
    const current=loadReadOnlyRegistry(root);
    if(Object.hasOwn(current.projects,id))throw Error('PROJECT_ID_ALREADY_REGISTERED');
    mkdirSync(target,{mode:0o700});targetCreated=true;
    for(const file of plan.files){
      const src=join(plan.source,file.relative),dst=join(target,file.relative);
      mkdirSync(dirname(dst),{recursive:true,mode:0o700});
      const data=textBuffer(src,file.bytes);
      if(sha256(data)!==file.sha256)throw Error('SOURCE_FILE_CHANGED');
      writeFileSync(dst,data,{flag:'wx',mode:0o600});
    }
    const next={schema:1,projects:{...current.projects,[id]:target}};
    commitRegistry(current.configPath,next);
    committed=true;
    return {id,registered:true,sourceChanged:false,importedFiles:plan.files.length,
      bytes:plan.totalBytes,digest:plan.digest,projectId:id,snapshot:true};
  }finally{
    // Remove only a newly created, unregistered target, never existing project data.
    if(targetCreated&&!committed)rmSync(target,{recursive:true,force:true});
    rmdirSync(lock);
  }
}
