// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../worker/rulith-worker.mjs'

test('a database run Adapter receives only its selected local DSN, never a filesystem-rewritten address', async () => {
  const selected = 'postgresql://selected:synthetic@127.0.0.1/orders'
  const sources = { 'database-a': { type:'db', dsn:selected, access:'postgresql://public/orders' },
    'database-b': { type:'db', dsn:'postgresql://other:unrelated@127.0.0.1/other' } }
  const tool = { impl:'run', source:'database-a', cmd:process.execPath,
    args:['-e', 'process.stdout.write(JSON.stringify({access:process.env.RULITH_SOURCE_ACCESS,type:process.env.RULITH_SOURCE_TYPE}))'] }
  const output = await execute('database-job', {}, { 'database-job':tool }, sources)
  assert.deepEqual(JSON.parse(output), { access:selected, type:'db' })
  const { source:_removed, ...sourceFree } = tool
  const free = await execute('pure-job', {}, { 'pure-job':sourceFree }, sources)
  assert.deepEqual(JSON.parse(free), {}, 'a Source-free Adapter receives no borrowed DSN or Source type')
})
