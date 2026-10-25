// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { localToolSnapshot } from '../agent/local-trace.mjs'

test('large results are explicitly truncated and never split a UTF-8 character', () => {
  const snapshot = localToolSnapshot({ text: '中文'.repeat(100) }, 53)
  assert.equal(snapshot.truncated, true)
  assert.ok(snapshot.totalBytes > 53)
  assert.doesNotMatch(snapshot.text, /�/)
  const small = localToolSnapshot({ accepted: true, result: { nodeIds: ['n1'] } })
  assert.equal(small.truncated, false)
  assert.match(small.text, /nodeIds/)
})
