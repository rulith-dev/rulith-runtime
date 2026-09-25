// SPDX-License-Identifier: Apache-2.0
/**
 * The shipped Verified Calculation example, driven through the real Worker and its real Adapters.
 *
 * Everything here reads the committed example bytes — the vendored current platform recipe fixture for the Action
 * contracts, `worker-tools.json` for the local Tool Manifest, `data/input.json` for the Source
 * material — and hands them to the Worker binary the way a Gateway dispatch does. Nothing is
 * restated: a row's `toolSpec` carries the `sourceTypes`, `params` and `returns` the recipe
 * declares, and its `toolDigest` is the pin of the manifest entry as written.
 *
 * That coupling is the point. The two defects this file was written against were both invisible
 * to a field-presence assertion:
 *
 *   · The three Actions pinned one Source *instance* in the retired `execution.source`. A
 *     dispatch built from such a contract states no `sourceTypes` at all, and the Worker refuses
 *     it — the example could not be seeded, and could not have run if it had been.
 *   · `read-input.mjs` demanded `RULITH_CASE_ID` and rooted the task tree at whatever it found
 *     there. The Worker hop carries no Case (`RULITH_INVOCATION_ID` is the only identity an
 *     Adapter is handed), so in production the Adapter always refused — and where an operator
 *     had that name in the Worker's ambient environment it did not refuse, it rooted the task
 *     tree at an operator-supplied string. Asserting the variable is gone would not have caught
 *     the second half: the arm below sets it and requires that no fact carries its value.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { BOARD, CONNECTION, HOLD, ROOT, SIGNED, driveWorker, toolDigest, artifactWorkFields } from './support/worker-harness.mjs'

const EXAMPLE = join(ROOT, 'examples', 'verified-calculation')
const RECIPE = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/verified-calculation-recipe.json'), 'utf8'))
const MANIFEST = JSON.parse(readFileSync(join(EXAMPLE, 'worker-tools.json'), 'utf8'))
const INPUT_BYTES = readFileSync(join(EXAMPLE, 'data', 'input.json'), 'utf8')
const JOB = JSON.parse(INPUT_BYTES)

const PROGRAM = RECIPE.program
const SOURCES = RECIPE.sources
const PREDICATES = Object.fromEntries(PROGRAM.vocabulary.defines.map(row => [row.as, row.id]))
/** The governed Source the deployment binds; the recipe names its type, never this instance. */
const SOURCE = SOURCES.sources[0].name
const ACTIONS = Object.fromEntries(PROGRAM.actions.map((action) => [action.action, action]))

/** The exact result the board closure derives, written out so the arithmetic is pinned here too. */
const SUBTOTAL = JOB.unit_price_cents * JOB.quantity
const TOTAL = SUBTOTAL + JOB.shipping_cents
const NODE = `CALC_${JOB.job_id}`

/** Each Adapter at the path its own Tool Manifest entry names, with its committed bytes. */
const ADAPTERS = Object.fromEntries(Object.values(MANIFEST.tools)
  .map((tool) => [tool.entry, readFileSync(join(EXAMPLE, basename(tool.entry)), 'utf8')]))

/**
 * One dispatched Action row, built from the recipe rather than beside it.
 *
 * `sourceTypes` is read off `execution` with no default: a contract that declares none must
 * reach the Worker declaring none, because that is the dispatch a host would actually build
 * from it, and the refusal is the finding.
 */
function exampleRow(name, args, overrides = {}) {
  const action = ACTIONS[name]
  const execution = { ...action.execution, returns: action.execution.returns?.map(row => ({ ...row, predicate: PREDICATES[row.predicate] ?? row.predicate })) }
  return {
    workType: 'action',
    work: `inv_${name}`,
    tool: name,
    boardId: BOARD,
    toolContractId: execution.tool,
    sourceRecordId: SOURCE,
    ...artifactWorkFields(SOURCE),
    connectionId: CONNECTION,
    toolDigest: toolDigest(MANIFEST.tools[execution.tool]),
    executionGrant: SIGNED,
    args: JSON.stringify({ source: SOURCE, ...args }),
    target: '',
    toolSpec: JSON.stringify({
      impl: 'worker-tool',
      exec: execution.tool,
      kind: execution.kind,
      params: execution.params ?? {},
      sourceTypes: execution.sourceTypes,
      ...(execution.returns === undefined ? {} : { returns: execution.returns }),
    }),
    ...overrides,
  }
}

