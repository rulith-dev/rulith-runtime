// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path))
const pin = JSON.parse(read('protocol/worker-selected-material-overlay-pin.json'))
const schemaBytes = read('protocol/worker-selected-material.schema.json')
const oldPin = JSON.parse(read('protocol/worker-selected-material-overlay-pin-v1.json'))
const oldSchemaBytes = read('protocol/worker-selected-material-v1.schema.json')
const priorPin = JSON.parse(read('protocol/worker-selected-material-overlay-pin-v2.json'))
const priorSchemaBytes = read('protocol/worker-selected-material-v2.schema.json')
const schema = JSON.parse(schemaBytes)
const base = JSON.parse(read('protocol/worker-contract.json'))
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const fail = message => { throw new Error(`selected material overlay: ${message}`) }
const CANONICAL_OVERLAY_SHA256 = 'sha256:9b2a4f87d7cd0ce18520bcd06606e7896ba3f919b5b25186db43baf7a1b0f2e5'
const CANONICAL_PRIOR_OVERLAY_SHA256 = 'sha256:f7a0e3ea90f8d94d1698b469d9bc7c75a956c51000399a7876d9506782e173f6'
const CANONICAL_OLD_OVERLAY_SHA256 = 'sha256:4ef69f2735b23ea7163af55a90a7b881f8d4bcaaeae7066906233c9540768a3e'
const CANONICAL_BASE_SHA256 = 'sha256:6b8d46675c2104ca814ec54c466133474a7160d04214a2d3d51fc389ff5d16be'
// D-1013c added the separate Gateway review arm to the v2 schema and D-1013f (PSC 0.2.8)
// reshaped only that arm (post-call `call`, no block reply). Historical selected material
// pins still name their original base; accept this exact committed amendment (spec
// ee6fb706) as the compatible current base without rewriting any of those immutable pins.
const REVIEW_AMENDED_BASE_SHA256 = 'sha256:6410b8cef586835519d70bdd666c2121f842039be1d6bbc1db0bad029f46f3b8'

if (pin.version !== 'rulith-worker-selected-material-overlay-pin/3'
    || pin.schemaPath !== 'docs/specs/schemas/rulith-worker-selected-material-v3.schema.json'
    || pin.baseSchemaPath !== 'docs/specs/schemas/rulith-worker-protocol-v2.schema.json'
    || pin.productionAdopted !== false) fail('unexpected pin metadata')
if (pin.schemaSha256 !== CANONICAL_OVERLAY_SHA256
    || pin.baseSchemaSha256 !== CANONICAL_BASE_SHA256) fail('pin differs from immutable canonical digest')
if (digest(schemaBytes) !== pin.schemaSha256) fail('schema bytes differ from canonical pin')
if (oldPin.version !== 'rulith-worker-selected-material-overlay-pin/1'
    || oldPin.schemaPath !== 'docs/specs/schemas/rulith-worker-selected-material-v1.schema.json'
    || oldPin.schemaSha256 !== CANONICAL_OLD_OVERLAY_SHA256
    || oldPin.baseSchemaSha256 !== CANONICAL_BASE_SHA256
    || oldPin.productionAdopted !== false
    || digest(oldSchemaBytes) !== oldPin.schemaSha256) fail('historical v1 overlay pin changed')
if (priorPin.version !== 'rulith-worker-selected-material-overlay-pin/2'
    || priorPin.schemaPath !== 'docs/specs/schemas/rulith-worker-selected-material-v2.schema.json'
    || priorPin.schemaSha256 !== CANONICAL_PRIOR_OVERLAY_SHA256
    || priorPin.baseSchemaSha256 !== CANONICAL_BASE_SHA256
    || priorPin.productionAdopted !== false
    || digest(priorSchemaBytes) !== priorPin.schemaSha256) fail('historical v2 overlay pin changed')
const baseFile = base.files[pin.baseSchemaPath]
if (![pin.baseSchemaSha256, REVIEW_AMENDED_BASE_SHA256].includes(baseFile?.sha256)
    || digest(Buffer.from(baseFile.content, 'utf8')) !== baseFile.sha256) fail('base Worker contract differs from the pinned compatible bases')
const defs = schema.$defs
const grant = defs?.SelectedMaterialExecutionGrant
const input = defs?.SelectedMaterialInput
const row = defs?.SelectedMaterialActionWorkItem
const source = defs?.SourceBinding
if (grant?.properties?.version?.const !== 4
    || JSON.stringify(Object.keys(grant.properties)) !== JSON.stringify([
      'version', 'boardId', 'invocationId', 'actionId', 'toolContractId', 'sourceRecordId',
      'connectionId', 'workerId', 'workerGeneration', 'adapterDigest', 'requestDigest', 'materialBindingDigest', 'sourceBindingDigest',
    ])
    || JSON.stringify(input?.required) !== JSON.stringify([
      'selector', 'digest', 'custodyId', 'totalBytes', 'deviceId', 'bindingDigest',
    ])
    || row?.properties?.materialInput?.$ref !== '#/$defs/SelectedMaterialInput'
    || !row.required.includes('completionRequirement')
    || !row.required.includes('sourceBinding')
    || row.properties.sourceBinding?.$ref !== '#/$defs/SourceBinding'
    || JSON.stringify(source?.required) !== JSON.stringify(['version', 'sourceRecordId', 'connectionId', 'access'])
    || source.properties.version?.const !== 'rulith-http-source-binding/1'
    || row.properties.completionRequirement?.properties?.stage?.const !== 'terminal') fail('overlay shape changed')
console.log('selected material overlay: canonical schema and v2 base are pinned')
