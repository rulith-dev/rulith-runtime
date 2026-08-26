#!/usr/bin/env node
/** Prepare the local adapter layout referenced by the governed Tool and Source packages. */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(process.env.RULITH_CALC_RUNTIME ?? join(HERE, 'runtime'))
mkdirSync(runtime, { recursive: true })

const adapters = join(HERE, 'adapters', 'verified-calculation')
mkdirSync(adapters, { recursive: true })
for (const file of ['read-input.mjs', 'write-output.mjs', 'verify-output.mjs']) {
  copyFileSync(join(HERE, file), join(adapters, file))
}
copyFileSync(join(HERE, 'data', 'input.json'), join(runtime, 'input.json'))
copyFileSync(join(HERE, 'worker-tools.json'), join(runtime, 'worker-tools.json'))
console.log(JSON.stringify({
  runtime,
  adapters,
  input: join(runtime, 'input.json'),
  output: join(runtime, 'output.json'),
  workerTools: join(runtime, 'worker-tools.json'),
}, null, 2))
