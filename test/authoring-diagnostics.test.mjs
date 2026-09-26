import assert from 'node:assert/strict'
import test from 'node:test'
import { authoringDiagnostics, authoringGuidanceText, createAuthoringGuidance,
  createConstructionGuidance } from '../worker/authoring-diagnostics.mjs'

test('construction guidance keeps fixed codes and schema paths but drops free-form names', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const carrier = createConstructionGuidance([
    { code: 'predicate_symbol_unknown', path: '$.program.rules[3].when[1].predicate' },
    { code: 'field_unknown', path: `$.program.${secret}` },
    { code: 'array_required', path: `$.program.predicates[${'7'.repeat(150)}].args` },
    { code: secret, path: `$.${secret}` },
  ])
  const text = authoringGuidanceText(carrier)
  assert.match(text, /predicate_symbol_unknown/)
  assert.match(text, /\$\.program\.rules\[3\]\.when\[1\]\.predicate/)
  assert.match(text, /construction_invalid/)
  assert.doesNotMatch(text, new RegExp(secret))
  assert.doesNotMatch(text, /7{20}/)
})

test('constructor gives fixed field-declaration repair advice without copying submitted names', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const text = authoringGuidanceText(createConstructionGuidance([
    { code: 'array_required', path: '$.program.predicates[2].args', detail: secret },
    { code: 'array_required', path: `$.program.predicates[${secret}].args` },
  ]))
  assert.match(text, /program\.predicates\[\]\.args declares field names as a JSON array of strings/)
  assert.match(text, /rule or example atom uses a separate args JSON object/)
  assert.doesNotMatch(text, new RegExp(secret))
  assert.ok(Buffer.byteLength(text) < 1600)
})

test('rule group failures retain safe coordinates for bounded model repair', () => {
  const text = authoringGuidanceText(createConstructionGuidance([
    { code: 'validation_kind_unknown', path: '$.program.ruleGroups[0].validations[1].kind' },
    { code: 'construction_expansion_limit', path: '$.program.ruleGroups[0].branches[129]' },
  ]))
  assert.match(text, /validation_kind_unknown/)
  assert.match(text, /\$\.program\.ruleGroups\[0\]\.validations\[1\]\.kind/)
  assert.match(text, /construction_expansion_limit/)
  assert.ok(Buffer.byteLength(text) <= 1200)
})

test('constructor explains invalid aliases without printing the submitted alias', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const text = authoringGuidanceText(createConstructionGuidance([
    { code: 'predicate_symbol_invalid', path: '$.program.predicates[0].as', submitted: secret },
  ]))
  assert.match(text, /local alias matching \[a-z\]\[a-z0-9_\]\*/)
  assert.match(text, /omit the namespace and dots/)
  assert.doesNotMatch(text, new RegExp(secret))
})

test('constructor advice fits an inline receipt even with many long schema coordinates', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    code: index % 2 ? 'predicate_symbol_invalid' : 'array_required',
    path: `$.program.predicates[${String(index).padStart(6, '0')}].${index % 2 ? 'as' : 'args'}`,
  }))
  const text = authoringGuidanceText(createConstructionGuidance(rows))
  assert.ok(Buffer.byteLength(text) <= 1200)
  assert.match(text, /"diagnosticsTruncated":true/)
  assert.match(text, /formatGuidance/)
  assert.match(text, /"errorCount":30/)
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

