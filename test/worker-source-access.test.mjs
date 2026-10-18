// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { execute } from '../worker/rulith-worker.mjs'
import { pinnedRunTool } from './support/worker-harness.mjs'

test('local action execution keys are Board-scoped, stable across retries and never supplied by model or environment', async (t) => {
  const old = process.env.RULITH_EXECUTION_KEY
  process.env.RULITH_EXECUTION_KEY = 'forged-ambient-key'
  const tool = pinnedRunTool(t, {
    'probe.mjs': 'process.stdout.write(JSON.stringify({key:process.env.RULITH_EXECUTION_KEY,invocation:process.env.RULITH_INVOCATION_ID}))',
  }, { envPass:['RULITH_EXECUTION_KEY'] })
  const run = context => execute('probe', { executionKey:'forged-model-key', boardId:'forged-board' }, {probe:tool}, {}, context).then(JSON.parse)
  try {
    const first = await run({boardId:'board-a',invocationId:'inv_claim_1'})
    assert.match(first.key, /^rulith-execution\/1:[0-9a-f]{64}$/)
    assert.equal(first.invocation, 'inv_claim_1')
    assert.deepEqual(await run({boardId:'board-a',invocationId:'inv_claim_1'}), first)
    assert.notEqual((await run({boardId:'board-b',invocationId:'inv_claim_1'})).key, first.key)
    assert.notEqual((await run({boardId:'board-a',invocationId:'inv_claim_2'})).key, first.key)
    assert.equal((await run({invocationId:'inv_claim_1'})).key, undefined)
    assert.equal((await run({boardId:'board-a'})).key, undefined)
  } finally {
    if (old === undefined) delete process.env.RULITH_EXECUTION_KEY
    else process.env.RULITH_EXECUTION_KEY = old
  }
})

test('a database run Adapter receives only its selected local DSN, never a filesystem-rewritten address', async (t) => {
  const selected = 'postgresql://selected:synthetic@127.0.0.1/orders'
  const sources = { 'database-a': { type:'db', dsn:selected, access:'postgresql://public/orders' },
    'database-b': { type:'db', dsn:'postgresql://other:unrelated@127.0.0.1/other' } }
  const tool = pinnedRunTool(t, {
    'probe.mjs': 'process.stdout.write(JSON.stringify({access:process.env.RULITH_SOURCE_ACCESS,type:process.env.RULITH_SOURCE_TYPE}))',
  }, { source:'database-a' })
  const output = await execute('database-job', {}, { 'database-job':tool }, sources)
  assert.deepEqual(JSON.parse(output), { access:selected, type:'db' })
  const { source:_removed, ...sourceFree } = tool
  const free = await execute('pure-job', {}, { 'pure-job':sourceFree }, sources)
  assert.deepEqual(JSON.parse(free), {}, 'a Source-free Adapter receives no borrowed DSN or Source type')
})

test('a run Adapter is told the governed name of the Source it serves, never an ambient one', async (t) => {
  const old = process.env.RULITH_SOURCE_NAME
  process.env.RULITH_SOURCE_NAME = 'forged-ambient-source'
  const sources = { 'project-a': { type:'file', access:process.cwd() }, 'project-b': { type:'file', access:process.cwd() } }
  const tool = pinnedRunTool(t, {
    'probe.mjs': 'process.stdout.write(JSON.stringify({name:process.env.RULITH_SOURCE_NAME ?? null}))',
  }, { source:'project-a', envPass:['RULITH_SOURCE_NAME'] })
  try {
    assert.deepEqual(JSON.parse(await execute('probe', {}, { probe:tool }, sources)), { name:'project-a' })
    assert.deepEqual(JSON.parse(await execute('probe', {}, { probe:{ ...tool, source:'project-b' } }, sources)), { name:'project-b' })
    const { source:_removed, ...sourceFree } = tool
    assert.deepEqual(JSON.parse(await execute('probe', {}, { probe:sourceFree }, sources)), { name:null },
      'a Source-free Adapter is given no Source name, not the ambient one')
  } finally {
    if (old === undefined) delete process.env.RULITH_SOURCE_NAME
    else process.env.RULITH_SOURCE_NAME = old
  }
})
