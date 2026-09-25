// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = path => readFileSync(resolve(root, path))
const pin = JSON.parse(read('protocol/worker-selected-material-overlay-pin.json'))
const schemaBytes = read('protocol/worker-selected-material.schema.json')
const schema = JSON.parse(schemaBytes)
const base = JSON.parse(read('protocol/worker-contract.json'))
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const fail = message => { throw new Error(`selected material overlay: ${message}`) }

if (pin.version !== 'rulith-worker-selected-material-overlay-pin/1'
    || pin.schemaPath !== 'docs/specs/schemas/rulith-worker-selected-material-v1.schema.json'
    || pin.baseSchemaPath !== 'docs/specs/schemas/rulith-worker-protocol-v2.schema.json'
    || pin.productionAdopted !== false) fail('unexpected pin metadata')
if (digest(schemaBytes) !== pin.schemaSha256) fail('schema bytes differ from canonical pin')
if (base.files[pin.baseSchemaPath]?.sha256 !== pin.baseSchemaSha256) fail('base Worker contract differs from overlay pin')
const defs = schema.$defs
const grant = defs?.SelectedMaterialExecutionGrant
const input = defs?.SelectedMaterialInput
const row = defs?.SelectedMaterialActionWorkItem
if (grant?.properties?.version?.const !== 3
    || JSON.stringify(Object.keys(grant.properties)) !== JSON.stringify([
      'version', 'boardId', 'invocationId', 'actionId', 'toolContractId', 'sourceRecordId',
      'connectionId', 'workerId', 'workerGeneration', 'adapterDigest', 'requestDigest', 'materialBindingDigest',
    ])
    || JSON.stringify(input?.required) !== JSON.stringify([
      'selector', 'digest', 'custodyId', 'totalBytes', 'deviceId', 'bindingDigest',
    ])
    || row?.properties?.materialInput?.$ref !== '#/$defs/SelectedMaterialInput') fail('overlay shape changed')
console.log('selected material overlay: canonical schema and v2 base are pinned')
