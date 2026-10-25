// SPDX-License-Identifier: Apache-2.0
/**
 * What `npm pack` puts in the `rulith` package (0.19.0: the app ships in it). The tarball must carry everything the
 * installed command loads — the Runtime, the app's host and browser halves, the general kit, the protocol bundles — and
 * nothing that is only for this repository: tests, fixtures, scripts, settings files that can carry credentials, the
 * app's experimental headless role, or anything that looks like a key.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** `npm pack --dry-run --json`, without the prepack hook (which runs this suite). */
function packedFiles() {
  // As packaging.test.mjs finds npm: the one running this suite, else the one beside this Node.
  const npm = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
  const run = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(run.status, 0, run.stderr)
  const [packed] = JSON.parse(run.stdout)
  return { packed, files: new Set(packed.files.map((file) => file.path.split('\\').join('/'))) }
}

/** The relative modules (and files read through `new URL(…, import.meta.url)`) an entry reaches. */
function reachable(entries) {
  const seen = new Set()
  const queue = [...entries]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.(mjs|js)$/.test(file)) continue
    const source = readFileSync(join(ROOT, file), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\(\s*|new URL\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = posix.normalize(posix.join(posix.dirname(file), match[1]))
      // A directory reached this way (the browser plugin) ships whole; its files are checked below.
      if (existsSync(join(ROOT, target)) && !target.endsWith('/')) queue.push(target)
    }
  }
  return seen
}

test('the package carries the command, the app, the Runtime and the kit, and nothing for this repository only', () => {
  const { packed, files } = packedFiles()
  assert.equal(packed.name, 'rulith')
  assert.equal(packed.version, pkg.version)

  // The command, and everything it can load: the app's launcher and host plugin, the browser plugin, the Runtime.
  assert.deepEqual(pkg.bin, { rulith: 'local/rulith-local.mjs' })
  const entries = ['local/rulith-local.mjs', 'app/harness/web/start-deep-rulith.mjs', 'app/harness/web/rulith-runtime.mjs',
    'app/harness/web/rulith-web-gate.mjs', 'agent/rulith-agent.mjs', 'worker/rulith-worker.mjs', 'kits/general/installer.mjs']
  for (const file of reachable(entries)) {
    const directory = existsSync(join(ROOT, file)) && !/\.[a-z]+$/i.test(file)
    if (!directory) assert.ok(files.has(file), `${file} is loaded by the installed command but not packed`)
  }
  for (const file of ['app/harness/web/rulith-web.cordis.yml', 'app/harness/runtime-persona.txt',
    'app/harness/web/rulith-dsh-ui/package.json', 'app/harness/web/rulith-dsh-ui/lib/client.js', 'app/harness/web/rulith-dsh-ui/lib/index.js',
    'app/NOTICE', 'app/README.md', 'LICENSE', 'README.md', 'CHANGELOG.md', 'artifact-manifest.json'])
    assert.ok(files.has(file), `${file} is not packed`)
  const manifest = JSON.parse(readFileSync(join(ROOT, 'artifact-manifest.json'), 'utf8'))
  for (const file of Object.keys(manifest.files)) assert.ok(files.has(file), `${file} is in the artifact manifest but not packed`)

  // Nothing for this repository only.
  for (const file of files) {
    assert.doesNotMatch(file, /^(test|scripts|conformance|\.github|node_modules|app\/test|app\/docs)\//, `${file} is packed`)
    assert.doesNotMatch(file, /(^|\/)(fixtures?|__tests__)\//, `${file} is packed`)
    assert.doesNotMatch(file, /\.test\.m?js$|\.tgz$|(^|\/)\.env|\.(pem|key|p12|pfx)$/i, `${file} is packed`)
    assert.doesNotMatch(file, /(^|\/)(deep-rulith[^/]*\.json|Deep-Rulith\.cmd|local\.json|registry\.json|manager\.key|worker-secrets\.json)$/,
      `${file} can carry credentials and is packed`)
  }
  // The app's experimental headless role and the harness's development helpers stay in the repository.
  for (const file of ['app/harness/rulith.cordis.yml', 'app/harness/rulith-dsh-role.mjs', 'app/harness/host-utils.mjs',
    'app/harness/runtime-kit.mjs', 'app/harness/worker-inventory.mjs'])
    assert.equal(files.has(file), false, `${file} is packed`)
  // The retired English workbench is gone from the package as from the tree.
  for (const file of ['local/manager-ui.mjs', 'local/local-ui.mjs', 'local/setup-ui.mjs', 'local/worker-tools-ui.mjs',
    'local/theme.mjs', 'docs/local-authoring.md', 'docs/local-setup.md'])
    assert.equal(files.has(file), false, `${file} is packed`)
})

test('the command is an executable Node module and the app\'s dependencies are the ones its code imports', () => {
  assert.match(readFileSync(join(ROOT, pkg.bin.rulith), 'utf8'), /^#!\/usr\/bin\/env node\r?\n/)
  assert.equal(pkg.engines.node, '>=22.19')
  // The app loads dsh through its launcher; its own host code imports these, at the versions dsh installs.
  const dsh = pkg.dependencies['@deepseek-ai/dsh']
  assert.match(dsh, /^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/, 'dsh is pinned exactly')
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-web-search-deepseek'])
    assert.equal(pkg.dependencies[name], dsh, name)
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh'], undefined)
  // The launcher writes the dsh profile with `yaml` (createRequire, which the import scan below does not see).
  assert.match(readFileSync(join(ROOT, 'app/harness/web/start-deep-rulith.mjs'), 'utf8'), /createRequire\(import\.meta\.url\)\('yaml'\)/)
  assert.ok(pkg.dependencies.yaml, 'yaml is a dependency of its own, not a hoisted one of dsh')
  const imported = new Set()
  for (const file of reachable(['app/harness/web/start-deep-rulith.mjs', 'app/harness/web/rulith-runtime.mjs', 'local/rulith-local.mjs'])) {
    if (!/\.mjs$/.test(file)) continue
    for (const match of readFileSync(join(ROOT, file), 'utf8').matchAll(/(?:from\s+|import\(\s*)['"]((?:@[a-z0-9._-]+\/)?[a-z0-9_-][a-z0-9._-]*(?::[a-z0-9_/-]+)?(?:\/[A-Za-z0-9._-]+)*)['"]/g)) {
      if (match[1].startsWith('node:')) continue
      imported.add(match[1].split('/').slice(0, match[1].startsWith('@') ? 2 : 1).join('/'))
    }
  }
  for (const name of imported)
    assert.ok(pkg.dependencies[name] || pkg.optionalDependencies?.[name], `${name} is imported by the app or the Runtime but not a dependency`)
  assert.ok(imported.has('@deepseek-ai/dsh-llm-pi-ai') && imported.has('@modelcontextprotocol/sdk'), [...imported].join(', '))
})
