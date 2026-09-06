// SPDX-License-Identifier: Apache-2.0
/**
 * The vendored cross-repository MCP contract, and what this Runtime will accept as one.
 *
 * `protocol/mcp-contract.json` is the bundle the contract repository exported from a named
 * commit and verified against its own Git objects. Core, Cloud and this Runtime read that
 * one artefact instead of keeping three lists that happen to agree, and the Agent's public
 * surface is compiled from it rather than typed out beside it.
 *
 * Every arm below mutates the **real** bundle rather than a hand-built stand-in. A fixture
 * invented here would be a fourth copy of the contract, and a guard that only ever sees its
 * own invention proves nothing about the file that ships.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BUNDLE_PATH, ContractError, loadContractBundle, readContractBundle } from '../scripts/verify-mcp-contract.mjs'
import { projectionBlock, withProjection } from '../scripts/generate-mcp-surface.mjs'
import { MCP_SURFACE, MODEL_TOOLS } from './support/agent-harness.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')
const RAW = JSON.parse(readFileSync(join(ROOT, BUNDLE_PATH), 'utf8'))
/** A deep copy of the real bundle, for an arm to spoil in exactly one way. */
const bundleWith = (mutate) => {
  const copy = JSON.parse(JSON.stringify(RAW))
  mutate(copy)
  return copy
}

test('RT-CONTRACT-1 the vendored bundle is what this Runtime speaks', () => {
  const bundle = loadContractBundle(ROOT)
  assert.match(bundle.sourceCommit, /^[0-9a-f]{40}$/u, 'the vendored contract names no commit')
  assert.deepEqual(bundle.tools.map((tool) => ({ name: tool.name, target: tool.target })), MCP_SURFACE,
    'the harness and the vendored contract disagree about the tool surface')
  assert.deepEqual(MODEL_TOOLS, bundle.tools.map((tool) => tool.name))
  // Everything the Runtime compiles in comes from here, not from a constant beside it.
  assert.equal(typeof bundle.protocolVersion, 'string')
  assert.equal(typeof bundle.metadataNamespace, 'string')
  assert.ok(bundle.recoveryStates.includes('none') && bundle.recoveryStates.includes('waiting'))
  assert.equal(bundle.clientCapabilities.serialRecovery, 1)
  for (const { inputSchema } of bundle.schemas) {
    assert.equal(inputSchema.$schema, 'http://json-schema.org/draft-07/schema#',
      'a served schema does not declare its dialect explicitly')
  }
  assert.ok(bundle.queryProfiles.agent && bundle.queryProfiles.operator && bundle.queryProfiles.internal)
  assert.ok(bundle.queryContext.properties?.audienceProfile, 'the protected query context is part of the contract')
})

test('RT-CONTRACT-2 the Agent source is the projection of that bundle, and drift is caught', () => {
  // The Agent ships as one file, so the surface is compiled in rather than read at startup.
  // That is only safe if the compiled copy cannot quietly diverge from its source.
  const bundle = loadContractBundle(ROOT)
  const source = readFileSync(join(ROOT, 'agent', 'rulith-agent.mjs'), 'utf8')
  assert.equal(withProjection(source, projectionBlock(bundle)), source,
    'agent/rulith-agent.mjs has drifted from protocol/mcp-contract.json; run node scripts/generate-mcp-surface.mjs')
  assert.ok(source.includes(`const RULITH_CONTRACT_SOURCE_COMMIT = '${bundle.sourceCommit}'`),
    'the Agent does not name the contract commit it was generated from')
  // And the projection is one-directional: nothing reads the inline block back as a source.
  const generator = readFileSync(join(ROOT, 'scripts', 'generate-mcp-surface.mjs'), 'utf8')
  assert.doesNotMatch(generator, /RULITH_MCP_SURFACE = Object\.freeze\(\[\n  Object/u,
    'the generator carries its own copy of the surface instead of reading the bundle')
})

for (const [label, mutate, expected] of [
  ['a short commit id', (b) => { b.sourceCommit = 'abc1234' }, /not a full 40-character commit id/],
  ['another bundle schema', (b) => { b.schema = 'rulith-mcp-contract-bundle/v2' }, /this Runtime reads rulith-mcp-contract-bundle\/v1/],
  ['no files', (b) => { b.files = {} }, /carries no files/],
  ['no surface', (b) => { delete b.surface }, /carries no surface projection/],
  ['no metadata schema', (b) => { delete b.metadata }, /carries no host metadata schema/],
  ['no audience profiles', (b) => { delete b.queryProfiles }, /carries no queryProfiles/],
  ['no query context', (b) => { delete b.queryContext }, /carries no queryContext/],
]) {
  test(`RT-CONTRACT-3 a bundle with ${label} is refused`, () => {
    assert.throws(() => readContractBundle(bundleWith(mutate)), (error) => {
      assert.ok(error instanceof ContractError, `refused with the wrong error type: ${error}`)
      assert.match(error.message, expected)
      return true
    })
  })
}

test('RT-CONTRACT-4 content that does not match its recorded digest refuses the whole bundle', () => {
  // A bundle read "as far as it goes" would let one repository's edit reach the other two
  // unnoticed, which is what having one artefact was supposed to prevent.
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.files['protocol/operations.json'].content += '\n'
  })), (error) => {
    assert.match(error.message, /does not match the digest recorded beside it/)
    assert.match(error.message, /refused whole rather than in part/)
    return true
  })
})

