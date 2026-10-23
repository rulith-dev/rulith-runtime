// Optional installed-dsh contract check. Providers and tool plugins are loaded, never an app or model server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DELEGATION_TOOLS } from '../../harness/subagents.mjs';

test('installed dsh spawn/fork tools preserve route, depth and filter on both scheduling paths', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const load = (pkg) => import(pathToFileURL(path.join(root, pkg, 'lib/index.js')));
  const [spawn, fork, delegation, control] = await Promise.all([
    load('dsh-subagent-spawn-in-process'), load('dsh-subagent-fork-in-process'), load('dsh-tool-subagent'), load('dsh-tool-subagent-control'),
  ]);
  const YAML = createRequire(path.join(root, 'dsh-base/package.json'))('yaml');
  const headless = YAML.parse(fs.readFileSync(new URL('../../harness/rulith.cordis.yml', import.meta.url), 'utf8'), { logLevel: 'silent' });
  const disabled = headless.filter((entry) => entry.id?.includes('subagent'));
  assert.equal(disabled.length, 7);
  for (const entry of disabled) {
    assert.equal(entry.disabled, true); assert.equal(entry.config, undefined);
  }
  // The web overlay in dsh's entry-list dialect (JSON schema plus `!!js`), its expressions evaluated by the installed loader.
  const jsYaml = createRequire(path.join(root, 'dsh-app-boot', 'lib', 'index.js'))('js-yaml');
  const js = new jsYaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: (data) => typeof data === 'string', construct: (data) => ({ __jsExpr: data }) });
  const { interpolate } = await import(pathToFileURL(path.join(root, 'cordis-plugin-loader', 'lib', 'index.js')));
  const saved = process.env.RULITH_DSH_WEB_SEARCH_KEY;
  // D-1015c: children also get the web tools; web_search only when a search key reached dsh.
  for (const [searchKey, web] of [['test-search-key', ['web_search', 'web_fetch']], [undefined, ['web_fetch']]]) try {
    if (searchKey === undefined) delete process.env.RULITH_DSH_WEB_SEARCH_KEY; else process.env.RULITH_DSH_WEB_SEARCH_KEY = searchKey;
    const entries = jsYaml.load(fs.readFileSync(new URL('../../harness/web/rulith-web.cordis.yml', import.meta.url), 'utf8'), { schema: jsYaml.JSON_SCHEMA.extend(js) })
      .map((entry) => entry.config === undefined ? entry : { ...entry, config: interpolate({}, entry.config) });
    const row = (id) => entries.find((entry) => entry.id === id);
    assert.deepEqual(row('subagent').config, { maxDepth: 1, maxActiveSubagents: 4 });
    for (const id of ['subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control'])
      assert.equal(row(id).disabled, false, 'an existing disabled profile must be re-enabled');
    for (const id of ['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'fs-observation-policy', 'tool-plugin-manager', 'tool-jobs', 'tool-subagent-list-agents'])
      assert.equal(row(id).disabled, true);
    assert.equal(row('tool-web').disabled, false, 'D-1015c: the read-only web tools are on');
    const providers = new Map(), definitions = [], requests = [];
    const ctx = { get() {}, on() {}, sessionProjections: { register() {} },
      tools: { register(def) { definitions.push(def); return () => {}; } },
      systemPrompt: { section() {}, getSectionOrder: () => 1 },
      subagents: { registerProvider: (p) => providers.set(p.name, p), getProvider: (name) => providers.get(name), resolveMaxDepth: (depth) => depth,
        async startContinuable(spec) { requests.push(['continuable', spec.request]); return { childId: 'child' }; },
        async start(provider, request) { requests.push([provider, request]); return { id: 'child',
          result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'closing text' }] }), dispose() {} }; },
      },
    };
    spawn.apply(ctx, { providerName: 'spawn' }); fork.apply(ctx, { providerName: 'fork' });
    assert.equal(providers.get('spawn').inheritsParentContext, false); assert.equal(providers.get('fork').inheritsParentContext, true);
    assert.equal(typeof providers.get('fork').prepareContinuable, 'function');
    for (const id of ['tool-subagent', 'tool-subagent-fork']) delegation.apply(ctx, row(id).config);
    control.apply(ctx);
    assert.deepEqual(definitions.map((d) => d.name), [...DELEGATION_TOOLS]);
    const agent = { options: { provider: 'chosen', model: 'chosen-model' }, session: { header: { id: 'main' }, requestHeader() {} } };
    const exec = { agent, signal: new AbortController().signal };
    const doc = fs.readFileSync(new URL('../../harness/model-visible.md', import.meta.url), 'utf8');
    assert.ok(doc.includes(JSON.stringify(definitions.map(({ name, description, parameters }) => ({ name, description, parameters })), null, 2)));
    for (const def of definitions.slice(0, 2)) {
      assert.equal(def.parameters.provider, undefined, 'model route cannot be overridden');
      assert.equal((await def.execute({ description: 'task', prompt: 'work' }, exec)).kind, 'continuable');
      assert.equal((await def.execute({ description: 'task', prompt: 'work', run_in_background: false }, exec)).kind, 'foreground');
    }
    for (const [, request] of requests) {
      assert.equal(request.maxDepth, 1); assert.deepEqual(request.toolFilter, { allow: ['Get', 'Set', 'Execute', ...web] });
      assert.equal(request.agentOptions, undefined, 'dsh provider inherits the main route');
    }
  } finally {
    if (saved === undefined) delete process.env.RULITH_DSH_WEB_SEARCH_KEY; else process.env.RULITH_DSH_WEB_SEARCH_KEY = saved;
  }
});
