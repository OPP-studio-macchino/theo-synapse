const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class FixtureCodexAdapter {
  constructor({mode='complete'}={}){this.mode=mode;this.stopped=false;}
  async execute({projectRoot,prompt,onEvent}) {
    if (this.mode==='hang'){await new Promise(()=>{});return;}
    onEvent({kind:'progress',stage:'fixture_started',text:'Fake Codex started (no model executed)'});
    await delay(20);
    if(this.stopped){onEvent({kind:'terminal',status:'interrupted',output:'fixture stopped'});return;}
    onEvent({kind:'progress',stage:'fixture_analysis',text:'Synthetic analysis: no files modified; key=sk\u002dproj-THEO_PUBLIC_SYNTHETIC_001_AAAAAAAAAAAAAAAAAAAAAAAA'});
    await delay(20);
    if(this.stopped){onEvent({kind:'terminal',status:'interrupted',output:'fixture stopped'});return;}
    const status=this.mode==='failed'?'failed':'completed';
    onEvent({kind:'terminal',status,output:'Fixture result returned to MCP client. Synthetic only.'});
  }
  async stop(){this.stopped=true;}
  async disconnect(){}
}
