// SPDX-License-Identifier: Apache-2.0
// Only source-independent diagnostics may enter an inline Board fact. The full
// report stays in its immutable Artifact behind the existing material permissions.
const citationReasons = new Set(['rule_unknown', 'quote_not_found', 'locator_mismatch', 'ambiguous_quote', 'rule_uncited'])
const count = value => Array.isArray(value) ? value.length : null
const compileIssue = value => {
  if (value.startsWith('case_acceptance_bridge_missing:')) return { code: 'case_acceptance_bridge_missing' }
  if (value === 'Invalid Case Type') return { code: 'invalid_case_type' }
  if (value === 'Every definition needs an argument-name array.') return { code: 'definition_args_required' }
  if (value === 'Acceptance bridge must conclude one acceptance_met atom') return { code: 'acceptance_bridge_output_invalid' }
  const emptyConclusion = /^(rules|acceptance)\[(\d{1,3})\]\.then must be a nonempty atom array\.$/.exec(value)
  if (emptyConclusion) return { code: 'rule_conclusion_required', section: emptyConclusion[1], index: Number(emptyConclusion[2]) }
  const row = /^(rules|acceptance)\[(\d{1,3})\] (.+)$/.exec(value)
  if (!row) return { code: 'compile_error' }
  const detail = row[3]
  const code = detail === 'uses an undeclared predicate.' ? 'undeclared_predicate'
    : /^conclusion variable \?[A-Za-z0-9_]{1,128} has no positive premise binding\.$/.test(detail) ? 'unbound_conclusion_variable'
      : detail === 'atom args must be an object.' ? 'atom_args_invalid'
        : detail === 'cannot derive a built-in predicate.' ? 'builtin_in_conclusion'
          : detail === 'requires id.' ? 'rule_id_required'
            : detail === 'requires a human-readable label.' ? 'rule_label_required' : 'compile_error'
  return code === 'compile_error' ? { code } : { code, section: row[1], index: Number(row[2]) }
}
const guidance = new WeakMap()
const constructionCodes = new Set([
  'construction_object_required', 'construction_format_unsupported', 'namespace_invalid',
  'field_unknown', 'field_required', 'object_required', 'array_required', 'text_required',
  'predicate_name_invalid', 'predicate_symbol_invalid', 'predicate_symbol_reserved',
  'predicate_symbol_duplicate', 'predicate_id_duplicate', 'predicate_symbol_unknown',
  'import_id_invalid', 'number_not_ecmascript_exact', 'branches_required',
  'validation_kind_unknown', 'validation_variable_invalid', 'reserved_variable',
  'construction_expansion_limit', 'case_contract_format_unsupported',
])
const constructionPath = /^\$(?:\.(?:format|namespace|program|caseContracts|citations|examples|questions|notes|id|title|summary|judges|predicates|imports|pins|rules|ruleGroups|commonWhen|validations|kind|value|branches|actions|acceptance|name|as|args|when|then|preconditions|effects|execution|returns|businessKey|opening|predicate|arguments|keyArguments|minimumGroundingFloor|label|facts|expect|forbid|forbidPredicates)(?:\[\d{1,6}\])?)*$/

