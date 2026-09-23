// SPDX-License-Identifier: Apache-2.0
/** Opt-in, paid diagnostic. One call by default; at most two explicit repair rounds.
 * Never logs the prompt, draft or credential, or feeds held-out boundaries to repairs. */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createManagerServer } from '../local/manager-server.mjs'
import { defaultManagerRoot } from '../local/manager-registry.mjs'
import { createModelSettings } from '../local/model-settings.mjs'
import { authoringNode, builtinLocalAuthoringTools, executeLocalAuthoring, LOCAL_AUTHORING_DRAFT_SHAPE } from '../worker/local-authoring.mjs'
import { materialIdentityFromFingerprints, openMaterialStore } from '../worker/material-store.mjs'
import { authoringGuidanceText } from '../worker/authoring-diagnostics.mjs'

if (process.env.RULITH_AUTHORING_BENCHMARK !== '1') {
  console.error('Set RULITH_AUTHORING_BENCHMARK=1 for one paid model request with the synthetic fixture. RULITH_AUTHORING_REPAIR_ROUNDS=1 or 2 explicitly permits that many additional requests.')
  process.exitCode = 2
} else {
  const digest = value => createHash('sha256').update(value).digest('hex')
  const text = await readFile(fileURLToPath(new URL('../test/fixtures/authoring-shipping-policy.md', import.meta.url)), 'utf8')
  const device = createManagerServer({ port: 0 }).state().device
  if (device.state !== 'linked' || !device.account?.id) throw new Error('Sign in to the local Rulith manager before benchmarking.')
  const model = createModelSettings({ root: defaultManagerRoot() }).read(device.origin, device.account.id)
  if (!model?.url || !model?.name || !model?.key) throw new Error('The signed-in account needs a configured model and key.')
  const endpoint = new URL(model.url)
  const path = endpoint.pathname.replace(/\/+$/, '')
  if (!path) endpoint.pathname = '/v1/chat/completions'
  else if (path.endsWith('/v1')) endpoint.pathname = `${path}/chat/completions`
  else if (!path.endsWith('/chat/completions')) throw new Error('This benchmark needs an OpenAI-compatible Chat Completions endpoint.')
  const prompt = [
    'Create one mechanically checkable Rulith capability draft from the synthetic document below.',
    'Return exactly one JSON object and no Markdown, shaped as the check_draft tool arguments: {"draft_json":"<one serialized draft JSON object>"}. Keep questions empty only when the document supplies every needed business decision.',
    'Include boundary, missing, invalid and independent-key examples. Cite exact document substrings for each rule.',
    LOCAL_AUTHORING_DRAFT_SHAPE,
    'Document follows:\n' + text,
  ].join('\n\n')
  const repairRounds = Number(process.env.RULITH_AUTHORING_REPAIR_ROUNDS ?? '0')
  if (!Number.isInteger(repairRounds) || repairRounds < 0 || repairRounds > 2)
    throw new Error('RULITH_AUTHORING_REPAIR_ROUNDS must be 0, 1 or 2.')
  const messages = [{ role: 'user', content: prompt }]
  let cumulativeInputTokens = 0, cumulativeOutputTokens = 0, attempts = 0
  for (let attempt = 1; attempt <= 1 + repairRounds; attempt++) {
  attempts = attempt
  let repairFeedback = ''
  const body = {
    model: model.name, max_tokens: 8000,
    ...(['enabled', 'disabled'].includes(model.thinking) ? { thinking: { type: model.thinking } } : {}),
    messages,
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${model.key}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  })
  // A provider error can include request details; never echo its raw body.
  if (!response.ok) throw new Error(`Model request failed with HTTP ${response.status}.`)
  const envelope = await response.json()
  const choice = envelope?.choices?.[0]
  const raw = String(choice?.message?.content ?? '').trim()
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const inputTokens = envelope?.usage?.prompt_tokens ?? null
  const hit = envelope?.usage?.prompt_cache_hit_tokens ?? null
  const miss = envelope?.usage?.prompt_cache_miss_tokens ?? null
  const cacheBreakdownValid = [inputTokens, hit, miss].every(value => Number.isSafeInteger(value) && value >= 0)
    && hit + miss === inputTokens
  const outputTokens = envelope?.usage?.completion_tokens ?? null
  cumulativeInputTokens = cumulativeInputTokens !== null && Number.isSafeInteger(inputTokens) && inputTokens >= 0 ? cumulativeInputTokens + inputTokens : null
  cumulativeOutputTokens = cumulativeOutputTokens !== null && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? cumulativeOutputTokens + outputTokens : null
  const metrics = {
    attempt, maximumCalls: 1 + repairRounds, cumulativeInputTokens, cumulativeOutputTokens,
    fixtureSha256: digest(text), cueSha256: digest(LOCAL_AUTHORING_DRAFT_SHAPE),
    model: model.name, inputTokens, cachedInputTokens: cacheBreakdownValid ? hit : null,
    uncachedInputTokens: cacheBreakdownValid ? miss : null,
    outputTokens,
    requestBytes: Buffer.byteLength(JSON.stringify(body)), finishReason: choice?.finish_reason ?? null,
    responseBytes: Buffer.byteLength(json),
  }
  if (choice?.finish_reason === 'length') throw new Error(`Model response was truncated; usage ${JSON.stringify(metrics)}.`)
  let draft
  try {
    const argumentsObject = JSON.parse(json)
    draft = JSON.parse(argumentsObject.draft_json)
  } catch {
    console.log(JSON.stringify({ ...metrics, parsed: false, checked: false, passed: false }))
    process.exitCode = 1
    repairFeedback = 'Return one JSON object with a draft_json string containing the complete draft object. The previous answer could not be parsed in that form.'
  }
  if (draft !== undefined && (draft === null || typeof draft !== 'object' || Array.isArray(draft))) {
    console.log(JSON.stringify({ ...metrics, parsed: true, checked: false, passed: false, reason: 'draft_not_object' }))
    process.exitCode = 1
    repairFeedback = 'draft_json must serialize a JSON object, not a scalar or array.'
  } else if (draft !== undefined) {
    const allowed = new Set(['program', 'caseContracts', 'citations', 'examples', 'questions', 'notes'])
    const extraKeys = draft && typeof draft === 'object' && !Array.isArray(draft)
      ? Object.keys(draft).filter(key => !allowed.has(key)).map(key => key.slice(0, 80)) : []
    if (extraKeys.length) {
      console.log(JSON.stringify({ ...metrics, parsed: true, checked: false, passed: false, reason: 'extra_top_level_keys', extraKeys }))
      process.exitCode = 1
      repairFeedback = 'Use only the six documented top-level draft fields. Unexpected fields: ' + extraKeys.join(', ')
    } else {
      const root = await mkdtemp(join(tmpdir(), 'rulith-authoring-benchmark-'))
      try {
        const binding = materialIdentityFromFingerprints({
          profile: 'a'.repeat(64), owner: 'b'.repeat(64), modelDestination: endpoint.origin, model: model.name,
        })
        const store = openMaterialStore(root, binding)
        const material = store.put({ name: 'authoring-shipping-policy.md', mediaType: 'text/markdown', bytes: Buffer.from(text) })
        const tool = builtinLocalAuthoringTools()['rulith.official_authoring.check_draft@2']
        try {
          const checked = await executeLocalAuthoring(tool, {
            node: authoringNode(material.id, material.digest), task_id: material.id, draft_json: JSON.stringify(draft),
          }, { materialRoot: root, binding })
          const summary = JSON.parse(checked.rows[0].report)
          // The application receives this same bounded checker feedback. A repair is
          // an explicit benchmark mode, not a hidden paid retry in the product.
          if (!summary.compiled || summary.examples_passed !== summary.examples_total || summary.citations_verified !== summary.citations_total)
            repairFeedback = JSON.stringify(summary) + '\n' + (authoringGuidanceText(checked.safeInlineGuidance) ?? '')
          const full = JSON.parse(store.read(checked.localArtifact.id, { modelDestination: endpoint.origin }).bytes.toString('utf8')).report
          const results = Array.isArray(full.examples?.results) ? full.examples.results : null
          const failingExampleIndexes = results === null || results.length !== summary.examples_total
            ? null : results.flatMap((entry, index) => entry?.passed === false ? [index] : [])
          const failedExamples = failingExampleIndexes === null ? null : failingExampleIndexes.map(index => {
            const row = results[index]
            return { index, label: typeof row?.label === 'string' ? row.label.slice(0, 80) + (row.label.length > 80 ? '…' : '') : null,
              missingCount: Array.isArray(row?.missing) ? row.missing.length : null,
              unexpectedCount: Array.isArray(row?.unexpected) ? row.unexpected.length : null }
          })
          const exampleDiagnosticsUnavailable = failingExampleIndexes === null && summary.examples_passed !== summary.examples_total
          const openQuestions = Array.isArray(draft.questions) ? draft.questions.length : -1
          let independent = { available: false, reason: 'draft_shape_unmapped' }
          const contract = Array.isArray(draft.caseContracts) && draft.caseContracts.length === 1 ? draft.caseContracts[0] : null
          const definitions = Array.isArray(draft.program?.vocabulary?.defines) ? draft.program.vocabulary.defines : []
          const keyFields = contract?.businessKey?.arguments
          const inputPredicate = contract?.businessKey?.predicate
          const outputPredicate = contract?.acceptance?.predicate
          const inputFields = definitions.find(row => row.id === inputPredicate)?.args
          const outputFields = definitions.find(row => row.id === outputPredicate)?.args
          const inputAlias = definitions.find(row => row.id === inputPredicate)?.as
          const outputAlias = definitions.find(row => row.id === outputPredicate)?.as
          const extraInput = Array.isArray(inputFields) && Array.isArray(keyFields) ? inputFields.filter(field => !keyFields.includes(field)) : []
          const extraOutput = Array.isArray(outputFields) && Array.isArray(keyFields) ? outputFields.filter(field => !keyFields.includes(field)) : []
          const feeCandidates = extraOutput.filter(field => /(?:^|_)(?:fee|shipping|cost)(?:_|$)/i.test(field))
          const feeField = extraOutput.length === 1 ? extraOutput[0] : feeCandidates.length === 1 ? feeCandidates[0] : null
          const carryField = extraOutput.length === 2 ? extraOutput.find(field => field !== feeField) : null
          const outputShapeKnown = extraOutput.length === 1 || (extraOutput.length === 2 && carryField === extraInput[0])
          const keyFieldsPresent = Array.isArray(keyFields) && Array.isArray(inputFields) && Array.isArray(outputFields)
            && keyFields.every(field => inputFields.includes(field) && outputFields.includes(field))
          const shape = { contracts: draft.caseContracts?.length ?? null,
            keyFields: keyFields?.length ?? null, inputFields: inputFields?.length ?? null, outputFields: outputFields?.length ?? null,
            extraInput: extraInput.length, extraOutput: extraOutput.length, aliasesFound: Boolean(inputAlias && outputAlias),
            keyFieldsPresent,
            inputNames: Array.isArray(inputFields) ? inputFields.map(name => String(name).slice(0, 40)) : null,
            outputNames: Array.isArray(outputFields) ? outputFields.map(name => String(name).slice(0, 40)) : null }
          let guards = { available: false, outputRules: 0, guardedRules: 0 }
          if (keyFields?.length === 1 && keyFieldsPresent && extraInput.length === 1 && outputShapeKnown &&
            [inputPredicate, outputPredicate, keyFields[0], extraInput[0], feeField].every(value => typeof value === 'string' && value)) {
            const key = keyFields[0], amount = extraInput[0], fee = feeField
            const input = (id, value) => ({ predicate: inputPredicate, args: { [key]: id, [amount]: value } })
            const output = (id, value, inputValue) => ({ predicate: outputPredicate,
              args: { [key]: id, ...(carryField ? { [carryField]: inputValue } : {}), [fee]: value } })
            const positive = (label, value, expected) => ({ label, facts: [input(label, value)], expect: [output(label, expected, value)], forbid: [], forbidPredicates: [] })
            const invalid = (label, value) => ({ label, facts: [input(label, value)], expect: [], forbid: [], forbidPredicates: [outputPredicate] })
            const boundaryDraft = { ...draft, examples: [
              positive('qa_zero', 0, 12), positive('qa_199', 199, 12), positive('qa_200', 200, 0), positive('qa_201', 201, 0),
              invalid('qa_negative', -1), invalid('qa_negative_two', -2),
              invalid('qa_fractional', 0.5), invalid('qa_fractional_tenth', 0.1), invalid('qa_fractional_above', 1.5),
              { label: 'qa_missing', facts: [{ predicate: inputPredicate, args: { [key]: 'qa_missing' } }], expect: [], forbid: [], forbidPredicates: [outputPredicate] },
              { label: 'qa_two_orders', facts: [input('qa_a', 199), input('qa_b', 200)],
                expect: [output('qa_a', 12, 199), output('qa_b', 0, 200)],
                forbid: [output('qa_a', 0, 199), output('qa_b', 12, 200)], forbidPredicates: [] },
            ] }
            try {
              const audit = await executeLocalAuthoring(tool, {
                node: authoringNode(material.id, material.digest), task_id: material.id, draft_json: JSON.stringify(boundaryDraft),
              }, { materialRoot: root, binding })
              const report = JSON.parse(audit.rows[0].report)
              independent = { available: true, compiled: report.compiled, examplesTotal: report.examples_total,
                examplesPassed: report.examples_passed, citationsTotal: report.citations_total, citationsVerified: report.citations_verified }
            } catch (error) {
              const code = String(error?.code ?? error?.message ?? '').split(':', 1)[0]
              independent = { available: false, reason: 'independent_checker_error', errorCode: /^[a-z_]{1,60}$/i.test(code) ? code : null }
            }
            if (typeof inputAlias === 'string' && typeof outputAlias === 'string' && Array.isArray(draft.program?.rules)) {
              const outputRules = draft.program.rules.filter(rule => rule.then?.some(atom => atom.predicate === outputAlias))
              const guardedRules = outputRules.filter(rule => {
                const when = Array.isArray(rule.when) ? rule.when : []
                const variable = when.find(atom => atom.predicate === inputAlias)?.args?.[amount]
                if (typeof variable !== 'string' || !variable.startsWith('?')) return false
                const nonnegative = when.some(atom => atom.predicate === 'gte' && atom.args?.left === variable && atom.args?.right === 0)
                const remainder = when.find(atom => atom.predicate === 'imod' && atom.args?.left === variable && atom.args?.right === 1)?.args?.result
                const integer = typeof remainder === 'string' && when.some(atom => atom.predicate === 'eq' && atom.args?.left === remainder && atom.args?.right === 0)
                return nonnegative && integer
              })
              guards = { available: true, outputRules: outputRules.length, guardedRules: guardedRules.length }
            }
          }
          const passed = !(!summary.compiled || summary.examples_total === 0 || summary.examples_passed !== summary.examples_total
            || summary.citations_total === 0 || summary.citations_verified !== summary.citations_total || openQuestions !== 0
            || !independent.available || !independent.compiled || independent.examplesTotal !== 11 || independent.examplesPassed !== 11
            || !guards.available || guards.outputRules === 0 || guards.guardedRules !== guards.outputRules)
          console.log(JSON.stringify({ ...metrics, parsed: true, checked: true, passed, ...summary, failedExamples, exampleDiagnosticsUnavailable, openQuestions, shape, independent, guards }))
          process.exitCode = passed ? 0 : 1
        } catch (error) {
          const code = String(error?.message ?? '').split(':', 1)[0]
          console.log(JSON.stringify({ ...metrics, parsed: true, checked: false, passed: false, reason: /^[a-z_]+$/.test(code) ? code : 'checker_error' }))
          process.exitCode = 1
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
  if (!repairFeedback || attempt === 1 + repairRounds) break
  messages.push({ role: 'assistant', content: raw }, { role: 'user', content:
    'The local checker reported the following. Correct your draft using the original document; do not remove failing examples just to pass. Return the complete draft_json wrapper again.\n' + repairFeedback })
  }
  console.log(JSON.stringify({ phase: 'complete', attempts, maximumCalls: 1 + repairRounds,
    cumulativeInputTokens, cumulativeOutputTokens, passed: process.exitCode === 0 }))
}
