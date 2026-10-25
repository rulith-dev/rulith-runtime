// SPDX-License-Identifier: Apache-2.0
/**
 * Model-command isolation (D-1024a): the manager names, for every Worker it starts, its own home and the instance id.
 *
 * A Worker derives the credential roots it verifies before every command, and the holder under which it releases the
 * project labels an open recorded, from these two values. Deriving them from the instance directory alone fails for an
 * instance kept outside the manager home (no registry above it; its directory name is not its id), so the host passes
 * them explicitly. The stand-in Worker reports the environment it was actually given.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolve } from 'node:path'

import { addInstance, starts, startWorker, withManager } from './support/tool-library-fixture.mjs'

test('the manager names its home and the instance id to every Worker it starts', async (t) => {
  await withManager(t, async ({ manager, root }) => {
    const instance = await addInstance(manager, 'Desk', { agentId: 'agent-alpha' })
    await startWorker(manager, instance.id)
    const observed = starts(manager, instance.id).at(-1).observed
    assert.equal(observed.RULITH_MANAGER_HOME, resolve(root))
    assert.equal(observed.RULITH_INSTANCE_ID, instance.id)
    assert.equal(observed.RULITH_CONFINEMENT_REFUSAL, undefined, 'no refusal recorded without a confinement problem')
  })
})
