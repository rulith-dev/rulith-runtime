// SPDX-License-Identifier: Apache-2.0
// Only source-independent diagnostics may enter an inline Board fact. The full
// report stays in its immutable Artifact behind the existing material permissions.
const citationReasons = new Set(['rule_unknown', 'quote_not_found', 'locator_mismatch', 'ambiguous_quote', 'rule_uncited'])
const count = value => Array.isArray(value) ? value.length : null
const compileCode = value => value === 'Invalid Case Type' ? 'invalid_case_type'
  : value.includes('Every definition needs an argument-name array.') ? 'definition_args_required' : 'compile_error'
const guidance = new WeakMap()
const constructionCodes = new Set([
  'construction_object_required', 'construction_format_unsupported', 'namespace_invalid',
  'field_unknown', 'field_required', 'object_required', 'array_required', 'text_required',
  'predicate_name_invalid', 'predicate_symbol_invalid', 'predicate_symbol_reserved',
  'predicate_symbol_duplicate', 'predicate_id_duplicate', 'predicate_symbol_unknown',
  'import_id_invalid', 'number_not_ecmascript_exact',
])
const constructionPath = /^\$(?:\.(?:format|namespace|program|caseContracts|citations|examples|questions|notes|id|title|summary|judges|predicates|imports|pins|rules|actions|acceptance|name|as|args|when|then|preconditions|effects|execution|returns|businessKey|opening|predicate|arguments|keyArguments|minimumGroundingFloor|label|facts|expect|forbid|forbidPredicates)(?:\[\d{1,6}\])?)*$/

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
  const formatGuidance = [
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
  const codes = [...new Set(errors.map(compileCode))]
  const out = {
    errors: codes,
    diagnosticCounts: { compileErrors: errors.length, failedExamples: failed.length, unverifiedCitations: unverified.length },
    failedExamples: failed.slice(0, 3).map(({ row, index }) => ({ index,
      missingCount: count(row.missing), unexpectedCount: count(row.unexpected), copiedIntoInputsCount: count(row.copiedIntoInputs) })),
    // This is the index in report.citations.unverified, not an inferred draft index.
    unverifiedCitations: unverified.slice(0, 3).map((row, unverifiedIndex) => ({ unverifiedIndex,
      reason: citationReasons.has(row?.reason) ? row.reason : 'citation_unverified' })),
    exampleDetailsComplete: Array.isArray(report.examples?.results) && results.length === report.examples?.total,
    diagnosticsTruncated: errors.length > codes.length || failed.length > 3 || unverified.length > 3,
    details: 'Indexes are zero-based. Read the attached immutable check Artifact for the complete draft and checker report; material permissions apply.',
  }
  // Static advice is separate from checker evidence. No rule, key or citation is
  // synthesized. Never copy free-form errors, example labels/details or rule IDs.
  if (codes.includes('invalid_case_type')) out.formatGuidance =
    'caseContracts[].caseType must match [a-z][a-z0-9_]{0,63}: 1–64 characters, starting with a lowercase letter; no dots or hyphens.'
  else if (codes.includes('definition_args_required')) out.formatGuidance =
    'program.vocabulary.defines[].args is an array of field names, for example ["entity_id","amount"]. Atom args are objects keyed by those names.'
  return out
}
