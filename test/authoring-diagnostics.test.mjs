import assert from 'node:assert/strict'
import test from 'node:test'
import { authoringDiagnostics, authoringGuidanceText, createConstructionGuidance } from '../worker/authoring-diagnostics.mjs'

test('construction guidance keeps fixed codes and schema paths but drops free-form names', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const carrier = createConstructionGuidance([
    { code: 'predicate_symbol_unknown', path: '$.program.rules[3].when[1].predicate' },
    { code: 'field_unknown', path: `$.program.${secret}` },
    { code: secret, path: `$.${secret}` },
  ])
  const text = authoringGuidanceText(carrier)
  assert.match(text, /predicate_symbol_unknown/)
  assert.match(text, /\$\.program\.rules\[3\]\.when\[1\]\.predicate/)
  assert.match(text, /construction_invalid/)
  assert.doesNotMatch(text, new RegExp(secret))
})

test('inline diagnostics expose indexes and fixed codes without copying any free-form material', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const report = { compileErrors: [secret], examples: { total: 2, results: [
    { label: secret, passed: true },
    { label: secret, passed: false, detail: secret, missing: [], unexpected: [{ predicate: secret, args: { secret } }], copiedIntoInputs: [] },
  ] }, citations: { unverified: [{ ruleId: secret, quote: secret, reason: 'quote_not_found' }, { ruleId: secret, reason: secret }] } }
  const before = JSON.stringify(report)
  const result = authoringDiagnostics(report)
  assert.deepEqual(result.errors, ['compile_error'])
  assert.deepEqual(result.failedExamples, [{ index: 1, missingCount: 0, unexpectedCount: 1, copiedIntoInputsCount: 0 }])
  assert.deepEqual(result.unverifiedCitations, [{ unverifiedIndex: 0, reason: 'quote_not_found' }, { unverifiedIndex: 1, reason: 'citation_unverified' }])
  assert.equal(result.exampleDetailsComplete, true)
  assert.equal(result.diagnosticsTruncated, false)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.equal(JSON.stringify(report), before, 'the immutable report is not rewritten')
})

test('format repair advice is distinct from the original refusal and adds no draft or success', () => {
  const report = { compileErrors: ['Invalid Case Type'], examples: { total: 0, results: [] } }
  const result = authoringDiagnostics(report)
  assert.deepEqual(result.errors, ['invalid_case_type'])
  assert.match(result.formatGuidance, /caseContracts\[\]\.caseType.*1–64.*no dots or hyphens/)
  assert.equal(Object.hasOwn(result, 'compiled'), false)
  assert.equal(Object.hasOwn(result, 'draft'), false)
  assert.equal(report.compileErrors[0], 'Invalid Case Type')
})

test('bounded diagnostics preserve counts without copying multi-byte or escaped checker output', () => {
  for (const text of ['😀'.repeat(1000), '\u0000'.repeat(1000)]) {
    const report = { compileErrors: [...Array(30).fill(text), 'Invalid Case Type', 'Every definition needs an argument-name array.'],
      examples: { total: 20, results: Array(20).fill({ passed: false, label: text, detail: text, missing: Array(10).fill({}) }) },
      citations: { unverified: Array(20).fill({ ruleId: text, reason: text }) } }
    const result = authoringDiagnostics(report)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1600)
    assert.deepEqual(result.diagnosticCounts, { compileErrors: 32, failedExamples: 20, unverifiedCitations: 20 })
    assert.equal(result.diagnosticsTruncated, true)
    assert.match(result.details, /immutable check Artifact/)
    assert.ok(!JSON.stringify(result).includes(text))
  }
})

test('missing result arrays remain explicitly incomplete instead of claiming that no examples failed', () => {
  const result = authoringDiagnostics({ compileErrors: [], examples: { total: 9, passed: 7 } })
  assert.equal(result.exampleDetailsComplete, false)
  assert.match(result.details, /complete draft and checker report/)
  assert.deepEqual(result.failedExamples, [])
})
