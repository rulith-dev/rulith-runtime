#!/usr/bin/env node
/** Trusted local source adapter: validate one JSON job and emit raw fields only. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INPUT = process.env.RULITH_CALC_INPUT ?? join(HERE, 'data', 'input.json')

function fail(message) {
  console.error(`calculation input rejected: ${message}`)
  process.exit(2)
}

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
if (typeof input.job_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.job_id)) {
  fail('job_id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}')
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
  task_root: 'CALCULATION_CASE',
  acceptance_test: input.job_id,
  job_id: input.job_id,
  unit_price_cents: unitPrice,
  quantity,
  shipping_cents: shipping,
}] }))
