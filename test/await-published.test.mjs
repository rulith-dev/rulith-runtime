// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict'
import test from 'node:test'

import { awaitPublished } from '../scripts/await-published.mjs'

test('awaitPublished waits for the version and then its requested dist-tag', async () => {
  const version = '1.2.3'
  const calls = []
  const progress = []
  let clock = 0
  let versionCalls = 0
  let tagCalls = 0

  await awaitPublished({
    version,
    view: async args => {
      calls.push(args)
      if (args[1] === `rulith@${version}`) {
        versionCalls += 1
        if (versionCalls <= 2) throw new Error('not visible yet')
        return version
      }
      tagCalls += 1
      return { next: tagCalls === 1 ? '1.2.2' : version }
    },
    sleep: async milliseconds => { clock += milliseconds },
    now: () => clock,
    timeoutMs: 120_000,
    onProgress: line => progress.push(line),
  })

  assert.equal(versionCalls, 4)
  assert.equal(tagCalls, 2)
  assert.equal(progress.length, 4)
  assert.deepEqual(calls[0], ['view', `rulith@${version}`, 'version', '--json', '--prefer-online'])
  assert.deepEqual(calls[3], ['view', 'rulith', 'dist-tags', '--json', '--prefer-online'])
})

test('awaitPublished stops at its timeout', async () => {
  let clock = 0
  let polls = 0
  await assert.rejects(awaitPublished({
    version: '1.2.3',
    view: async () => { polls += 1; throw new Error('not visible yet') },
    sleep: async milliseconds => { clock += milliseconds },
    now: () => clock,
    timeoutMs: 30_000,
    onProgress: () => {},
  }), /Timed out waiting for rulith@1\.2\.3 and the next tag to appear on npm/)
  assert.equal(polls, 2)
})
