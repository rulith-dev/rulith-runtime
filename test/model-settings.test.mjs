// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedModelInput, modelView } from '../local/model-settings.mjs'

test('model settings reject malformed and persisted output budgets visibly', () => {
  for (const value of [true, [], 255, 65537, 12000.5]) {
    assert.throws(() => checkedModelInput({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: value }),
      /Maximum output tokens/)
    const view = modelView({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: value })
    assert.equal(view.ready, false)
    assert.equal(view.maxOutputTokens, null)
    assert.match(view.reason, /Maximum output tokens/)
  }
  assert.throws(() => checkedModelInput({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: '12000' }),
    /Maximum output tokens/)
  assert.equal(modelView({ url: 'http://localhost:8080/v1', name: 'model', maxOutputTokens: '12000' }).maxOutputTokens,
    12000, 'the persisted Agent environment uses a decimal string')
  assert.equal(modelView({ url: 'http://localhost:8080/v1', name: 'model' }).maxOutputTokens, 6000)
})
