#!/usr/bin/env node
/** Read-only adapter: attest the persisted output as structured rows. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE_ROOT = process.env.RULITH_SOURCE_ACCESS ?? join(HERE, 'data')
const OUTPUT = process.env.RULITH_CALC_OUTPUT ?? join(SOURCE_ROOT, 'output.json')

function fail(message) {
  console.error(`calculation read-back rejected: ${message}`)
  process.exit(2)
}

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