// An in-process carrier, minted only after the safe projection. Generic adapter
// strings or copied objects cannot opt themselves into this inline exception.
export function createAuthoringGuidance(report) {
  const carrier = Object.freeze({})
  guidance.set(carrier, 'Local checker diagnostics (guidance, not additional evidence): ' + JSON.stringify(authoringDiagnostics(report)))
  return carrier
}
export function createConstructionGuidance(errors) {
  const rows = Array.isArray(errors) ? errors : []
  const safe = rows.slice(0, 8).map(row => ({
    code: constructionCodes.has(row?.code) ? row.code : 'construction_invalid',
    ...(typeof row?.path === 'string' && row.path.length <= 128 && constructionPath.test(row.path) ? { path: row.path } : {}),
  }))
  const predicateArgsNeedNames = rows.some(row => row?.code === 'array_required'
    && /^\$\.program\.predicates\[\d+\]\.args$/.test(row?.path))
  const predicateAliasInvalid = rows.some(row => row?.code === 'predicate_symbol_invalid'
    && /^\$\.program\.predicates\[\d+\]\.as$/.test(row?.path))
  const predicateReferenceUnknown = rows.some(row => row?.code === 'predicate_symbol_unknown')
  const contractFormatUnsupported = rows.some(row => row?.code === 'case_contract_format_unsupported')
  const formatGuidance = [
    ...(predicateReferenceUnknown
      ? ['Use the exact declared as value in rules, contracts, pins and examples. Example: {name:"charge",as:"charge",args:["amount"]} is referenced as predicate:"charge"; name and as may be identical. Do not substitute the final name or namespace for a different as value.']
      : []),
    ...(contractFormatUnsupported
      ? ['caseContracts[].format selects the supported contract format, separate from caseType. Keep caseType a lowercase business name; do not encode a version suffix there or infer a different format from it.']
      : []),
    ...(predicateArgsNeedNames
      ? ['program.predicates[].args declares field names as a JSON array of strings, for example ["entity_id","amount"]. A rule or example atom uses a separate args JSON object keyed by those field names.']
      : []),
    ...(predicateAliasInvalid
      ? ['program.predicates[].as is a local alias matching [a-z][a-z0-9_]*; omit the namespace and dots. The separate name field is the final predicate name.']
      : []),
  ]
  const carrier = Object.freeze({})
  const projection = {
    errors: safe, errorCount: rows.length, diagnosticsTruncated: rows.length > safe.length,
    ...(formatGuidance.length ? { formatGuidance } : {}),
    details: 'Read the attached immutable construction Artifact for the complete submitted input and diagnostics.',
  }
  const render = () => 'Local constructor diagnostics (guidance, not additional evidence): ' + JSON.stringify(projection)
  while (Buffer.byteLength(render()) > 1200 && projection.errors.length > 0) {
    projection.errors.pop()
    projection.diagnosticsTruncated = true
  }
  while (Buffer.byteLength(render()) > 1200 && projection.formatGuidance?.length > 0) {
    projection.formatGuidance.pop()
    projection.diagnosticsTruncated = true
  }
  guidance.set(carrier, render())
  return carrier
}
export function authoringGuidanceText(carrier) {
  return carrier && typeof carrier === 'object' ? guidance.get(carrier) : undefined
}

