import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROOT } from './support/agent-harness.mjs'

const exec = promisify(execFile)

test('a fixture Agent exiting before interactive readiness rejects and leaves no handle keeping the test process alive', async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import {runAgent} from './test/support/agent-harness.mjs';
    try { await runAgent({argv:['--help'], chatLines:['must not be sent']}); process.exitCode=1 }
    catch(error) { if(!/interactive Agent did not become ready/.test(error.message)) throw error; console.log('readiness rejected and cleaned') }
  `], { cwd: ROOT, timeout: 5000, windowsHide: true })
  assert.match(stdout, /readiness rejected and cleaned/)
})

test('a fixture endpoint listen failure releases its own resources and preserves the original listener', async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `
    import {createServer} from 'node:http';
    import {runAgent} from './test/support/agent-harness.mjs';
    const occupied=createServer((req,res)=>res.end('original'));
    await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
    try {
      try { await runAgent({listenPort:occupied.address().port}); throw Error('missing refusal') }
      catch(error) { if(error.code!=='EADDRINUSE') throw error }
      if(await (await fetch('http://127.0.0.1:'+occupied.address().port)).text()!=='original') throw Error('original listener changed');
      console.log('listen rejected and original preserved');
    } finally { occupied.closeAllConnections(); await new Promise(resolve=>occupied.close(resolve)) }
  `], { cwd: ROOT, timeout: 5000, windowsHide: true })
  assert.match(stdout, /listen rejected and original preserved/)
})