/** Drive the real Worker over one poll that dispatches `rows`, then hold it idle. */
async function runExample(rows, { env = {}, settled, sources } = {}) {
  let dispatched = false
  const result = await driveWorker({
    env,
    extraTools: MANIFEST.tools,
    extraFiles: { ...ADAPTERS, 'runtime/input.json': INPUT_BYTES },
    sources: sources ?? ((root) => [{ name: SOURCE, type: 'file', access: join(root, 'runtime') }]),
    reply: (operation) => {
      if (operation.kind === 'Poll') {
        if (dispatched) return HOLD
        dispatched = true
        return { body: { accepted: true, payload: { work: rows } } }
      }
      if (operation.kind === 'ClaimWork' || operation.kind === 'ReportWork') return { body: { accepted: true } }
      return undefined
    },
    // A refusal ends the scenario too, or a regression would present as a timeout instead of
    // as a failed assertion. A scenario whose rows are all *expected* to be refused says so
    // itself, so it waits for every refusal rather than stopping at the first.
    done: settled ?? ((seen, output) =>
      seen.filter((entry) => entry.operation.kind === 'ReportWork').length >= rows.length
      || /Skipping/.test(output)),
  })
  assert.equal(result.timedOut, false, result.output)
  return { ...result, receipts: result.seen.filter((entry) => entry.operation.kind === 'ReportWork').map((entry) => entry.operation) }
}

const factsOf = (receipt) => receipt?.facts ?? []
const factNamed = (receipt, predicate) => factsOf(receipt).find((fact) => fact.predicate === predicate)

/**
 * Two Worker runs, shared by the arms that read them.
 *
 * A run is a real process that boots, advertises, polls and starts `node` Adapters, so one
 * run per assertion is load the whole suite pays for — it shares a machine with every other
 * file that starts Agent and Worker children. One run per *scenario* also says something the
 * separate runs could not: several rows arrive in one dispatch, and a refusal must leave the
 * item beside it alone. Each arm keeps its own name and its own red signal; what they share
 * is the process, not the assertion.
 */
const RUNS = new Map()
const run = (name, build) => {
  if (!RUNS.has(name)) RUNS.set(name, build())
  return RUNS.get(name)
}

test('RT-EXAMPLE-1 the shipped Actions declare Source types the Worker accredits, and pin no instance', () => {
  const executions = PROGRAM.actions.map((action) => action.execution)
  assert.equal(executions.length, 3)
  for (const [index, execution] of executions.entries()) {
    const where = `${PROGRAM.actions[index].action}`
    // The contract may say which *types* it accepts. Which instance runs is the deployment's
    // to bind and the invocation's to name, so a contract that states one is refused upstream.
    assert.deepEqual(execution.sourceTypes, ['file'], `${where} must accept the file Source type`)
    assert.equal('source' in execution, false, `${where} still pins a Source instance`)
    // Two contracts, one answer: the Tool the recipe references must be a Tool this Manifest
    // installs, and both sides must name the same accredited Source types. A recipe that
    // accepted `db` for an Adapter installed as a `file` Tool would seed and never dispatch.
    const installed = MANIFEST.tools[execution.tool]
    assert.ok(installed, `${where} references Tool ${execution.tool}, which this Worker Tool Manifest does not install`)
    assert.deepEqual([...installed.sourceTypes].sort(), [...execution.sourceTypes].sort(),
      `${where} and its installed Tool disagree about the Source types they accept`)
    // `source` is the invocation's selector and is stripped before the parameter table is
    // checked, so a declared slot by that name could never be filled — the Worker refuses it
    // at declaration time and the Board refuses the pack.
    assert.equal('source' in (execution.params ?? {}), false, `${where} declares the reserved selector as a business parameter`)
  }
})

/**
 * Intake, under a hostile ambient environment, beside two invocations that must not run.
 *
 * `RULITH_CASE_ID` is set exactly as it would be on a machine carrying it for some other
 * reason. Two things now stand between it and the task tree, and the arm holds if either is
 * removed: the Adapter reads its root from the input file, and `adapterEnv` strips the retired
 * hop name so no Adapter can inherit it. Everything a clean run would assert holds here too.
 *
 * The two refused rows share the batch deliberately: each is refused on its own ground, and
 * a refusal must not swallow the item beside it.
 */
