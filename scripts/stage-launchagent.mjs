// Generate a REVIEW-ONLY macOS LaunchAgent definition.
// No launchctl call, no autorun, and no change outside private Theo runtime.
import {join,resolve} from 'node:path';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {
 existsSync,readFileSync,mkdirSync,lstatSync,writeFileSync,realpathSync
} from 'node:fs';

export const agentLabel='tech.oppstudio.theosynapse.readonly';
const xml=x=>String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;')
 .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
export function renderLaunchAgent({
 root,nodeBinary=process.execPath,home=homedir()
}={}){
 if(process.platform!=='darwin'||typeof root!=='string'||!root.startsWith('/')||
    resolve(root)!==root||realpathSync.native(root)!==root||
    !nodeBinary.startsWith('/')||!home.startsWith('/'))
  throw Error('LAUNCHAGENT_CONTEXT_INVALID');
 const args=[nodeBinary,join(root,'scripts','task-daemon-entry.mjs')];
 const path=[join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin'].join(':');
 const values=[
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0"><dict>',
  '<key>Label</key><string>'+xml(agentLabel)+'</string>',
  '<key>ProgramArguments</key><array>',
  ...args.map(x=>'<string>'+xml(x)+'</string>'),
  '</array>',
  '<key>WorkingDirectory</key><string>'+xml(root)+'</string>',
  '<key>RunAtLoad</key><true/>',
  '<key>KeepAlive</key><false/>',
  '<key>ThrottleInterval</key><integer>20</integer>',
  '<key>Umask</key><integer>63</integer>',
  '<key>EnvironmentVariables</key><dict>',
  '<key>HOME</key><string>'+xml(home)+'</string>',
  '<key>PATH</key><string>'+xml(path)+'</string>',
  '</dict>',
  '<key>StandardOutPath</key><string>'+xml(join(root,'.local','theo-runtime','launchagent.stdout.log'))+'</string>',
  '<key>StandardErrorPath</key><string>'+xml(join(root,'.local','theo-runtime','launchagent.stderr.log'))+'</string>',
  '</dict></plist>'
 ];
 return values.join('\n')+'\n';
}
export function stageLaunchAgent(root){
 const runtime=join(root,'.local','theo-runtime');
 if(!existsSync(runtime))throw Error('SETUP_READONLY_FIRST');
 const s=lstatSync(runtime);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||
    (s.mode&0o077)!==0||realpathSync.native(runtime)!==runtime)
  throw Error('LAUNCHAGENT_STAGE_DIR_UNSAFE');
 const parent=join(runtime,'installer-staging');
 try{mkdirSync(parent,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 const p=lstatSync(parent);
 if(!p.isDirectory()||p.isSymbolicLink()||p.uid!==process.getuid()||
    (p.mode&0o077)!==0)throw Error('LAUNCHAGENT_STAGE_DIR_UNSAFE');
 const content=renderLaunchAgent({root});
 const path=join(parent,agentLabel+'.plist');
 if(existsSync(path)){
  const s=lstatSync(path);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||
     (s.mode&0o077)!==0||readFileSync(path,'utf8')!==content)
   throw Error('LAUNCHAGENT_STAGE_CONFLICT');
 }else writeFileSync(path,content,{mode:0o600,flag:'wx'});
 return {state:'STAGED_ONLY',path,installed:false,started:false,manualOwnerActionRequired:true};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
 const result=stageLaunchAgent(root);
 console.log(JSON.stringify(result,null,2));
 console.log('NO_SYSTEM_LAUNCHAGENT_OR_RUNNING_SERVICE_WAS_MODIFIED');
}
