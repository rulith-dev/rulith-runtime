// Evaluate installed dsh layers, including presets; no app or model server is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { toolsOf, DELEGATION_TOOLS, conversationKey, handOf } from '../../harness/subagents.mjs';

test('installed dsh: both profiles disable delegation providers and tools, including preset layers', {
  skip: !process.env.DSH_MODULES_DIR && 'set DSH_MODULES_DIR to the installed dsh node_modules',
}, async () => {
  const root = path.join(process.env.DSH_MODULES_DIR, '@deepseek-ai');
  const require = createRequire(path.join(root, 'dsh-app-boot/lib/index.js'));
  const yaml = require('js-yaml');
  const js = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (data) => ({ __jsExpr: data }) });
  const load = (file) => yaml.load(fs.readFileSync(file, 'utf8'), { schema: yaml.JSON_SCHEMA.extend(js) });
  const { composeEntries } = await import(pathToFileURL(path.join(root, 'dsh-app-boot/lib/index.js')));
  const ids = ['subagent', 'subagent-spawn-in-process', 'subagent-fork-in-process', 'tool-subagent-control',
    'tool-subagent-list-agents', 'tool-subagent', 'tool-subagent-fork'];
  for (const profile of ['headless', 'web']) {
    const overlay = load(new URL(profile === 'web' ? '../../harness/web/rulith-web.cordis.yml' : '../../harness/rulith.cordis.yml', import.meta.url));
    for (const id of ids) {
      const entry = overlay.find((entry) => entry.id === id);
      assert.equal(entry?.disabled, true, id); assert.equal(entry.config, undefined, id);
    }
    const bundle = profile === 'web' ? 'dsh-web-app' : 'dsh-headless';
    const patches = JSON.parse(fs.readFileSync(path.join(root, bundle, 'package.json'), 'utf8')).dsh.bundle.patch;
    const layers = [load(path.join(root, 'dsh-base/cordis.patch.yml')),
      ...(Array.isArray(patches) ? patches : [patches]).map((file) => load(path.join(root, bundle, file))), overlay];
    const enabled = [];
    const walk = (entries) => { for (const entry of entries) if (!entry.disabled) {
      enabled.push(entry); if (entry.group && Array.isArray(entry.config)) walk(entry.config);
    } };
    walk(composeEntries(layers));
    assert.deepEqual(enabled.filter((entry) => /subagent/.test(entry.id) || /subagent/.test(entry.name ?? '')), []);
  }
});

test('historical child identity remains available without delegation in any tool allowlist', () => {
  const child = { session: { id: 'old-child', header: { origin: 'subagent', parentSession: 'old-parent', delegationDepth: 1 } } };
  assert.equal(conversationKey(child), 'dsh:old-parent'); assert.equal(handOf(child), 'old-child');
  for (const agent of [{}, child]) for (const name of DELEGATION_TOOLS) assert.ok(!toolsOf(agent, ['web_fetch']).includes(name));
});