const intake = () => run('intake', () => runExample([
  exampleRow('load_calculation_input', {}, { work: 'inv_no_source', args: JSON.stringify({}) }),
  exampleRow('load_calculation_input', {}, { work: 'inv_other_source', args: JSON.stringify({ source: 'somebody-elses-files' }) }),
  exampleRow('load_calculation_input', {}, { work: 'inv_intake' }),
], {
  env: { RULITH_CASE_ID: 'forged-case-identity' },
  settled: (seen, out) => seen.filter((entry) => entry.operation.kind === 'ReportWork').length >= 1
    && (out.match(/Skipping/g) ?? []).length >= 2,
}))

/** The write / read-back round trip, with the refused write ahead of it in the same batch. */
const roundTrip = () => run('round-trip', () => runExample([
  exampleRow('write_calculation_result', {
    node: NODE,
    job_id: JOB.job_id,
    unit_price_cents: JOB.unit_price_cents,
    quantity: JOB.quantity,
    shipping_cents: JOB.shipping_cents,
    subtotal_cents: SUBTOTAL,
    total_cents: TOTAL + 1,
  }, { work: 'inv_write_wrong' }),
  exampleRow('write_calculation_result', {
    node: NODE,
    job_id: JOB.job_id,
    unit_price_cents: JOB.unit_price_cents,
    quantity: JOB.quantity,
    shipping_cents: JOB.shipping_cents,
    subtotal_cents: SUBTOTAL,
    total_cents: TOTAL,
  }, { work: 'inv_write' }),
  exampleRow('verify_calculation_output', {
    node: NODE,
    job_id: JOB.job_id,
    subtotal_cents: SUBTOTAL,
    total_cents: TOTAL,
    status: 'completed',
  }, { work: 'inv_verify' }),
]))

test('RT-EXAMPLE-2 the intake Action reaches the Adapter through the invocation\'s own Source selector', async () => {
  const { receipts, output } = await intake()
  assert.equal(receipts.length, 1, output)
  const [receipt] = receipts
  assert.equal(receipt.ok, true, `${receipt.reason ?? ''}\n${output}`)

  // The trusted material, as the Source holds it. The Adapter reports what it read and
  // deliberately reports no subtotal or total: the exact arithmetic is the board's.
  const input = factNamed(receipt, 'rulith.verified_calculation.calculation_input')
  assert.deepEqual(input?.args, {
    node: NODE,
    job_id: JOB.job_id,
    unit_price_cents: JOB.unit_price_cents,
    quantity: JOB.quantity,
    shipping_cents: JOB.shipping_cents,
  })
  for (const fact of factsOf(receipt)) {
    for (const name of ['subtotal_cents', 'total_cents']) {
      assert.equal(name in fact.args, false, `the intake Adapter must not carry ${name}; the board derives it`)
    }
  }
})

test('RT-EXAMPLE-3 intake produces its task structure from Source material, not from a Case identity', async () => {
  const { receipts, output } = await intake()
  assert.equal(receipts.length, 1, output)
  const [receipt] = receipts
  assert.equal(receipt.ok, true, `${receipt.reason ?? ''}\n${output}`)

  assert.equal(factNamed(receipt, 'task_seed'), undefined, 'Source intake cannot manufacture Agent task structure')
  assert.deepEqual(factsOf(receipt).map(row => row.predicate), ['rulith.verified_calculation.calculation_input'])
  for (const fact of factsOf(receipt)) {
    for (const value of Object.values(fact.args)) {
      assert.notEqual(value, 'forged-case-identity',
        'an ambient environment name must not be able to root the task tree')
    }
  }
  // The name may still be *named* — the Adapter's own comment explains why it is gone. What
  // must not come back is a reading of it, which is what would make the fact above depend on
  // an operator's environment again.
  assert.doesNotMatch(readFileSync(join(EXAMPLE, 'read-input.mjs'), 'utf8'), /process\.env\.RULITH_CASE_ID/,
    'the retired Case environment must not return as a second reading of identity')
})

test('RT-EXAMPLE-4 write and independent read-back agree on the exact board result', async () => {
  const { receipts, output } = await roundTrip()
  assert.equal(receipts.length, 3, output)
  const [, written, verified] = receipts
  assert.equal(written.ok, true, `${written.reason ?? ''}\n${output}`)
  assert.equal(verified.ok, true, `${verified.reason ?? ''}\n${output}`)

  // Calibration: these are the exact cents the board's `mul`/`add` derive from the shipped
  // input. A test that only compared the writer against the verifier would pass on two
  // adapters agreeing about the wrong number.
  assert.equal(SUBTOTAL, 259_800)
  assert.equal(TOTAL, 262_800)

  const record = factNamed(verified, 'rulith.verified_calculation.output_record')
  assert.deepEqual(record?.args, {
    node: NODE,
    job_id: JOB.job_id,
    subtotal_cents: SUBTOTAL,
    total_cents: TOTAL,
    status: 'completed',
  })
})

