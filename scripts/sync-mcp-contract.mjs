// SPDX-License-Identifier: Apache-2.0
/**
 * Vendor a contract bundle — but only one whose provenance somebody else has proved.
 *
 * The order matters and is the whole point of this script. A bundle carries its own
 * digests, and digests it computes over itself prove only that it is self-consistent: any
 * file inside it can be edited and re-hashed. What cannot be forged from here is the
 * contract repository's Git object store, so the **first** thing this does is run that
 * repository's own verifier, which resolves the named commit and compares every carried
 * file against the blob it names. Nothing is written unless that exits clean.
 *
 * Only then does the local reader run — for internal coherence, tool projection and the
 * membership repeated in the metadata schema — and only then is the bundle written and the
 * Agent's inline projection regenerated.
 *
 *   node scripts/sync-mcp-contract.mjs <bundle.json> --verifier <contract-repo>/scripts/verify-mcp-contract.mjs
 *
 * The verifier path is required rather than guessed. Assuming where the contract repository
 * lives on somebody's disk is how a "verified" sync quietly becomes an unverified copy on a
 * machine where the guess was wrong.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { BUNDLE_PATH, readContractBundle } from './verify-mcp-contract.mjs'
import { projectionBlock, withProjection } from './generate-mcp-surface.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(name)
  return at < 0 || at + 1 >= argv.length ? undefined : argv[at + 1]
}
const die = (message) => { console.error(`\n✗ ${message}\n`); process.exit(1) }

const source = argv.find((value) => !value.startsWith('--') && argv[argv.indexOf(value) - 1] !== '--verifier')
const verifier = flag('--verifier') ?? process.env.RULITH_CONTRACT_VERIFIER

if (source === undefined) die('Usage: node scripts/sync-mcp-contract.mjs <bundle.json> --verifier <contract-repo>/scripts/verify-mcp-contract.mjs')
if (!existsSync(source)) die(`${source} does not exist.`)
if (verifier === undefined) {
  die('No --verifier was given (or RULITH_CONTRACT_VERIFIER set).'
    + '\n   The bundle\'s own digests prove only that it is self-consistent; the contract repository\'s verifier is what'
    + '\n   resolves the named commit against real Git objects. This script will not vendor a bundle without it.')
}
if (!existsSync(verifier)) die(`The verifier ${verifier} does not exist.`)

// 1. Provenance, proved by the repository that authored the bundle.
const proof = spawnSync(process.execPath, [verifier, source], { encoding: 'utf8' })
if (proof.status !== 0) {
  die(`The contract repository's verifier refused ${source}:\n${proof.stdout ?? ''}${proof.stderr ?? ''}`)
}
process.stdout.write(proof.stdout ?? '')

// 2. Coherence, checked by the reader this Runtime will use at every `npm run check`.
let bundle
try {
  bundle = readContractBundle(JSON.parse(readFileSync(source, 'utf8')), { path: source })
} catch (error) {
  die(`${source} passed provenance but is not a bundle this Runtime can read: ${String(error?.message ?? error)}`)
}

// 3. Write, then regenerate the projection from what was written.
copyFileSync(source, resolve(ROOT, BUNDLE_PATH))
const agent = resolve(ROOT, 'agent', 'rulith-agent.mjs')
writeFileSync(agent, withProjection(readFileSync(agent, 'utf8'), projectionBlock(bundle)))

console.log(`Vendored ${BUNDLE_PATH} from ${bundle.sourceCommit} and regenerated the Agent projection`
  + ` (${bundle.tools.length} tools, MCP ${bundle.protocolVersion}).`
  + '\nRun: npm run manifest && npm run check && npm test')
