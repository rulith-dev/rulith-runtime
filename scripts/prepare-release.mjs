// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const version = String(process.argv[2] ?? '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('usage: npm run release:prepare -- <major.minor.patch>')
}

const read = (file) => readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n')
const write = (file, value) => writeFileSync(resolve(root, file), value.replace(/\r\n/g, '\n'))
const hash = (file) => createHash('sha256').update(read(file), 'utf8').digest('hex')

for (const file of ['package.json', 'package-lock.json']) {
  const json = JSON.parse(read(file))
  json.version = version
  if (file === 'package-lock.json' && json.packages?.['']) json.packages[''].version = version
  write(file, `${JSON.stringify(json, null, 2)}\n`)
}

const runtimeTestFile = 'test/runtime.test.mjs'
let runtimeTest = read(runtimeTestFile)
if (!/assert\.equal\(pkg\.version, '\d+\.\d+\.\d+'\)/.test(runtimeTest)) {
  throw new Error('could not locate the package-version release guard')
}
runtimeTest = runtimeTest.replace(/assert\.equal\(pkg\.version, '\d+\.\d+\.\d+'\)/,
  `assert.equal(pkg.version, '${version}')`)
write(runtimeTestFile, runtimeTest)

const setupFile = 'examples/verified-calculation/setup.mjs'
let setup = read(setupFile)
setup = setup.replace(/v\d+\.\d+\.\d+/g, `v${version}`)
const pinned = [
  'examples/verified-calculation/read-input.mjs',
  'examples/verified-calculation/write-output.mjs',
  'examples/verified-calculation/verify-output.mjs',
  'examples/verified-calculation/worker-tools.json',
  'examples/verified-calculation/data/input.json',
  'agent/rulith-agent.mjs',
  'worker/rulith-worker.mjs',
]
for (const file of pinned) {
  const pattern = new RegExp(`('${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*\\{\\s*sha256:\\s*')[0-9a-f]{64}('\\s*\\})`)
  if (!pattern.test(setup)) throw new Error(`could not locate embedded pin for ${file}`)
  setup = setup.replace(pattern, `$1${hash(file)}$2`)
}
write(setupFile, setup)

console.log(`prepared Runtime ${version}; add its changelog entry, run npm run manifest, then npm run release:verify`)
