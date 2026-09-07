#!/usr/bin/env node
/** Read-only adapter: attest the persisted output as structured rows. */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

function fail(message) {
  console.error(`calculation read-back rejected: ${message}`)
  process.exit(2)
}

/**
 * The one place this Adapter may read — see `read-input.mjs` for the rule in full.
 *
 * An independent read-back that could be pointed at another file by an ambient variable would
 * attest a match against a file nobody governed, which is the one thing this Adapter exists to
 * make impossible.
 */
function sourceRoot() {
  const access = String(process.env.RULITH_SOURCE_ACCESS ?? '')
  const type = String(process.env.RULITH_SOURCE_TYPE ?? '')
  if (access === '' || !isAbsolute(access)) {
    fail('no governed file Source was supplied. This Adapter reads only the Source root the Worker'
      + ' hands it in RULITH_SOURCE_ACCESS, which is an absolute path; it has no default location'
      + ' and no path override.')
  }
  if (type !== 'file') {
    fail(`the selected Source is of type ${JSON.stringify(type || '(none)')}, and this Adapter reads a file Source.`
      + ' Bind a file Source to the Connection that carries this Tool.')
  }
  return access
}

const OUTPUT = join(sourceRoot(), 'output.json')

let request
try { request = JSON.parse(process.argv[2] ?? '') } catch { fail('worker must pass one JSON argument object') }
if (!request || typeof request !== 'object' || Array.isArray(request)) fail('argument must be one JSON object')
const verificationWork = request.predicate === 'rulith.verified_calculation.output_record'
const args = verificationWork ? request.args : request
if (!args || typeof args !== 'object' || Array.isArray(args)) fail('verification claim must carry one args object')

let stored
try { stored = JSON.parse(readFileSync(OUTPUT, 'utf8')) } catch (error) {
  fail(`output is not readable JSON: ${error?.message ?? error}`)
}
const expected = {
  job_id: args.job_id,
  subtotal_cents: args.subtotal_cents,
  total_cents: args.total_cents,
  status: args.status,
}
const nodeMatches = typeof args.job_id === 'string' && args.node === `CALC_${args.job_id}`
const expectedKeys = Object.keys(expected)
const sameRecord = stored !== null && typeof stored === 'object' && !Array.isArray(stored)
  && Object.keys(stored).length === expectedKeys.length
  && expectedKeys.every((key) => stored[key] === expected[key])
if (!nodeMatches || !sameRecord) fail('persisted output does not exactly match the board-bound result')
if (verificationWork) {
  process.stdout.write(JSON.stringify({
    outcome: 'satisfied',
    tier: 'attested',
  }))
} else {
  process.stdout.write(JSON.stringify({ rows: [{ node: args.node, ...stored }] }))
}
