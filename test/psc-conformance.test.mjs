// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root=fileURLToPath(new URL('../',import.meta.url))

test('RT-PSC-MAP-1 Runtime evidence inventory contains real targets and explicit gaps', () => {
  const map=JSON.parse(readFileSync(resolve(root,'conformance/psc.json'),'utf8'))
  assert.equal(map.schema,'rulith-psc-conformance-map/v1')
  assert.equal(map.repository,'runtime')
  assert.equal(map.contractVersion,'0.2.4')
  assert.match(map.contractReviewedCommit,/^[a-f0-9]{40}$/)
  assert.ok(Object.keys(map.acceptance).length>0)
  const used=new Set()
  for(const [id,entry] of Object.entries(map.acceptance)) {
    assert.match(id,/^ACC-[A-Z]+-\d+$/)
    if(entry.state==='blocked') {
      assert.equal(typeof map.blockers[entry.blocker],'string',`${id}: missing blocker`)
      assert.ok(map.blockers[entry.blocker].trim(),`${id}: empty blocker`)
      used.add(entry.blocker)
    } else {
      assert.equal(entry.state,'mapped',`${id}: cannot delegate Runtime responsibility`)
      assert.ok(Array.isArray(entry.targets) && entry.targets.length>0,`${id}: no targets`)
      for(const target of entry.targets) {
        assert.match(target.file,/^test\/[a-zA-Z0-9_-]+\.test\.mjs$/)
        assert.equal(typeof target.locator,'string')
        assert.ok(target.locator.trim())
        assert.ok(readFileSync(resolve(root,target.file),'utf8').includes(target.locator),`${id}: missing ${target.locator}`)
      }
    }
  }
  assert.deepEqual([...used].sort(),Object.keys(map.blockers).sort(),'unused blocker text')
})
