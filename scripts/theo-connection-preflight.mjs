#!/usr/bin/env node
// Read-only only. It deliberately has no cutover, restart, Keychain, or write option.
import {homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runConnectionPreflight} from '../src/connection-preflight.mjs';

const root=resolve(import.meta.dirname,'..');
const defaults={legacyRoot:root,nativeCore:join(homedir(),'Library/Application Support/Theo Synapse/core'),profile:join(root,'.local/tunnel-client-profiles/opp-codex-standalone.yaml'),manifestPath:join(homedir(),'Applications/Theo Synapse.app/Contents/Resources/core-manifest.json')};
const options={...defaults};
const allowed=new Set(['--legacy-root','--native-core','--profile','--manifest']);
for(let i=2;i<process.argv.length;i+=2){const flag=process.argv[i],value=process.argv[i+1];if(!allowed.has(flag)||!value||value.startsWith('--')){process.stderr.write('USAGE: theo-connection-preflight.mjs [--legacy-root PATH --native-core PATH --profile PATH --manifest PATH]\n');process.exit(64);}options[{ '--legacy-root':'legacyRoot','--native-core':'nativeCore','--profile':'profile','--manifest':'manifestPath'}[flag]]=resolve(value);}
const report=await runConnectionPreflight(options);
process.stdout.write(JSON.stringify(report)+'\n');
if(report.verdict==='BLOCKED')process.exitCode=2;
else if(report.verdict==='POST_CUTOVER_VALIDATION_REQUIRED')process.exitCode=3;
