// Native-only policy boundary. The location is derived from the account's
// passwd record, not an inherited HOME value, so a development checkout (or
// caller-controlled environment) cannot opt itself into native policy.
import {userInfo} from 'node:os';
import {join,resolve} from 'node:path';

export const FORBIDDEN_NATIVE_PROJECT_ID='chappy-signal';

export function nativeCorePath(home=userInfo().homedir){
 return join(resolve(home),'Library','Application Support','Theo Synapse','core');
}

export function isNativeCoreRoot(root,home=userInfo().homedir){
 return resolve(root)===nativeCorePath(home);
}

export function assertNativeProjectAllowed(root,id,home=userInfo().homedir){
 if(isNativeCoreRoot(root,home)&&id===FORBIDDEN_NATIVE_PROJECT_ID)
  throw Error('FORBIDDEN_NATIVE_PROJECT');
}
