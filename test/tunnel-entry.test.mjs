import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('Standalone tunnel stdio entrypoint exposes ONLY safe diagnostics',async()=>{
  const client=new Client({name:'standalone-tunnel-fixture',version:'1'});
  const transport=new StdioClientTransport({
    command:process.execPath,
    args:[resolve('scripts/tunnel-entry.mjs')],
    cwd:process.cwd(),
    env:{HOME:process.env.HOME??'',PATH:process.env.PATH??'/usr/bin:/bin'}
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name,'theo-synapse');
    assert.equal(client.getServerVersion()?.title,'Theo Synapse');
    assert.equal(client.getServerVersion()?.version,'0.0.5');
    const icons=client.getServerVersion()?.icons;
    assert.equal(icons?.length,1);
    assert.equal(icons[0].mimeType,'image/png');
    assert.deepEqual(icons[0].sizes,['64x64']);
    assert.match(icons[0].src,/^data:image\/png;base64,/);
    const decoded=Buffer.from(icons[0].src.split(',')[1],'base64');
    const expected=readFileSync(resolve('assets/theo-synapse-icon-64.png'));
    assert.equal(createHash('sha256').update(decoded).digest('hex'),createHash('sha256').update(expected).digest('hex'));
    const tools=await client.listTools();
    assert.deepEqual(tools.tools.map(x=>x.name).sort(),
      ['standalone_capabilities','standalone_codex_probe']);
    const result=await client.callTool({name:'standalone_capabilities',arguments:{}});
    assert.equal(result.isError,undefined);
    const flags=JSON.parse(result.content[0].text);
    assert.equal(flags.productName,'Theo Synapse');
    assert.equal(flags.realCodexTaskEnabled,false);
    assert.equal(flags.taskStartEnabled,false);
    assert.equal(flags.writeEnabled,false);
    assert.equal(flags.transport,'standalone-tunnel-stdio');
  } finally {
    await client.close();
  }
});
