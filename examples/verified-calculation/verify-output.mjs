#!/usr/bin/env node
/** Read-only discharge adapter: verify that the persisted output exactly matches the claim. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT = process.env.RULITH_CALC_OUTPUT ?? join(HERE, 'data', 'output.json')

function respond(outcome, reason) {
  process.stdout.write(JSON.stringify({
    outcome,
    ...(outcome === 'satisfied' ? { evidence: `read-back matched ${OUTPUT}` } : { reason }),
  }))
}

let body
try { body = JSON.parse(process.argv[2] ?? '') } catch {
  respond('error', 'verification worker must pass one JSON claim object')
  process.exit(0)
}
const args = body?.predicate === 'output_record' && body?.args && typeof body.args === 'object'
  ? body.args
  : undefined
if (!args) {
  respond('error', 'expected an output_record claim')
  process.exit(0)
}

let stored
try { stored = JSON.parse(readFileSync(OUTPUT, 'utf8')) } catch (error) {
  respond('not_satisfied', `output is not readable JSON: ${error?.message ?? error}`)
  process.exit(0)
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
if (!nodeMatches || !sameRecord) {
  respond('not_satisfied', 'persisted output does not exactly match the board claim')
  process.exit(0)
}
respond('satisfied')
