// Starts only an authenticated loopback endpoint; no tunnel, no public interface.
// Credentials are not generated here. Requires a private, owner-provisioned
// JWKS trust configuration in the new Standalone project's .local directory.
import {openSync,closeSync,fstatSync,readFileSync,constants,lstatSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startLoopbackMcp} from './http-mcp.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const local=join(root,'.local');
function readPrivateConfig(){
  const folder=lstatSync(local);
  if(!folder.isDirectory()||folder.isSymbolicLink()||realpathSync.native(local)!==local||
     folder.uid!==process.getuid?.()||(folder.mode&0o077)!==0)
    throw Error('STANDALONE_LOCAL_DIRECTORY_UNSAFE');
  const filename=resolve(process.env.STANDALONE_HTTP_AUTH_CONFIG??join(local,'http-auth.json'));
  if(!filename.startsWith(local+sep))throw Error('AUTH_CONFIG_OUTSIDE_STANDALONE');
  const configDir=dirname(filename),dirStat=lstatSync(configDir);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink()||realpathSync.native(configDir)!==configDir||
     dirStat.uid!==process.getuid?.()||(dirStat.mode&0o077)!==0)
    throw Error('AUTH_CONFIG_DIRECTORY_UNSAFE');
  const fd=openSync(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||
       (stat.mode&0o077)!==0||stat.size>16384)
      throw Error('STANDALONE_AUTH_CONFIG_UNSAFE');
    const config=JSON.parse(readFileSync(fd,'utf8'));
    if(!config||typeof config!=='object'||Object.keys(config).sort().join(',')!=='allowedSubjects,audience,issuer,jwks')
      throw Error('STANDALONE_AUTH_CONFIG_SHAPE_INVALID');
    return config;
  }finally{closeSync(fd);}
}
const port=process.env.STANDALONE_HTTP_PORT===undefined?0:Number(process.env.STANDALONE_HTTP_PORT);
try{
  const auth=readPrivateConfig();
  const server=await startLoopbackMcp({auth,port});
  const a=server.address();
  process.stdout.write('Standalone authenticated LOOPBACK only: http://'+a.host+':'+a.port+a.path+'\n');
  process.stdout.write('NOT connected to ChatGPT; no external transport enabled.\n');
  let closing=false;
  const terminate=async()=>{
    if(closing)return;closing=true;
    try{await server.close();process.exitCode=0;}catch{process.exitCode=1;}
  };
  process.once('SIGINT',terminate);
  process.once('SIGTERM',terminate);
}catch(e){
  process.stderr.write('Standalone HTTP startup refused: '+String(e?.code??e?.message??'UNAVAILABLE')+'\n');
  process.exitCode=78;
}