test('RT-CONTRACT-5 a surface beside the hashed file, rather than of it, is refused', () => {
  // Membership must be the hashed bytes. A `surface` block that has been edited while the
  // carried `protocol/mcp-surface.json` stayed put is a seventh tool one digest short of
  // being noticed.
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.surface.tools.push({ name: 'SealBoard', target: 'core', operation: 'SealBoard' })
  })), /the surface projection differs from the carried protocol\/mcp-surface.json/)
})

test('RT-CONTRACT-6 a rewritten tool projection cannot ride along on unchanged file digests', () => {
  // The attack this closes: leave every file and its digest exactly as exported, and change
  // only the materialized schema the Gateway would serve. The digests all still match.
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    const applyBatch = bundle.tools.find((tool) => tool.name === 'ApplyBatch')
    applyBatch.inputSchema.properties.viewToken = { type: 'string' }
  })), (error) => {
    assert.match(error.message, /materialized schema no longer matches/)
    assert.match(error.message, /may not ride along on unchanged file digests/)
    return true
  })
  // The same for a requirement that quietly disappears.
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.tools.find((tool) => tool.name === 'CloseCase').inputSchema.required = []
  })), /materialized schema no longer matches/)
})

test('RT-CONTRACT-7 a tool the surface does not declare, or a moved target, is refused', () => {
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.tools.find((tool) => tool.name === 'ReadArtifact').target = 'core'
  })), /does not match the declared/)
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.tools.pop()
  })), /materialized tool\(s\) against/)
})

test('RT-CONTRACT-8 a membership the metadata schema does not repeat is refused', () => {
  // `ToolName` is the same list again, in the schema the Gateway validates its own metadata
  // against. Two lists that can disagree are two contracts.
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    bundle.metadata.$defs.ToolName.enum = bundle.metadata.$defs.ToolName.enum.slice(0, 3)
  })), /is not the tool membership/)
})

test('RT-CONTRACT-9 a materialized schema without an explicit dialect is refused', () => {
  assert.throws(() => readContractBundle(bundleWith((bundle) => {
    delete bundle.tools.find((tool) => tool.name === 'QueryBoard').inputSchema.$schema
  })), /does not declare draft-07 explicitly/)
})

test('RT-CONTRACT-10 a missing bundle is an error, not a fallback', () => {
  // There is no hand-written membership to fall back to and no "not vendored yet" branch:
  // a Runtime that cannot read the contract does not know what its public surface is.
  assert.throws(() => loadContractBundle(join(ROOT, 'test')), (error) => {
    assert.ok(error instanceof ContractError)
    assert.match(error.message, /could not be read/)
    assert.match(error.message, /not optional and there is nothing to fall back to/)
    return true
  })
  // And the CLI has no branch that reports success without one. (The prose above the code
  // says the same thing; the scan is of the code, with the doc comment removed.)
  const verifier = readFileSync(join(ROOT, 'scripts', 'verify-mcp-contract.mjs'), 'utf8')
    .replace(/\/\*\*[\s\S]*?\*\//gu, '')
  assert.doesNotMatch(verifier, /not vendored yet|undefined\) return undefined|process\.exitCode = 0/u,
    'the verifier still has a branch that passes without a contract')
  assert.ok(existsSync(join(ROOT, BUNDLE_PATH)), 'the contract this package ships without is not shipped')
})

test('RT-CONTRACT-11 vendoring requires the contract repository\'s own verifier', () => {
  // Digests a bundle computes over itself prove only that it is self-consistent. Provenance
  // is the contract repository's Git object store, so the sync refuses to write without the
  // verifier that reads it — and it runs that verifier before anything is written.
  const sync = readFileSync(join(ROOT, 'scripts', 'sync-mcp-contract.mjs'), 'utf8')
  assert.match(sync, /This script will not vendor a bundle without it/)
  const proof = sync.indexOf('spawnSync(process.execPath, [verifier')
  const write = sync.indexOf('copyFileSync(source')
  assert.ok(proof > 0 && write > proof, 'the bundle is written before its provenance is proved')
})