export function authoringDiagnostics(report) {
  const errors = Array.isArray(report.compileErrors) ? report.compileErrors.filter(value => typeof value === 'string') : []
  const results = Array.isArray(report.examples?.results) ? report.examples.results : []
  const failed = results.flatMap((row, index) => row?.passed === false ? [{ row, index }] : [])
  const unverified = Array.isArray(report.citations?.unverified) ? report.citations.unverified : []
  const issues = errors.map(compileIssue)
  const codes = [...new Set(issues.map(row => row.code))]
  const absenceCount = report.examples?.passedAbsenceOnlyCount
  const absenceIndexes = report.examples?.passedAbsenceOnlyIndexes
  const totalExamples = report.examples?.total
  const absenceKnown = Number.isSafeInteger(totalExamples) && totalExamples >= 0
    && Number.isSafeInteger(absenceCount) && absenceCount >= 0 && absenceCount <= totalExamples
    && Array.isArray(absenceIndexes) && absenceIndexes.length <= absenceCount
    && absenceIndexes.every((index, at) => Number.isSafeInteger(index) && index >= 0
      && index < totalExamples && (at === 0 || absenceIndexes[at - 1] < index))
  const passedAbsenceOnly = absenceKnown
    ? { known: true, count: absenceCount, indexes: absenceIndexes.slice(0, 4) }
    : { known: false }
  const out = {
    errors: codes,
    diagnosticCounts: { compileErrors: errors.length, failedExamples: failed.length, unverifiedCitations: unverified.length },
    passedAbsenceOnly,
    ...(absenceKnown && absenceCount > 0 ? { assertionScopeGuidance: 'In these passed examples no positive outcome was asserted; only specified conclusions were checked for absence. A pass does not establish a named error or alternative result. Compare the Source and add expect where required.' } : {}),
    compileIssues: issues.filter(row => row.code !== 'compile_error').slice(0, 6),
    failedExamples: failed.slice(0, 3).map(({ row, index }) => ({ index,
      missingCount: count(row.missing), unexpectedCount: count(row.unexpected), copiedIntoInputsCount: count(row.copiedIntoInputs) })),
    // This is the index in report.citations.unverified, not an inferred draft index.
    unverifiedCitations: unverified.slice(0, 3).map((row, unverifiedIndex) => ({ unverifiedIndex,
      reason: citationReasons.has(row?.reason) ? row.reason : 'citation_unverified' })),
    exampleDetailsComplete: Array.isArray(report.examples?.results) && results.length === report.examples?.total,
    diagnosticsTruncated: issues.filter(row => row.code !== 'compile_error').length > 6
      || errors.length > codes.length || failed.length > 3 || unverified.length > 3
      || absenceKnown && absenceCount > passedAbsenceOnly.indexes.length,
    details: 'Indexes are zero-based. Read the attached immutable check Artifact for the complete draft and checker report; material permissions apply.',
  }
  // Static advice is separate from checker evidence. No rule, key or citation is
  // synthesized. Never copy free-form errors, example labels/details or rule IDs.
  const advice = {
    case_acceptance_bridge_missing: 'This certified /1 proposal lacks its own program.acceptance bridge. Business examples alone cannot certify a Case. For one attested Sensor input, explicitly construct /2 with input_version throughout related keys and atoms; otherwise provide a supported root-bound bridge. Do not borrow another Case outcome or silently upgrade /1.',
    invalid_case_type: 'caseContracts[].caseType must match [a-z][a-z0-9_]{0,63}: 1–64 characters, starting with a lowercase letter; no dots or hyphens. Use the separate format field for a supported contract version, not caseType; a version suffix does not select a format.',
    definition_args_required: 'program.vocabulary.defines[].args is an array of field names, for example ["entity_id","amount"]. Atom args are objects keyed by those names.',
    undeclared_predicate: 'A rule atom must name a declared local predicate alias, an explicit import alias, or a built-in; compare it with program.predicates[].as.',
    unbound_conclusion_variable: 'Every conclusion variable must be bound by a positive premise in the same rule; keep the input and output field variables consistent.',
    rule_label_required: 'Each rule needs a nonempty human-readable label explaining its business condition and outcome. In a construction ruleGroup, put the label on each branch.',
    rule_id_required: 'Each rule needs its own nonempty id; in a construction ruleGroup, give each branch its own id.',
    atom_args_invalid: 'Every rule atom args value is a JSON object keyed by declared field names, not an array.',
    builtin_in_conclusion: 'Built-ins test or calculate in rule premises; conclusions must name declared output predicates.',
    rule_conclusion_required: 'Each rule then array must contain at least one declared output atom. A placeholder rule with no outcome is incomplete; implement its requirement explicitly or keep that unresolved requirement visible.',
    acceptance_bridge_output_invalid: 'program.acceptance contains Case-root acceptance bridges, not business output rules. A bridge then array contains exactly one acceptance_met atom. Put ordinary business outcomes in program.rules; do not write a partial bridge to repeat an outcome.',
  }
  const selectedAdvice = codes.flatMap(code => advice[code] ? [advice[code]] : [])
  if (selectedAdvice.length) out.formatGuidance = selectedAdvice.join(' ')
  // Preserve every error category code and count. Optional locations and advice may
  // be truncated to fit; the immutable Artifact retains the complete diagnostics.
  for (const field of ['compileIssues', 'failedExamples', 'unverifiedCitations']) {
    while (Buffer.byteLength(JSON.stringify(out)) > 1500 && out[field].length) {
      out[field].pop()
      out.diagnosticsTruncated = true
    }
  }
  while (Buffer.byteLength(JSON.stringify(out)) > 1500 && selectedAdvice.length) {
    selectedAdvice.pop()
    out.formatGuidance = selectedAdvice.join(' ')
    out.diagnosticsTruncated = true
  }
  while (Buffer.byteLength(JSON.stringify(out)) > 1500 && out.passedAbsenceOnly.indexes?.length) {
    out.passedAbsenceOnly.indexes.pop()
    out.diagnosticsTruncated = true
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 1500 && out.assertionScopeGuidance) {
    delete out.assertionScopeGuidance
    out.diagnosticsTruncated = true
  }
  return out
}
