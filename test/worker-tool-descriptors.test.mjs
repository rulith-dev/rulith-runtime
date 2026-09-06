// SPDX-License-Identifier: Apache-2.0
/**
 * One standing for every Tool the Worker has (board-spec TOOL-08).
 *
 * A built-in and a Tool-Manifest entry are the same family: same resolver, same digest
 * pinning the definition, same advertised descriptor, same Connection lock. Two things
 * used to break that, and both were invisible from outside this process:
 *
 *   · the advertisement carried only id / digest / sourceTypes, so a host could not
 *     synthesize a direct Action for a Tool it had never seen declared in a pack;
 *   · a Tool absent from the id list the Cloud returned beside the Source definitions
 *     was dropped from the advertisement silently, making the Worker a second — and
 *     unlogged — authorization point beside the Console lock.
 *
 * The arms below drive the real functions and the real handlers. A declared contract is
 * only worth what the handler beside it does, so RT-WK-TOOLS-3 executes the write Tools
 * on a temporary workspace and compares what they accept and produce against what the
 * advertisement claims, rather than reading both from the same table.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  builtinSourceTools, builtinWorkspaceTools, execute, toolFromSpec, toolKind,
  workerToolDescriptor, workerToolManifest, workerToolsOf,
} from '../worker/rulith-worker.mjs'

const DESCRIPTOR_FIELDS = ['digest', 'id', 'kind', 'params', 'returns', 'sourceTypes']

/** A manifest exercising every adapter, including one Tool no pack anywhere references. */
const DECLARED = {
  format: 'rulith-worker-tools/1',
  tools: {
    'acme.catalog.get@1': { adapter: 'http', sourceTypes: ['http'], entry: '/items/{item_id}',
      fence: { method: 'GET' }, params: { item_id: 'string' },
      returns: [{ predicate: 'acme.catalog.stock', args: { item_id: '$item_id', in_stock: '$in_stock' } }] },
    'acme.webhook.post@1': { adapter: 'http', sourceTypes: ['http'], entry: '/events', fence: { method: 'POST' } },
    'acme.endpoint.unstated@1': { adapter: 'http', sourceTypes: ['http'], entry: '/thing' },
    'acme.orders.lookup@1': { adapter: 'db-query', sourceTypes: ['db'], entry: 'SELECT status FROM orders WHERE id={order_id}' },
    'acme.orders.update@1': { adapter: 'db-exec-fenced', sourceTypes: ['db'], entry: 'UPDATE orders SET status={status} WHERE id={order_id}' },
    'acme.report.publish@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/publish-report.mjs' },
    'acme.erp.lookup@1': { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'orders.lookup' },
    'acme.erp.ship@1': { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'orders.ship', kind: 'write' },
    'acme.notes.write@1': { adapter: 'workspace', sourceTypes: ['file'], entry: 'write_text' },
  },
}

function everyInstalledTool() {
  return { ...workerToolsOf(DECLARED), ...builtinWorkspaceTools('read-write'), ...builtinSourceTools() }
}

// ── RT-WK-TOOLS-1 ────────────────────────────────────────────────────────────

