import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import Ajv from 'ajv'
import {registrationBody} from '../worker/material-transport.mjs'

const bytes=readFileSync(new URL('../protocol/worker-material.json',import.meta.url))
const schema=JSON.parse(bytes)
const ajv=new Ajv({strict:true,allErrors:true});ajv.addSchema(schema)

test('material amendment preserves exact canonical bytes and separate provenance',()=>{
  const canonical=readFileSync(new URL('../../rulith/docs/specs/schemas/rulith-worker-material-v1.schema.json',import.meta.url))
  assert.deepEqual(bytes,canonical)
  assert.equal(readFileSync(new URL('../protocol/worker-material-sha256.txt',import.meta.url),'utf8').trim(),createHash('sha256').update(bytes).digest('hex'))
})

test('real Worker registration builder produces the canonical metadata-only request',()=>{
  const body=registrationBody({id:'mat_'+'a'.repeat(32),mediaType:'text/plain',encoding:'utf8',
    totalBytes:7,digest:'sha256:'+'b'.repeat(64),chunkBytes:65536,chunks:['sha256:'+'c'.repeat(64)]},'signed-grant')
  const valid=ajv.getSchema(schema.$id+'#/$defs/MaterialRegistration')
  assert.equal(valid(body),true,JSON.stringify(valid.errors))
  for(const field of ['bytes','path','agentId','sourceRecordId']) assert.equal(valid({...body,[field]:'injected'}),false)
})
