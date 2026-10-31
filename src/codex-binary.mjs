// Resolve an existing local Codex executable. Never install or execute it here.
// The Mac owner may set THEO_CODEX_BIN in the LOCAL service environment only.
import {existsSync,realpathSync,statSync,lstatSync} from 'node:fs';
import {join,isAbsolute,resolve,sep} from 'node:path';
import {homedir} from 'node:os';

const isTrustedExecutable=p=>{
 try{
  if(typeof p!=='string'||!isAbsolute(p)||resolve(p)!==p||
     p.includes('\0')||!existsSync(p))return false;
  const st=statSync(p),link=lstatSync(p);
  if(!st.isFile()||(st.mode&0o111)===0||
     (st.mode&0o022)!==0||![0,process.getuid()].includes(st.uid)||
     (!link.isFile()&&!link.isSymbolicLink()))return false;
  const actual=realpathSync.native(p),target=statSync(actual);
  if(!isAbsolute(actual)||!target.isFile()||
     ![0,process.getuid()].includes(target.uid))return false;
  return true;
 }catch{return false;}
};
export function findCodexExecutable({
 home=homedir(),env=process.env,platform=process.platform
}={}){
 if(platform!=='darwin')throw Error('CODEX_MACOS_REQUIRED');
 if(typeof home!=='string'||!isAbsolute(home)||resolve(home)!==home)
  throw Error('CODEX_HOME_INVALID');
 const override=env.THEO_CODEX_BIN;
 if(override!==undefined){
  if(!isTrustedExecutable(override))throw Error('CODEX_BIN_OVERRIDE_UNSAFE');
  return override;
 }
 const candidates=[
  join(home,'.local','bin','codex'),
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex'
 ];
 const paths=typeof env.PATH==='string'?env.PATH.split(':'):[];
 for(const dir of paths){
  if(isAbsolute(dir)&&resolve(dir)===dir&&!dir.includes('\0'))candidates.push(join(dir,'codex'));
 }
 for(const candidate of [...new Set(candidates)])
  if(isTrustedExecutable(candidate))return candidate;
 throw Error('CODEX_BINARY_NOT_FOUND');
}
export function codexExecutableInfo(options={}){
 try{
  const file=findCodexExecutable(options);
  return {present:true,location:'LOCAL_EXECUTABLE_PRESENT',symlink:lstatSync(file).isSymbolicLink()};
 }catch(e){
  const code=e?.message;
  return {present:false,location:/^CODEX_[A-Z_]+$/.test(code??'')?code:'CODEX_UNAVAILABLE'};
 }
}