test('passing absence-only assertions are named by index, never by a private label', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const report = { compileErrors: [], examples: { total: 9, passed: 9,
    passedAbsenceOnlyCount: 1, passedAbsenceOnlyIndexes: [8],
    results: Array.from({ length: 9 }, (_, index) => ({ passed: true, label: index === 8 ? secret : 'positive' })),
  }, citations: { unverified: [] } }
  const result = authoringDiagnostics(report)
  assert.deepEqual(result.passedAbsenceOnly, { known: true, count: 1, indexes: [8] })
  assert.match(result.assertionScopeGuidance, /no positive outcome was asserted/)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret))
  const inline = authoringGuidanceText(createAuthoringGuidance(report))
  assert.match(inline, /"indexes":\[8\]/)
  assert.doesNotMatch(inline, new RegExp(secret))
  const old = structuredClone(report)
  delete old.examples.passedAbsenceOnlyCount
  delete old.examples.passedAbsenceOnlyIndexes
  assert.deepEqual(authoringDiagnostics(old).passedAbsenceOnly, { known: false })
  assert.equal(authoringDiagnostics({ ...report, examples: { ...report.examples,
    passedAbsenceOnlyIndexes: ['PRIVATE_DOCUMENT_SENTINEL'] } }).passedAbsenceOnly.known, false)
})

test('absence-only detail is bounded while its complete count remains visible', () => {
  const report = { compileErrors: [], examples: { total: 20, passed: 20,
    passedAbsenceOnlyCount: 20, passedAbsenceOnlyIndexes: Array.from({ length: 20 }, (_, index) => index),
    results: Array.from({ length: 20 }, () => ({ passed: true })),
  }, citations: { unverified: [] } }
  const result = authoringDiagnostics(report)
  assert.equal(result.passedAbsenceOnly.count, 20)
  assert.ok(result.passedAbsenceOnly.indexes.length < 20)
  assert.equal(result.diagnosticsTruncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1500)
})

