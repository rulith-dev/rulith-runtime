// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import Ajv from 'ajv'

// Exercise the executable's actual converter without starting the Agent or a provider.
const source = readFileSync(new URL('../agent/rulith-agent.mjs', import.meta.url), 'utf8')
const start = source.indexOf('function openAIParameters(schema) {')
const end = source.indexOf('\nasync function ask(', start)
assert.ok(start >= 0 && end > start)
const converter = source.slice(start, end)
const convert = new Function(`${converter}; return openAIParameters`)()
const beforePruning = new Function(`${converter.slice(0, converter.indexOf('  const out = expose(schema)'))}
  return expose(schema)
}; return openAIParameters`)()
const bundle = JSON.parse(readFileSync(new URL('../protocol/mcp-contract.json', import.meta.url), 'utf8'))

const samples = {
  Get: [
    {}, { include: ['nodes'], selector: { goals: ['GOAL_1'] } },
    { include: ['history'], selector: { goals: ['GOAL_1'] }, historyOffset: 1 },
    { artifact: { ref: 'artifact-1', offset: 0 } },
    { include: ['nodes'] }, { selector: { goals: [] } }, { include: ['cases'] },
    { include: ['nodes'], selector: { goals: [{}] } },
    { artifact: { ref: '' } }, { artifact: { ref: 'artifact-1', offset: -1 } },
    { artifact: { ref: 'artifact-1' }, include: ['nodes'] },
    { include: ['history'], selector: { goals: ['GOAL_1'] }, historyVersion: 'old' },
  ],
  Set: [
    { intent: 'Record x.', operations: [{ op: 'assert_fact', predicate: 'x', args: { n: 1 } }] },
    { operations: [{ op: 'assert_fact', predicate: 'x', args: { n: 1 } }] },
    { intent: 'Start the work.', operations: [{ op: 'declare_goal', desired: [{ predicate: 'done', args: {} }] }] },
    { intent: 'Break GOAL_1 down.', operations: [{ op: 'declare_goal', desired: [{ predicate: 'done', args: {} }], parent: 'GOAL_1' }] },
    { intent: 'End GOAL_1.', operations: [{ op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled', reason: 'Withdrawn.' }] },
    { operations: [] }, { operations: [{}] }, { operations: [{ op: 'unknown' }] },
    { operations: [{ op: 'declare_goal', desired: [] }] },
    { operations: [{ op: 'end_goal', goal: 'GOAL_1', disposition: 'completed', reason: 'Done.' }] },
    { operations: [{ op: 'end_goal', goal: 'GOAL_1', disposition: 'cancelled' }] },
    { operations: [{ op: 'revise_fact', id: 'F1' }] },
    { operations: [{ op: 'apply_action', action: 'demo.run' }] },
    { operations: [{ op: 'assert_fact', predicate: 'x', args: {}, parent: 'GOAL_1' }] },
  ],
}

for (const name of ['Get', 'Set']) test(`${name}: pruning removes all unreachable definitions and preserves validation`, () => {
  const native = bundle.tools.find(tool => tool.name === name).inputSchema
  const saved = structuredClone(native)
  const expanded = beforePruning(native)
  const pruned = convert(native)
  assert.ok(Object.keys(native.$defs).length > 0)
  assert.equal(Object.hasOwn(pruned, '$defs'), false)
  assert.deepEqual(pruned, (({ $defs, ...active }) => active)(expanded), 'only definitions may change')
  assert.deepEqual(native, saved, 'native schemas retain their definitions and wording')
  const ajv = new Ajv({ strict: false })
  const validators = [native, expanded, pruned].map(schema => ajv.compile(schema))
  const outcomes = samples[name].map(value => validators[0](value))
  assert.ok(outcomes.includes(true) && outcomes.includes(false), 'cover valid and invalid inputs')
  for (const value of samples[name]) {
    assert.equal(validators[1](value), validators[0](value), JSON.stringify(value))
    assert.equal(validators[2](value), validators[0](value), JSON.stringify(value))
  }
  const savedCharacters = JSON.stringify(expanded).length - JSON.stringify(pruned).length
  console.log(`${name}: ${savedCharacters} characters saved per OpenAI request`)
})

test('recursive and transitive definition references survive, while an unreachable cycle is removed', () => {
  const native = {
    type: 'object', additionalProperties: { $ref: '#/$defs/A' },
    $defs: {
      A: { type: 'object', properties: { next: { $ref: '#/$defs/B' } } },
      B: { type: 'object', properties: { next: { $ref: '#/$defs/A' } } },
      Dead: { $ref: '#/$defs/AlsoDead' }, AlsoDead: { $ref: '#/$defs/Dead' },
    },
  }
  const shaped = convert(native)
  assert.deepEqual(Object.keys(shaped.$defs), ['A', 'B'])
  const ajv = new Ajv({ strict: false })
  const before = ajv.compile(native), after = ajv.compile(shaped)
  for (const value of [{}, { x: { next: { next: {} } } }, { x: 1 }, { x: { next: 1 } }]) {
    assert.equal(after(value), before(value), JSON.stringify(value))
  }
})

test('escaped definition names and subpaths remain reachable, and constrained unions keep their meaning', () => {
  const native = {
    type: 'object', properties: {
      path: { $ref: '#/$defs/a~1b~0c/properties/value' },
      choice: { anyOf: [{ const: 'a', type: 'number' }, { const: 'b', type: 'string' }] },
    },
    $defs: { 'a/b~c': { properties: { value: { type: 'string', minLength: 1 } } }, Dead: { type: 'number' } },
  }
  const shaped = convert(native)
  assert.deepEqual(Object.keys(shaped.$defs), ['a/b~c'])
  const ajv = new Ajv({ strict: false })
  const before = ajv.compile(native), after = ajv.compile(shaped)
  for (const value of [{ path: 'x', choice: 'b' }, { path: '' }, { path: 1 }, { choice: 'a' }]) {
    assert.equal(after(value), before(value), JSON.stringify(value))
  }
  assert.equal(after({ choice: 'a' }), false)
})

test('references through a resource ID retain definitions conservatively', () => {
  const native = {
    type: 'object', properties: { value: { $ref: 'https://schemas.example/kept' } },
    $defs: { Kept: { $id: 'https://schemas.example/kept', type: 'string', minLength: 1 } },
  }
  const shaped = convert(native)
  assert.deepEqual(shaped.$defs, native.$defs)
  const before = new Ajv({ strict: false }).compile(native)
  const after = new Ajv({ strict: false }).compile(shaped)
  for (const value of [{ value: 'x' }, { value: '' }, { value: 1 }]) {
    assert.equal(after(value), before(value), JSON.stringify(value))
  }
})
