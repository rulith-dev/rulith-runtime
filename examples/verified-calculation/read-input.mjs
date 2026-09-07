#!/usr/bin/env node
/**
 * Trusted local source adapter: validate one JSON job and emit raw fields only.
 *
 * The task structure this returns is read out of the input file, never out of the
 * environment. An Adapter is handed its execution's own identity (`RULITH_INVOCATION_ID`)
 * and the Source it runs against; it is told no Case, because one execution may be reached
 * by several Cases and which ones is the shared graph's answer, computed from causal reach.
 * An earlier version demanded `RULITH_CASE_ID` and rooted the tree at whatever it found
 * there — a name the Worker hop never sets, so this Adapter refused every real invocation,
 * and on a machine that happened to carry that variable it rooted governed task structure
 * at an operator's string instead.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fail(message) {
  console.error(`calculation input rejected: ${message}`)
  process.exit(2)
}

/**
 * The one place this Adapter may read, and the only thing that decides it.
 *
 * `RULITH_SOURCE_ACCESS` and `RULITH_SOURCE_TYPE` are handed over by the Worker from the
 * governed Source the invocation selected, and the Worker strips every other `RULITH_*` name
 * from an Adapter's environment. There is deliberately no override and no default directory:
 * a per-file `RULITH_CALC_INPUT` let an ambient environment variable point this Adapter at any
 * path on the machine and have the result land on the Board as Source-attested material, and a
 * fallback to a directory beside the script let it read *something* when it had been granted
 * nothing at all. An Adapter with no Source has no place to read, and says so.
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

const INPUT = join(sourceRoot(), 'input.json')

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value)) fail(`${name} must be a safe integer`)
  if (positive ? value <= 0 : value < 0) fail(`${name} is outside the allowed range`)
  return value
}

let input
try {
  input = JSON.parse(readFileSync(INPUT, 'utf8'))
} catch (error) {
  fail(`cannot read valid JSON from ${INPUT}: ${error?.message ?? error}`)
}
if (!input || typeof input !== 'object' || Array.isArray(input)) fail('top level must be one JSON object')
if (typeof input.job_id !== 'string' || !NAME.test(input.job_id)) {
  fail('job_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
}
// The batch this job belongs to, and therefore the root its goal hangs under. It is stated
// by the Source, so a missing one is a refusal: inventing a root here would be this Adapter
// deciding governed task structure that nothing trusted asked for.
if (typeof input.batch_id !== 'string' || !NAME.test(input.batch_id)) {
  fail('batch_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} and names the batch this job is seeded under')
}
const unitPrice = safeInteger(input.unit_price_cents, 'unit_price_cents')
const quantity = safeInteger(input.quantity, 'quantity', { positive: true })
const shipping = safeInteger(input.shipping_cents, 'shipping_cents')
const subtotal = unitPrice * quantity
if (!Number.isSafeInteger(subtotal) || !Number.isSafeInteger(subtotal + shipping)) {
  fail('the exact result would exceed the safe integer range')
}

// Deliberately do not emit subtotal/total. Exact arithmetic belongs to the board closure.
process.stdout.write(JSON.stringify({ rows: [{
  node: `CALC_${input.job_id}`,
  task_root: `CALC_BATCH_${input.batch_id}`,
  acceptance_test: input.job_id,
  job_id: input.job_id,
  unit_price_cents: unitPrice,
  quantity,
  shipping_cents: shipping,
}] }))
