import assert from 'node:assert/strict'
import test from 'node:test'
import { DONE, HOLD, driveWorker, sourceFreeActionRow } from './support/worker-harness.mjs'

// A signed row is not proof that this binary implements the declared input contract.
// Exercise the real Worker and adapter write log; rejection must precede ClaimWork.
for (const [name, fields] of [
  ['roles', { inputRoles: { value: { role: 'grounded' } } }],
  ['catalog without roles', { guardCatalogDigest: 'sha256:' + 'a'.repeat(64) }],
  ['nested roles', { execution: { inputRoles: { value: { role: 'grounded' } } } }],
  ['nested malformed catalog', { execution: { guardCatalogDigest: null } }],
]) {
  test(`unadopted ${name} cannot silently become legacy execution`, async () => {
    let polls = 0
    const run = await driveWorker({
      reply: operation => operation.kind === 'Poll'
        ? (++polls === 1 ? { body: { accepted: true, payload: { work: [sourceFreeActionRow({
            args: '{"value":7}',
            toolSpec: JSON.stringify({ impl: 'worker-tool', exec: 'acme.compute@1', kind: 'read',
              params: { value: 'number' }, sourceTypes: [], ...fields }),
          })] } } } : HOLD)
        : { body: { accepted: true, revision: 'b12' } },
      done: (_, output) => /Action v2|Action inputRoles|Action inputRoles belong/.test(output) || DONE.action.test(output),
      timeoutMs: 15_000,
    })
    assert.equal(run.timedOut, false, run.output)
    assert.equal(run.ran('compute'), 0, 'the adapter executed an input contract this Worker does not implement')
    assert.equal(run.of('ClaimWork').length, 0, 'an unavailable input contract was already claimed')
    assert.equal(run.of('ReportWork').length, 0, 'refusal must not manufacture an execution receipt')
    assert.match(run.output, /Action v2|Action inputRoles|Action inputRoles belong/)
  })
}
