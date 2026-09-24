// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from 'ajv'
import { fitsShape, shapeFaults } from './support/contract-shape.mjs'

const ajv = new Ajv({ strict: false })

test('shape checker agrees with JSON Schema on allOf, oneOf, contains, and conditionals', () => {
  const cases = [
    [{ allOf: [{ type: 'string' }, { pattern: '^x' }] }, 'xyz', true],
    [{ allOf: [{ type: 'string' }, { pattern: '^x' }] }, 'abc', false],
    [{ oneOf: [{ const: 'a' }, { enum: ['a', 'b'] }] }, 'a', false],
    [{ oneOf: [{ const: 'a' }, { enum: ['a', 'b'] }] }, 'b', true],
    [{ oneOf: [{ const: 'a' }, { enum: ['a', 'b'] }] }, 'c', false],
    [{ type: 'array', contains: { const: 'db' } }, ['file', 'db'], true],
    [{ type: 'array', contains: { const: 'db' } }, ['file'], false],
    [{ type: 'array', contains: { const: 'db' } }, [], false],
    [{ if: { properties: { kind: { const: 'write' } }, required: ['kind'] },
      then: { required: ['adapter'] }, else: { not: { required: ['adapter'] } } },
    { kind: 'write', adapter: 'db-exec-fenced' }, true],
    [{ if: { properties: { kind: { const: 'write' } }, required: ['kind'] },
      then: { required: ['adapter'] }, else: { not: { required: ['adapter'] } } },
    { kind: 'write' }, false],
  ]
  for (const [schema, value, expected] of cases) {
    assert.equal(ajv.validate(schema, value), expected)
    assert.equal(fitsShape(value, schema, {}), expected, JSON.stringify({ schema, value }))
  }
})

test('canonical WorkerToolDescriptor enforces the DB adapter and kind pairs', () => {
  const bundle = JSON.parse(readFileSync(new URL('../protocol/worker-contract.json', import.meta.url), 'utf8'))
  const schema = JSON.parse(bundle.files['docs/specs/schemas/rulith-worker-protocol-v2.schema.json'].content)
  const defs = schema.$defs
  const descriptor = defs.WorkerToolDescriptor
  const validate = ajv.compile({ ...descriptor, $defs: defs })
  const base = { id: 'acme.records@1', digest: 'a'.repeat(64), sourceTypes: ['db'],
    kind: 'read', params: {}, returns: [] }
  for (const [change, expected] of [
    [{ adapter: 'db-query' }, true],
    [{ adapter: 'db-exec-fenced', kind: 'write' }, true],
    [{ adapter: 'db-query', kind: 'write' }, false],
    [{ adapter: 'db-exec-fenced', kind: 'read' }, false],
    [{}, false],
    [{ adapter: 'run' }, false],
    [{ sourceTypes: [], kind: 'run' }, true],
    [{ sourceTypes: ['file'], kind: 'read' }, true],
  ]) {
    const value = { ...base, ...change }
    assert.equal(validate(value), expected, JSON.stringify(value))
    assert.equal(fitsShape(value, descriptor, defs), expected, JSON.stringify(value))
  }
})

test('unknown keywords fail closed even in an unselected branch or empty contains', () => {
  assert.match(shapeFaults('b', { oneOf: [{ const: 'a', unhandledRule: true }, { const: 'b' }] }, {}).join(' '), /unhandledRule/)
  assert.match(shapeFaults([], { contains: { const: 'db', unhandledRule: true } }, {}).join(' '), /unhandledRule/)
  assert.match(shapeFaults({}, { if: { const: 'x' }, then: { unhandledRule: true } }, {}).join(' '), /unhandledRule/)
  assert.match(shapeFaults('x', { allOf: {} }, {}).join(' '), /allOf must be an array/)
})