test('RT-WK-TOOLS-1: every advertised Tool carries kind, params and returns in one shape', () => {
  const advertised = workerToolManifest(everyInstalledTool())
  assert.equal(advertised.length, Object.keys(everyInstalledTool()).length)
  assert.ok(advertised.length >= 18, `only ${advertised.length} Tools reached the advertisement`)

  for (const descriptor of advertised) {
    assert.deepEqual(Object.keys(descriptor).sort(), DESCRIPTOR_FIELDS,
      `${descriptor.id} is advertised in a different shape from the rest`)
    assert.match(descriptor.id, /^[a-z][a-z0-9_.-]{1,95}@[1-9][0-9]*$/)
    assert.match(descriptor.digest, /^[a-f0-9]{64}$/)
    assert.ok(Array.isArray(descriptor.sourceTypes) && descriptor.sourceTypes.length > 0)
    assert.ok(['read', 'write', 'run'].includes(descriptor.kind), `${descriptor.id} advertises kind ${descriptor.kind}`)
    const params = descriptor.params
    assert.ok(params && typeof params === 'object' && !Array.isArray(params), `${descriptor.id}.params is not a table`)
    for (const [name, type] of Object.entries(params)) {
      assert.match(name, /^[a-z][a-z0-9_]{0,63}$/)
      assert.ok(['string', 'number', 'boolean', 'json'].includes(type.replace(/\?$/, '')), `${descriptor.id}.params.${name} is declared ${type}`)
    }
    // `returns` is the result-fact mapping the cloud installs verbatim — never a column
    // table, which the cloud's Poll refuses and the Board's tool-pack parser cannot read.
    assert.ok(Array.isArray(descriptor.returns), `${descriptor.id}.returns is not a result-fact mapping`)
    for (const row of descriptor.returns) {
      assert.match(row.predicate, /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/, `${descriptor.id} lands rows as ${row.predicate}`)
      assert.ok(Object.keys(row.args).length > 0, `${descriptor.id}.returns maps no column`)
      for (const [name, column] of Object.entries(row.args)) {
        assert.match(name, /^[a-z][a-z0-9_]{0,63}$/)
        assert.match(column, /^\$[a-z][a-z0-9_]{0,63}$/, `${descriptor.id}.returns reads ${name} from ${column}`)
      }
    }
    if (descriptor.id.startsWith('rulith.')) {
      assert.ok(descriptor.returns.length > 0, `${descriptor.id} is a shipped Tool and must say what its rows land as`)
      assert.ok(descriptor.returns.every((row) => row.predicate.startsWith('rulith.worker.') && row.args.source === '$source'),
        `${descriptor.id} must land rulith.worker.* facts that carry the Source they came from`)
    }
  }

  // Built-in and declared are one family: pick one of each and compare their shapes.
  const builtin = advertised.find((row) => row.id === 'rulith.workspace.write_text@1')
  const declared = advertised.find((row) => row.id === 'acme.catalog.get@1')
  assert.deepEqual(Object.keys(builtin).sort(), Object.keys(declared).sort())
  assert.deepEqual(builtin.params, { path: 'string', text: 'string' })
  assert.deepEqual(builtin.returns, [{ predicate: 'rulith.worker.file_written', args: { source: '$source', path: '$path', digest: '$digest' } }])
  assert.deepEqual(declared.params, { item_id: 'string' })
  assert.deepEqual(declared.returns, [{ predicate: 'acme.catalog.stock', args: { item_id: '$item_id', in_stock: '$in_stock' } }])

  // The same fixed contract reaches a manifest entry that names a shipped handler:
  // it runs the same code, so it cannot advertise a different contract.
  const manifestWorkspace = advertised.find((row) => row.id === 'acme.notes.write@1')
  assert.deepEqual(manifestWorkspace.params, builtin.params)
  assert.deepEqual(manifestWorkspace.returns, builtin.returns)
  assert.equal(manifestWorkspace.kind, 'write')

  // kind derivation, each adapter named once. Every guess falls to write.
  assert.deepEqual(Object.fromEntries(advertised.map((row) => [row.id, row.kind])), {
    'acme.catalog.get@1': 'read',
    'acme.webhook.post@1': 'write',
    'acme.endpoint.unstated@1': 'write',
    'acme.orders.lookup@1': 'read',
    'acme.orders.update@1': 'write',
    'acme.report.publish@1': 'run',
    'acme.erp.lookup@1': 'read',
    'acme.erp.ship@1': 'write',
    'acme.notes.write@1': 'write',
    'rulith.workspace.list@1': 'read',
    'rulith.workspace.count@1': 'read',
    'rulith.workspace.search@1': 'read',
    'rulith.workspace.read_text@1': 'read',
    'rulith.workspace.read_json@1': 'read',
    'rulith.workspace.hash@1': 'read',
    'rulith.workspace.write_text@1': 'write',
    'rulith.workspace.write_json@1': 'write',
    'rulith.mcp.discover@1': 'read',
  })
  assert.equal(toolKind({ adapter: 'nothing-this-worker-knows' }), 'write',
    'an unrecognized adapter must not be advertised as a read')

  // The pins clients already carry. Stating kind/params/returns describes what `entry`
  // already fixed, so no built-in digest may move: a moved digest is refused at dispatch
  // against the Connection pin, and every deployed Worker would stop claiming work.
  assert.deepEqual(Object.fromEntries(advertised
    .filter((row) => row.id.startsWith('rulith.'))
    .map((row) => [row.id, row.digest])), {
    'rulith.workspace.list@1': 'e66ce0387c343d9d7aeff683977e980e0664cb11b2dfda49092a5a58ad29b27b',
    'rulith.workspace.count@1': '124c07af84f51b8e269602a99138d2fbcb469aa03564cb5660c62c08fa7ec5d9',
    'rulith.workspace.search@1': '98fd70212067ab79adaf0e396089939da1a4d9cf945842333ee41fbdbc9011c0',
    'rulith.workspace.read_text@1': '83dbfa3b027f4ea81ad602655fc3cb7e0b6b36edb9ffc35e998ad4eea924f635',
    'rulith.workspace.read_json@1': 'e888b95d0e50a9f924a0ea300907bad74601f50c548b571bc59b9a587df92111',
    'rulith.workspace.hash@1': 'e1db248c31fd4f1eb638b227bda7046546c291e2d00d0748eb7580240d192b8b',
    'rulith.workspace.write_text@1': '55fa5db6a65d88b69e262eceaafd3f47f02b13ff00507eafb801192d32cc40da',
    'rulith.workspace.write_json@1': '0efca0ee8ba32da13648648ac57c30566500f47a72cd892b2be048e0614c8b37',
    'rulith.mcp.discover@1': '85b8b3b4edd3e92baf997de6a0c9a19aa87eb7dcb60d74416e270d2f900456f3',
  })

  // A declared contract is part of the definition, so it does travel in the digest:
  // an operator cannot change what a Tool claims to take without the pin moving.
  const same = workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.thing@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/thing.mjs' },
  } })['acme.thing@1']
  const widened = workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.thing@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/thing.mjs', params: { anything: 'json' } },
  } })['acme.thing@1']
  assert.notEqual(same.digest, widened.digest)

  // A malformed contract is refused where the operator is still reading the output.
  const declare = (extra) => () => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.thing@1': { adapter: 'run', sourceTypes: ['file'], entry: 'adapters/thing.mjs', ...extra },
  } })
  assert.throws(declare({ kind: 'delete' }), /kind must be read, write, or run/)
  // An entry naming a handler that ships here cannot restate that handler's contract:
  // a declaration the resolver would ignore reads exactly like one that governs.
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.notes.write@1': { adapter: 'workspace', sourceTypes: ['file'], entry: 'write_text', params: { path: 'string' } },
  } }), /names the built-in "write_text" implementation, so its params cannot be redeclared/)
  assert.throws(() => workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.mcp.discover@1': { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'discover', kind: 'write' },
  } }), /cannot be redeclared/)
  assert.throws(declare({ params: { 'Item Id': 'string' } }), /params\.Item Id/)
  assert.throws(declare({ params: { item_id: 'date' } }), /params\.item_id/)
  // `returns` is the result-fact mapping, never a column table: a table would advertise a
  // contract the cloud's Poll refuses and the Board's tool-pack parser cannot install.
  assert.throws(declare({ returns: { in_stock: 'boolean' } }), /returns must be an array of at most 32 result-fact rows/)
  assert.throws(declare({ returns: ['in_stock'] }), /returns\[0\] must be a result-fact row/)
  assert.throws(declare({ returns: [{ predicate: 'Stock', args: { in_stock: '$in_stock' } }] }), /returns\[0\]\.predicate must be a dotted lower-case predicate/)
  assert.throws(declare({ returns: [{ predicate: 'acme.stock', args: { in_stock: 'in_stock' } }] }), /returns\[0\]\.args\.in_stock must reference a result column/)
  assert.doesNotThrow(declare({ kind: 'read', params: { item_id: 'string' }, returns: [{ predicate: 'acme.stock', args: { in_stock: '$in_stock' } }] }))

  // Empty is a declaration, not an omission, and this machine may not refuse one. Each of
  // these was refused here until the contract wrote the rule down, and each refusal was a
  // local availability condition standing in for a transport rule: a Tool that attests
  // nothing, a row that lands a bare proposition, and a Tool that reads through no Source
  // are all legal reports. The last one is the operator-Manifest gate specifically — an
  // operator with a Source-free Tool had nothing truthful to write in `sourceTypes`.
  assert.doesNotThrow(declare({ returns: [] }))
  assert.doesNotThrow(declare({ returns: [{ predicate: 'acme.reachable', args: {} }] }))
  const sourceFree = workerToolsOf({ format: 'rulith-worker-tools/1', tools: {
    'acme.calculate@1': { adapter: 'run', sourceTypes: [], entry: 'adapters/calc.mjs', kind: 'run', params: { value: 'number' }, returns: [] },
  } })
  assert.deepEqual(workerToolDescriptor('acme.calculate@1', sourceFree['acme.calculate@1']), {
    id: 'acme.calculate@1', digest: sourceFree['acme.calculate@1'].digest,
    sourceTypes: [], kind: 'run', params: { value: 'number' }, returns: [],
  }, 'a Source-free Tool must advertise an empty sourceTypes rather than borrow a type it does not read')
  // And the accredited seven are still the only ones nameable.
  assert.throws(declare({ sourceTypes: ['filesystem'] }), /accredited Source types/)
  assert.throws(declare({ sourceTypes: 'file' }), /accredited Source types/)
})

