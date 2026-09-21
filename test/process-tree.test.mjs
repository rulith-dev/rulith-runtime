import test from 'node:test'
import assert from 'node:assert/strict'
import { runBounded } from '../local/process-tree.mjs'

test('bounded command timeout terminates a spawned child tree', async () => {
  const script = "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setTimeout(()=>{},10000)']);console.log(c.pid);setTimeout(()=>{},10000)"
  await assert.rejects(() => runBounded(process.execPath, ['-e', script], { timeoutMs: 100, maxBytes: 4096, env: process.env }), /local_authoring_timeout/)
})