test('RT-EXAMPLE-5 the writer refuses a total the board did not derive, and leaves no file behind', async () => {
  const { receipts, output } = await roundTrip()
  assert.equal(receipts.length, 3, output)
  const [refused, written] = receipts
  assert.equal(refused.ok, false, 'a total that does not match the Source inputs must not be written')
  // The receipt names the Adapter that refused. It does not carry the Adapter's own
  // diagnostic: `handRun` rejects with the child-process error and the reason is capped at
  // 200 characters, which the command line alone exceeds. The Worker's stdout has the line.
  assert.match(String(refused.reason), /write-output\.mjs/, output)
  assert.match(output, /write_calculation_result: executor failed/, output)
  // The proof that the refusal wrote nothing is the *next* row: the writer refuses to
  // overwrite an output belonging to a different result, so a correct write landing after a
  // refused one is only possible if the refused one left the Source untouched.
  assert.equal(written.ok, true, `${written.reason ?? ''}\n${output}`)
})

test('RT-EXAMPLE-8 the Adapters read and write the granted Source root only, whatever the environment says', async () => {
  // The Adapters used to take their paths from `RULITH_CALC_INPUT` / `RULITH_CALC_OUTPUT` and,
  // failing that, from a directory beside the script. Either one turns an ambient environment
  // variable into the choice of what a receipt reports as governed Source material, and the
  // second one lets an Adapter granted no Source at all read *something* anyway.
  //
  // The bait is outside the Worker root on purpose, so it outlives the run and can be read
  // back: a decoy input with different numbers, and a decoy output path that must never come
  // into existence. Both names are set in the Worker's own environment — the strongest form of
  // the attack, since that is where an operator's shell profile would put them.
  const bait = mkdtempSync(join(tmpdir(), 'rulith-example-bait-'))
  const baitInput = join(bait, 'input.json')
  const baitOutput = join(bait, 'output.json')
  const BAIT_BYTES = JSON.stringify({ batch_id: 'bait-batch', job_id: 'bait-999', unit_price_cents: 1, quantity: 1, shipping_cents: 0 })
  writeFileSync(baitInput, BAIT_BYTES, 'utf8')
  try {
    const { receipts, output } = await runExample([
      exampleRow('load_calculation_input', {}, { work: 'inv_bait_read' }),
      exampleRow('write_calculation_result', {
        node: NODE,
        job_id: JOB.job_id,
        unit_price_cents: JOB.unit_price_cents,
        quantity: JOB.quantity,
        shipping_cents: JOB.shipping_cents,
        subtotal_cents: SUBTOTAL,
        total_cents: TOTAL,
      }, { work: 'inv_bait_write' }),
      exampleRow('verify_calculation_output', {
        node: NODE,
        job_id: JOB.job_id,
        subtotal_cents: SUBTOTAL,
        total_cents: TOTAL,
        status: 'completed',
      }, { work: 'inv_bait_verify' }),
    ], { env: { RULITH_CALC_INPUT: baitInput, RULITH_CALC_OUTPUT: baitOutput } })

    assert.equal(receipts.length, 3, output)
    for (const receipt of receipts) assert.equal(receipt.ok, true, `${receipt.reason ?? ''}\n${output}`)

    // Read: the governed material, not the bait's.
    const input = factNamed(receipts[0], 'rulith.verified_calculation.calculation_input')
    assert.equal(input?.args.job_id, JOB.job_id, 'the intake Adapter read a file the environment chose')
    assert.equal(input?.args.unit_price_cents, JOB.unit_price_cents)
    assert.notEqual(input?.args.job_id, 'bait-999')
    assert.equal(factNamed(receipts[0], 'task_seed'), undefined)

    // Write: nothing outside the Source root came into existence, and the bait was not edited.
    assert.equal(existsSync(baitOutput), false, 'the writer created a file outside the granted Source root')
    assert.equal(readFileSync(baitInput, 'utf8'), BAIT_BYTES, 'the bait input was modified')

    // And the legal Source still completes the whole flow: the independent read-back attests
    // the exact board result from the governed root.
    assert.deepEqual(factNamed(receipts[2], 'rulith.verified_calculation.output_record')?.args, {
      node: NODE, job_id: JOB.job_id, subtotal_cents: SUBTOTAL, total_cents: TOTAL, status: 'completed',
    })
  } finally {
    rmSync(bait, { recursive: true, force: true })
  }
})

