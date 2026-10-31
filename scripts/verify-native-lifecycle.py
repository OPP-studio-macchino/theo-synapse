#!/usr/bin/env python3
"""Run the installed signed app's exact GUI controller through its CLI harness."""
from pathlib import Path
import json,subprocess,os,hashlib,datetime
ROOT=Path(__file__).resolve().parents[1]
EXE=Path.home()/'Applications/Theo Synapse.app/Contents/MacOS/TheoSynapse'
OUT=ROOT/'.local/evidence/macos-native-20261028'
os.umask(0o077)
steps=[];problem=None

def command(action):
 p=subprocess.run([str(EXE),'--manage',action],capture_output=True,text=True,timeout=70)
 try:r=json.loads(p.stdout)
 except Exception:r={'parseFailure':True,'exitCode':p.returncode}
 steps.append({'action':action,'exitCode':p.returncode,'result':r})
 print(action.upper(),json.dumps(r,ensure_ascii=False),flush=True)
 assert p.returncode==0 and 'error' not in r,f'FAILED_{action}'
 return r
try:
 first=command('status');assert first['installed'] and first['writeEnabled'] is False
 reg=Path(first['corePath'])/'.local/theo-runtime/projects.json'
 initial=hashlib.sha256(reg.read_bytes()).hexdigest()
 setup=command('setup');assert setup['installed'] and setup['codexLogin']=='LOGGED_IN'
 assert hashlib.sha256(reg.read_bytes()).hexdigest()==initial
 verify=command('verify');assert verify['verdict']=='PASS'
 started=command('start');assert started['running'] and started['launchAgentLoaded'] and started['activeTasks']==0 and started['pid']>0
 firstPid=started['pid']
 smoke=command('smoke');assert smoke['verdict']=='PASS' and smoke['toolCount']==8 and smoke['modelTurnStarted'] is False
 duplicate=command('start');assert duplicate['pid']==firstPid
 restarted=command('restart');assert restarted['running'] and restarted['pid']!=firstPid
 stopped=command('stop');assert not stopped['running'] and not stopped['launchAgentLoaded']
 socket=Path(first['corePath'])/'.local/theo.sock';assert not socket.exists()
 final=command('start');assert final['running'] and final['pid']!=restarted['pid']
 end=command('smoke');assert end['verdict']=='PASS'
 assert hashlib.sha256(reg.read_bytes()).hexdigest()==initial
 assert not (Path(first['corePath'])/'.local/theo-runtime/writes.sqlite').exists()
 assert not (Path(first['corePath'])/'.local/theo-runtime/write-release.json').exists()
except Exception as e:
 problem=str(e)
finally:
 report={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'verdict':'FAIL' if problem else 'PASS_INSTALLED_MAC_LIFECYCLE','installedApp':str(EXE.parent.parent.parent),'error':problem,'steps':steps,'modelTurnStarted':False,'existingTunnelMigrated':False,'macOSRebootTested':False}
 target=OUT/('installed-lifecycle-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.json')
 with target.open('x') as f:json.dump(report,f,ensure_ascii=False,indent=2)
 print('LIFECYCLE_VERDICT',report['verdict'],flush=True)
 if problem:raise SystemExit(1)