test('compiler diagnostics identify fixed rule failures without copying submitted values', () => {
  const secret = 'PRIVATE_DOCUMENT_SENTINEL'
  const result = authoringDiagnostics({ compileErrors: [
    'rules[12] uses an undeclared predicate.',
    'rules[3] conclusion variable ?amount has no positive premise binding.',
    `rules[9] conclusion variable ?${secret} has no positive premise binding.`,
    'acceptance[0] atom args must be an object.',
    `rules[4] uses an undeclared predicate. ${secret}`,
  ] })
  assert.deepEqual(result.compileIssues, [
    { code: 'undeclared_predicate', section: 'rules', index: 12 },
    { code: 'unbound_conclusion_variable', section: 'rules', index: 3 },
    { code: 'unbound_conclusion_variable', section: 'rules', index: 9 },
    { code: 'atom_args_invalid', section: 'acceptance', index: 0 },
  ])
  assert.ok(result.errors.includes('compile_error'))
  assert.match(result.formatGuidance, /declared local predicate alias/)
  assert.ok(!JSON.stringify(result).includes(secret))
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

test('unknown constructor symbols teach declared aliases without exposing proposal names', () => {
  const privateName = 'PRIVATE_PREDICATE_FROM_DOCUMENT'
  const errors = Array.from({ length: 22 }, (_, index) => ({
    code: 'predicate_symbol_unknown', path: '$.program.rules[' + index + '].then[0].predicate',
    submitted: privateName, message: privateName,
  }))
  const before = JSON.stringify(errors)
  const text = authoringGuidanceText(createConstructionGuidance(errors))
  assert.match(text, /Use the exact declared as value/)
  assert.match(text, /name and as may be identical/)
  assert.match(text, /rules, contracts, pins and examples/)
  assert.match(text, /"errorCount":22/)
  assert.doesNotMatch(text, new RegExp(privateName))
  assert.equal(JSON.stringify(errors), before, 'diagnostics do not rewrite the submitted proposal')
  assert.ok(Buffer.byteLength(text) <= 1200)
})

test('contract format failures retain a fixed code and explain the separate business name', () => {
  const text = authoringGuidanceText(createConstructionGuidance([
    { code: 'case_contract_format_unsupported', path: '$.caseContracts[0].format', submitted: 'PRIVATE_FORMAT' },
  ]))
  assert.match(text, /case_contract_format_unsupported/)
  assert.match(text, /caseContracts\[\]\.format/)
  assert.match(text, /separate from caseType/)
  assert.doesNotMatch(text, /PRIVATE_FORMAT/)
  const report = authoringDiagnostics({ compileErrors: ['Invalid Case Type'] })
  assert.match(report.formatGuidance, /no dots or hyphens/)
  assert.match(report.formatGuidance, /format field.*not caseType/)
  assert.equal(Object.hasOwn(report, 'draft'), false)
})

test('all constructor repair categories together stay within the receipt byte budget', () => {
  const errors = [
    {code:'array_required',path:'$.program.predicates[123456].args'},
    {code:'predicate_symbol_invalid',path:'$.program.predicates[123456].as'},
    {code:'predicate_symbol_unknown',path:'$.caseContracts[123456].acceptance.predicate'},
    {code:'case_contract_format_unsupported',path:'$.caseContracts[123456].format'},
  ]
  const text=authoringGuidanceText(createConstructionGuidance(errors))
  assert.ok(Buffer.byteLength(text)<=1200)
  assert.match(text,/"errorCount":4/)
  assert.match(text,/"diagnosticsTruncated":true/)
  assert.doesNotMatch(text,/PRIVATE/)
})

test('an older checker rejecting the format field is not interpreted as version support', () => {
  const text=authoringGuidanceText(createConstructionGuidance([
    {code:'field_unknown',path:'$.caseContracts[0].format',detail:'rulith-case-contract/2'},
  ]))
  assert.match(text,/field_unknown/)
  assert.doesNotMatch(text,/case_contract_format_unsupported|rulith-case-contract\/2|formatGuidance/)
})

test('independent contract and binding refusals both carry repair guidance in one result', () => {
  const result=authoringDiagnostics({compileErrors:[
    'rules[0] conclusion variable ?private_name has no positive premise binding.',
    'Invalid Case Type',
  ]})
  assert.deepEqual(result.errors,['unbound_conclusion_variable','invalid_case_type'])
  assert.match(result.formatGuidance,/format field/)
  assert.match(result.formatGuidance,/positive premise in the same rule/)
  assert.doesNotMatch(JSON.stringify(result),/private_name/)
})

test('all supported compiler refusals give bounded static advice without losing error counts', () => {
  const errors=['Invalid Case Type','Every definition needs an argument-name array.',
    'rules[0] uses an undeclared predicate.',
    'rules[1] conclusion variable ?secret_name has no positive premise binding.',
    'rules[2] requires a human-readable label.', 'rules[3] requires id.',
    'rules[4] atom args must be an object.', 'rules[5] cannot derive a built-in predicate.',
    'rules[6].then must be a nonempty atom array.',
    'Acceptance bridge must conclude one acceptance_met atom']
  const result=authoringDiagnostics({compileErrors:errors})
  assert.equal(result.diagnosticCounts.compileErrors,10)
  assert.equal(result.errors.length,10)
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=1500)
  assert.equal(result.diagnosticsTruncated,true)
  assert.doesNotMatch(JSON.stringify(result),/secret_name/)
  const labels=authoringDiagnostics({compileErrors:['rules[2] requires a human-readable label.']})
  assert.match(labels.formatGuidance,/put the label on each branch/)
})


test('actual empty conclusions and Case bridge failures have bounded source-independent repair advice', () => {
  const result=authoringDiagnostics({compileErrors:[
    'rules[6].then must be a nonempty atom array.',
    'Acceptance bridge must conclude one acceptance_met atom',
  ]})
  assert.deepEqual(result.errors,['rule_conclusion_required','acceptance_bridge_output_invalid'])
  assert.deepEqual(result.compileIssues[0],{code:'rule_conclusion_required',section:'rules',index:6})
  assert.match(result.formatGuidance,/program.rules/)
  assert.match(result.formatGuidance,/acceptance_met/)
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=1500)
  const unknown=authoringDiagnostics({compileErrors:['Acceptance bridge secret_customer PRIVATE value']})
  assert.deepEqual(unknown.errors,['compile_error'])
  assert.doesNotMatch(JSON.stringify(unknown),/secret_customer|PRIVATE|acceptance_bridge_output_invalid/)
})