test('RT-EXAMPLE-9 an Adapter granted no Source, or one of the wrong type, refuses instead of finding a file of its own', async () => {
  // The retired fallback was `join(HERE, 'data')` — a directory beside the script. An Adapter
  // dispatched Source-free would have read that and reported what it found as Source material.
  // Both refusals are the Adapter's own, and both are visible in the receipt.
  const { receipts, output } = await run('source-refusals', () => runExample([
    exampleRow('load_calculation_input', {}, { work: 'inv_bad_type' }),
  ], { sources: (root) => [{ name: SOURCE, type: 'db', access: join(root, 'runtime') }] }))
  assert.equal(receipts.length, 0, `a Source of the wrong type reached the Adapter: ${output}`)
  assert.match(output, /source_type_mismatch/, output)
  // The Worker refuses the type mismatch before the Adapter starts, which is the outer fence.
  // The Adapter's own refusal is proved directly, because a Worker that stopped checking would
  // otherwise leave the Adapter as the only thing standing between an environment and a read.
  for (const [name, adapterEnv] of [
    ['no Source at all', {}],
    ['a Source of the wrong type', { RULITH_SOURCE_ACCESS: process.cwd(), RULITH_SOURCE_TYPE: 'db' }],
    ['a relative Source root', { RULITH_SOURCE_ACCESS: 'data', RULITH_SOURCE_TYPE: 'file' }],
  ]) {
    for (const adapter of ['read-input.mjs', 'write-output.mjs', 'verify-output.mjs']) {
      const ran = spawnSync(process.execPath, [join(EXAMPLE, adapter), '{}'], {
        encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...adapterEnv },
      })
      assert.equal(ran.status, 2, `${adapter} with ${name} did not refuse: ${ran.stdout}${ran.stderr}`)
      assert.match(ran.stderr, /governed file Source|file Source/i, `${adapter} with ${name}: ${ran.stderr}`)
      assert.equal(ran.stdout, '', `${adapter} with ${name} produced rows without a Source`)
    }
  }
})

test('RT-EXAMPLE-10 the identifiers this example puts on the shared graph cannot be mistaken for authority-minted ones', () => {
  // The shared graph deliberately lets several Sources describe one business batch, so these
  // names are **not** namespaced per Source and business nodes are not copied for isolation.
  // What must hold instead is narrower: nothing the input file can say may produce an id that
  // reads as one the authority mints. Core mints `case-<n>` and `root-<n>`, and its reserved
  // host families are upper-case prefixes it owns (`CASECTX_`, `CASEROOT_`, `CAP_`, `EVD_`, …).
  // This example's ids are `CALC_<job_id>` and `CALC_BATCH_<batch_id>`, which collide with
  // none of them — for any value the Adapter accepts, including one chosen to try.
  const adapter = readFileSync(join(EXAMPLE, 'read-input.mjs'), 'utf8')
  assert.match(adapter, /node: `CALC_\$\{input\.job_id\}`/)
  assert.match(adapter, /task_root: `CALC_BATCH_\$\{input\.batch_id\}`/)
  const accepted = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
  for (const hostile of ['case-1', 'root-1', 'CASEROOT_1', 'CASECTX_1', 'CAP_1', 'EVD_1', 'SEALED']) {
    assert.ok(accepted.test(hostile), `${hostile} must be a value the Adapter would accept, or this proves nothing`)
    for (const minted of [`CALC_${hostile}`, `CALC_BATCH_${hostile}`]) {
      assert.doesNotMatch(minted, /^(?:case|root)-\d+$/, `${minted} reads as an authority-minted Case or root`)
      assert.match(minted, /^CALC_/, 'this example names its own nodes inside its own prefix')
    }
  }
  // And the acceptance test is the business key itself, which is how a Case reaches this work:
  // the Case Contract keys on `job_id`, so the leaf's acceptance test must be that same value
  // rather than a second identifier that only happens to travel beside it.
  assert.match(adapter, /acceptance_test: input\.job_id/)
  assert.deepEqual(RECIPE.capability.caseContracts[0].businessKey.arguments, ['job_id'])
})

