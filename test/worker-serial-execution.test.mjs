// SPDX-License-Identifier: Apache-2.0
/**
 * ACC-CONV-03 (PSC 0.2.16, D-1015b): conversations of one Agent each have their own Board, but
 * Worker execution stays one at a time per Connection.
 *
 * The Gateway hands out work and holds its per-Connection lock only while a claim is made; it
 * does not refuse a second claim on the same Connection before the first is reported. One at a
 * time is this Worker's own discipline (owner decision 2026-10-18: the guarantee belongs to the
 * Runtime, which protects the user's computer): it claims an item, runs it, files the receipt,
 * and only then claims the next. This arm hands it two slow actions from two conversation Boards
 * on the same Connection in a single poll answer and checks the order on the wire and on the
 * computer.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DONE, HOLD, actionRow, driveWorker, toolDigest } from './support/worker-harness.mjs'

const SERIAL = {
  'serial-adapter.mjs':
    "import { appendFileSync } from 'node:fs'\n"
    + "const { tag } = JSON.parse(process.argv[2] ?? '{}')\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'start ' + tag + '\\n')\n"
    + "await new Promise((done) => setTimeout(done, 600))\n"
    + "appendFileSync(process.env.P2_EFFECT_LOG, 'end ' + tag + '\\n')\n"
    + "process.stdout.write(JSON.stringify({ rows: [] }))\n",
}

const serialRow = (board, work, tag) => actionRow({
  boardId: board,
  work,
  tool: 'acme.serial',
  toolContractId: 'acme.serial@1',
  toolDigest: toolDigest({ adapter: 'run', sourceTypes: ['file'], entry: 'serial-adapter.mjs' }),
  toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.serial@1', kind: 'act', params: { tag: 'string' }, sourceTypes: ['file'] }),
  args: JSON.stringify({ source: 'orders', tag }),
})

test('RT-WK-SERIAL-1 two conversation Boards on one Connection: the second action is claimed only after the first is reported, and they never run at once', async () => {
  let polls = 0
  const run = await driveWorker({
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        return ++polls === 1
          ? { body: { accepted: true, payload: { work: [
            serialRow('board-p2~c-conversation-a', 'inv_conv_a', 'a'),
            serialRow('board-p2~c-conversation-b', 'inv_conv_b', 'b'),
          ] } } }
          : HOLD
      }
      if (operation.kind === 'ClaimWork' || operation.kind === 'ReportWork') return { body: { accepted: true, revision: 'b12' } }
      return undefined
    },
    extraAdapters: SERIAL,
    extraTools: { 'acme.serial@1': { adapter: 'run', sourceTypes: ['file'], entry: 'serial-adapter.mjs' } },
    done: (seen, output) => (output.match(new RegExp(DONE.action.source, 'g')) ?? []).length >= 2,
    timeoutMs: 30_000,
  })
  assert.equal(run.timedOut, false, run.output)

  // On the wire: claim a, report a, claim b, report b — never a second claim while one is out.
  const hops = run.seen
    .filter((entry) => entry.operation.kind === 'ClaimWork' || entry.operation.kind === 'ReportWork')
    .map((entry) => `${entry.operation.kind} ${entry.operation.id}`)
  assert.deepEqual(hops, ['ClaimWork inv_conv_a', 'ReportWork inv_conv_a', 'ClaimWork inv_conv_b', 'ReportWork inv_conv_b'],
    `the Worker claimed a second action of this Connection before reporting the first:\n${run.output}`)
  // On the computer: the two executions do not overlap.
  assert.deepEqual(run.effects, ['start a', 'end a', 'start b', 'end b'], 'two actions of one Connection ran at the same time')
})