// ── RT-WK-TOOLS-2 ────────────────────────────────────────────────────────────

test('RT-WK-TOOLS-2: a Tool no pack references is advertised too — the Worker authorizes nothing', () => {
  const tools = everyInstalledTool()
  const advertised = workerToolManifest(tools)
  const ids = advertised.map((row) => row.id)

  // `acme.endpoint.unstated@1` appears in no Capability, no Action, and no id list from
  // Cloud. It is installed on this machine, so it is advertised; the Console lock on the
  // Connection decides whether it ever receives work.
  assert.ok(ids.includes('acme.endpoint.unstated@1'))
  assert.deepEqual(ids.sort(), Object.keys(tools).sort(),
    'the advertisement must be exactly what this Worker has, with nothing filtered out')

  // The old filter took a second argument and dropped everything outside it. Passing one
  // now changes nothing: there is no local authorization surface left to reach.
  assert.deepEqual(workerToolManifest(tools, new Set(['rulith.workspace.count@1'])).map((row) => row.id).sort(),
    ids.sort(), 'a Worker-side authorization list must have no effect on the advertisement')
  assert.equal(workerToolManifest.length, 1, 'workerToolManifest must not take an authorization argument')
  // Comments may still say what the filter was; the code may not still do it.
  const executable = readFileSync(new URL('../worker/rulith-worker.mjs', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/).map((line) => line.replace(/(^|\s)\/\/.*$/, '')).join('\n')
  assert.ok(executable.includes('workerToolManifest'), 'the comment stripper lost the source')
  assert.doesNotMatch(executable, /AUTHORIZED_TOOL_IDS|\.toolIds/,
    'the Cloud id list must not be read back into a local filter')

  // Poll carries the advertisement unchanged: one function, one list.
  const poll = { kind: 'Poll', tools: workerToolManifest(tools) }
  assert.deepEqual(poll.tools, advertised)
  assert.deepEqual(poll.tools.map((row) => row.id).sort(), ids.sort())
})

// ── RT-WK-TOOLS-3 ────────────────────────────────────────────────────────────

test('RT-WK-TOOLS-3: the built-in write Tools accept and produce exactly what they advertise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-tool-descriptor-'))
  const previous = process.env.RULITH_WORKSPACE_TOOLS
  try {
    process.env.RULITH_WORKSPACE_TOOLS = 'read-write'
    const tools = builtinWorkspaceTools('read-write')
    const sources = { workspace: { access: root, type: 'file' } }

    /** Drive the Tool exactly as a work item does: the advertised contract, nothing else. */
    const run = async (id, args) => {
      const descriptor = workerToolDescriptor(id, tools[id])
      const local = toolFromSpec(JSON.stringify({
        name: id, kind: descriptor.kind, impl: 'worker-tool', sourceTypes: ['file'], exec: id,
        params: descriptor.params,
        // The advertised mapping is the mapping: a `$column` the handler does not produce
        // fails inside `resultFactsFromRows` rather than reading as an empty fact.
        returns: descriptor.returns,
      }), JSON.stringify({ ...args, source: 'workspace' }), tools, descriptor.digest, sources, 'workspace')
      return { descriptor, executed: await execute(id, args, { [id]: local }, sources) }
    }

    for (const [id, args, expectedBytes] of [
      ['rulith.workspace.write_text@1', { path: 'notes/report.txt', text: 'alpha\nbeta\n' }, 11],
      ['rulith.workspace.write_json@1', { path: 'out/result.json', value: { ok: true, count: 2 } }, 31],
    ]) {
      const { descriptor, executed } = await run(id, args)
      assert.equal(descriptor.kind, 'write')

      // What it produces: the receipt its advertisement promises, landed from the row the
      // handler wrote. `digest` is the hash of the bytes now on disk — the hash `read_text`
      // reports for the same file — so a read-back is checkable against this receipt.
      assert.deepEqual(executed.facts, [{ predicate: 'rulith.worker.file_written', args: {
        source: 'workspace', path: args.path, digest: createHash('sha256').update(readFileSync(join(root, args.path))).digest('hex'),
      } }], `${id} did not land the receipt its advertisement promises`)
      assert.deepEqual(JSON.parse(String(executed.result)), { path: args.path, bytes: expectedBytes })
      assert.equal(readFileSync(join(root, args.path), 'utf8').length, expectedBytes)
    }

    assert.deepEqual(JSON.parse(readFileSync(join(root, 'out', 'result.json'), 'utf8')), { ok: true, count: 2 })
    assert.equal(readFileSync(join(root, 'notes', 'report.txt'), 'utf8'), 'alpha\nbeta\n')

    // What it accepts: the advertised table is the whole door. Both halves are checked —
    // a required argument missing, and one the advertisement never named.
    await assert.rejects(run('rulith.workspace.write_text@1', { path: 'notes/report.txt' }),
      /missing required parameter\(s\): text/)
    await assert.rejects(run('rulith.workspace.write_text@1', { path: 'a.txt', text: 'x', mode: 'append' }),
      /undeclared parameter\(s\): mode/)
    await assert.rejects(run('rulith.workspace.write_text@1', { path: 'a.txt', text: 7 }),
      /text must be string/)
    await assert.rejects(run('rulith.workspace.write_json@1', { path: 'a.json' }),
      /missing required parameter\(s\): value/)

    // `value: "json"` is the honest declaration of what write_json takes. Each of these
    // is a whole JSON value the handler serializes, and the declared table lets every
    // one of them through the same door a scalar goes through.
    for (const value of [{ nested: { ok: true } }, [1, 2, 3], 'plain', 42, false, null]) {
      const { executed } = await run('rulith.workspace.write_json@1', { path: 'shapes.json', value })
      assert.deepEqual(JSON.parse(readFileSync(join(root, 'shapes.json'), 'utf8')), value)
      assert.equal(executed.facts[0].args.path, 'shapes.json')
    }
  } finally {
    if (previous === undefined) delete process.env.RULITH_WORKSPACE_TOOLS
    else process.env.RULITH_WORKSPACE_TOOLS = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// ── RT-WK-TOOLS-4 ────────────────────────────────────────────────────────────

test('RT-WK-TOOLS-4: every built-in read Tool lands the facts its advertisement maps, from a real workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rulith-tool-descriptor-read-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'a.txt'), 'alpha\nbeta gamma\n')
    writeFileSync(join(root, 'docs', 'b.json'), '{"ok":true}\n')
    const tools = builtinWorkspaceTools('read')
    const sources = { workspace: { access: root, type: 'file' } }

    /** Drive one read Tool exactly as a direct Action does: the advertisement is the whole spec. */
    const land = async (id, args) => {
      const descriptor = workerToolDescriptor(id, tools[id])
      const local = toolFromSpec(JSON.stringify({
        name: id, kind: descriptor.kind, impl: 'worker-tool', sourceTypes: ['file'], exec: id,
        params: descriptor.params, returns: descriptor.returns,
      }), JSON.stringify({ ...args, source: 'workspace' }), tools, descriptor.digest, sources, 'workspace')
      const executed = await execute(id, args, { [id]: local }, sources)
      assert.ok(executed.facts.length > 0, `${id} landed no fact from a workspace that has rows for it`)
      for (const fact of executed.facts) {
        assert.equal(fact.predicate, descriptor.returns[0].predicate)
        assert.deepEqual(Object.keys(fact.args).sort(), Object.keys(descriptor.returns[0].args).sort(),
          `${id} landed a fact whose arguments are not the advertised ones`)
        assert.equal(fact.args.source, 'workspace', `${id} must land the Source the row came from`)
      }
      return executed.facts
    }

    const listed = await land('rulith.workspace.list@1', { path: 'docs' })
    assert.deepEqual(listed.map((fact) => [fact.args.path, fact.args.entry_type]).sort(), [['docs/a.txt', 'file'], ['docs/b.json', 'file']])
    const [counted] = await land('rulith.workspace.count@1', { path: 'docs', recursive: false })
    assert.deepEqual([counted.args.file_count, counted.args.directory_count, counted.args.recursive], [2, 0, false])
    const found = await land('rulith.workspace.search@1', { query: 'gamma', path: 'docs' })
    assert.deepEqual(found.map((fact) => [fact.args.path, fact.args.line, fact.args.column, fact.args.text]), [['docs/a.txt', 2, 6, 'beta gamma']])
    const [text] = await land('rulith.workspace.read_text@1', { path: 'docs/a.txt' })
    assert.equal(text.args.text, 'alpha\nbeta gamma\n')
    const [json] = await land('rulith.workspace.read_json@1', { path: 'docs/b.json' })
    assert.equal(json.args.json, '{"ok":true}')
    const [hashed] = await land('rulith.workspace.hash@1', { path: 'docs/a.txt' })
    assert.equal(hashed.args.sha256, createHash('sha256').update('alpha\nbeta gamma\n').digest('hex'))
    assert.equal(hashed.args.size, 17)
    // A read-back is checkable against a write receipt: both hash the same bytes the same way.
    assert.equal(text.args.digest, hashed.args.sha256)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
