// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import test from 'node:test'
import { publishedArtifactPath } from '../scripts/published-artifact-path.mjs'

const root = resolve('published-package-fixture')
test('published manifest keys cannot read outside the installed package', () => {
  assert.equal(publishedArtifactPath(root, 'agent/rulith-agent.mjs'), join(root, 'agent', 'rulith-agent.mjs'))
  for (const file of [
    '../secret', 'agent/../../secret', 'agent/../secret', 'agent/./secret',
    '/etc/passwd', 'C:/Windows/system.ini', 'agent\\secret', 'agent//secret',
    'agent/secret:stream', 'agent/secret\nname', '.', '', null,
  ]) {
    assert.throws(() => publishedArtifactPath(root, file), /unsafe artifact-manifest path/,
      `downloaded manifest key ${JSON.stringify(file)} escaped validation`)
  }
})
