#!/usr/bin/env node
/** Bound action adapter: verify the board result, atomically write it, then read it back. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTPUT = process.env.RULITH_CALC_OUTPUT ?? join(HERE, 'data', 'output.json')

function fail(message) {
  console.error(`calculation output rejected: ${message}`)
  process.exit(2)
}

function safeInteger(value, name, { positive = false } = {}) {
  if (!Number.isSafeInteger(value)) fail(`${name} must be a safe integer`)
  if (positive ? value <= 0 : value < 0) fail(`${name} is outside the allowed range`)
  return value
}

let args
try { args = JSON.parse(process.argv[2] ?? '') } catch { fail('worker must pass one JSON argument object') }
if (!args || typeof args !== 'object' || Array.isArray(args)) fail('argument must be one JSON object')
if (typeof args.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.job_id)) fail('invalid job_id')
if (args.node !== `CALC_${args.job_id}`) fail('node and job_id do not match')

const unitPrice = safeInteger(args.unit_price_cents, 'unit_price_cents')
const quantity = safeInteger(args.quantity, 'quantity', { positive: true })
const shipping = safeInteger(args.shipping_cents, 'shipping_cents')
const subtotal = safeInteger(args.subtotal_cents, 'subtotal_cents')
const total = safeInteger(args.total_cents, 'total_cents')
const expectedSubtotal = unitPrice * quantity
const expectedTotal = expectedSubtotal + shipping
if (!Number.isSafeInteger(expectedSubtotal) || !Number.isSafeInteger(expectedTotal)) fail('exact result exceeds safe integer range')
if (subtotal !== expectedSubtotal || total !== expectedTotal) {
  fail(`board result does not match source inputs: expected ${expectedSubtotal}/${expectedTotal}, got ${subtotal}/${total}`)
}

const output = { job_id: args.job_id, subtotal_cents: subtotal, total_cents: total, status: 'completed' }
mkdirSync(dirname(OUTPUT), { recursive: true })
if (existsSync(OUTPUT)) {
  let prior
  try { prior = JSON.parse(readFileSync(OUTPUT, 'utf8')) } catch { fail(`existing output ${OUTPUT} is not valid JSON`) }
  if (JSON.stringify(prior) !== JSON.stringify(output)) fail(`existing output ${OUTPUT} belongs to a different result; refusing overwrite`)
} else {
  const temp = `${OUTPUT}.${process.pid}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(output, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, OUTPUT)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* best-effort cleanup */ }
    fail(`atomic write failed: ${error?.message ?? error}`)
  }
}

let readBack
try { readBack = JSON.parse(readFileSync(OUTPUT, 'utf8')) } catch (error) { fail(`read-back failed: ${error?.message ?? error}`) }
if (JSON.stringify(readBack) !== JSON.stringify(output)) fail('read-back content differs from the intended output')
process.stdout.write(JSON.stringify({ rows: [{ node: args.node, ...readBack }] }))