test('RT-EXAMPLE-6 an invocation that names no Source, or another one, never reaches the Adapter', async () => {
  const { receipts, output } = await intake()
  // Three rows dispatched, one receipt: the two malformed selectors were refused before any
  // claim, and neither took the legal invocation beside it down.
  assert.equal(receipts.length, 1, `a refused invocation was executed anyway:\n${output}`)
  assert.equal((output.match(/source_selection_required/g) ?? []).length, 2, output)
  assert.match(output, /this invocation names no Source in its own arguments/, output)
  assert.match(output, /One execution may not run against two Sources/, output)
  assert.equal((output.match(/Claimed load_calculation_input/g) ?? []).length, 1,
    'nothing may be claimed for a dispatch the Worker refuses')
})

// The public quickstart now uses the real Local composer. Native tool argument correctness
// is exercised by the live Core/Gateway/Runtime acceptance instead of hand-copied tool JSON.
test('RT-EXAMPLE-11 the guide starts a configured Case through Local without scripted model tool calls', () => {
  const guide = readFileSync(join(EXAMPLE, 'README.md'), 'utf8')
  const contract = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/verified-calculation-recipe.json'), 'utf8')).capability.caseContracts[0]
  assert.ok(guide.includes(contract.caseType))
  for (const argument of contract.businessKey.arguments) assert.ok(guide.includes(argument))
  assert.match(guide, /rulith start --role agent\+worker/)
  assert.match(guide, /Local composer/)
  assert.match(guide, /Protocol troubleshooting \(optional\)/)
})

/**
 * Every tool call the guide prints, checked against the contract this Runtime vendors.
 *
 * The guide is copied by readers, so a call it prints is an instruction. Two of these were
 * wrong when the end-to-end run reached them — `CloseCase` took `caseId` rather than the
 * contract's `root`, and the Source-bound Actions were shown with no business arguments,
 * which the authority refuses — and neither is visible without either running the whole stack
 * or comparing against the served schema. This is the cheap half: tool membership, required
 * keys present, no key the schema does not declare.
 */
test('RT-EXAMPLE-7 every tool call the guide prints matches the vendored tool contract', () => {
  const contract = JSON.parse(readFileSync(join(ROOT, 'protocol', 'mcp-contract.json'), 'utf8'))
  const schemas = Object.fromEntries(contract.tools.map((tool) => [tool.name, tool.inputSchema]))
  const guide = readFileSync(join(EXAMPLE, 'README.md'), 'utf8')
  const printed = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)]
    .map(([, body]) => { try { return JSON.parse(body) } catch { return undefined } })
    .filter((row) => row !== undefined && typeof row.tool === 'string')
  assert.ok(printed.length >= 5, `only ${printed.length} tool calls were extracted from the guide — the scan lost the code fences`)

  for (const { tool, input } of printed) {
    const schema = schemas[tool]
    assert.ok(schema, `${tool} is not one of the seven tools this Runtime serves`)
    assert.ok(input !== null && typeof input === 'object' && !Array.isArray(input), `${tool} must be printed with an object input`)
    // `oneOf` (OpenCase) states alternative shapes; the branch that names every key present is
    // the one this call means, and at least one branch must accept it.
    const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [schema]
    const accepted = branches.some((branch) => {
      const allowed = Object.keys(branch.properties ?? {})
      const required = branch.required ?? []
      return Object.keys(input).every((key) => allowed.includes(key))
        && required.every((key) => Object.hasOwn(input, key))
    })
    assert.ok(accepted, `${tool} is printed with ${JSON.stringify(Object.keys(input))}, which no branch of its contracted schema accepts`)
  }

  // The two calls the guide must show in full, because the authority refuses the short form.
  const printedFor = (action) => printed.find((row) => row.input?.action === action)?.input
  for (const action of ['write_calculation_result', 'verify_calculation_output']) {
    const call = printedFor(action)
    assert.ok(call, `the guide no longer shows ${action}`)
    const declared = Object.keys(ACTIONS[action].execution.params ?? {}).filter(name => !Object.hasOwn(ACTIONS[action].bindings ?? {}, name))
    assert.deepEqual(Object.keys(call.args).sort(), ['source', ...declared].sort(),
      `${action} must expose only caller parameters; declared Board bindings remain internal`)
  }
})
