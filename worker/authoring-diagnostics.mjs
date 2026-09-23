// SPDX-License-Identifier: Apache-2.0
// Only source-independent diagnostics may enter an inline Board fact. The full
// report stays in its immutable Artifact behind the existing material permissions.
const citationReasons = new Set(['rule_unknown', 'quote_not_found', 'locator_mismatch', 'ambiguous_quote', 'rule_uncited'])
const count = value => Array.isArray(value) ? value.length : null
const compileCode = value => value === 'Invalid Case Type' ? 'invalid_case_type'
  : value.includes('Every definition needs an argument-name array.') ? 'definition_args_required' : 'compile_error'
const guidance = new WeakMap()

// An in-process carrier, minted only after the safe projection. Generic adapter
// strings or copied objects cannot opt themselves into this inline exception.
export function createAuthoringGuidance(report) {
  const carrier = Object.freeze({})
  guidance.set(carrier, 'Local checker diagnostics (guidance, not additional evidence): ' + JSON.stringify(authoringDiagnostics(report)))
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
