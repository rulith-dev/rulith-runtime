#!/usr/bin/env node
/** Render runtime files without copying credentials into the repository. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(process.env.RULITH_CALC_RUNTIME ?? join(HERE, 'runtime'))
mkdirSync(runtime, { recursive: true })

const tools = readFileSync(join(HERE, 'worker-tools.template.json'), 'utf8')
  .replaceAll('__READ_SCRIPT__', resolve(HERE, 'read-input.mjs').replaceAll('\\', '/'))
  .replaceAll('__WRITE_SCRIPT__', resolve(HERE, 'write-output.mjs').replaceAll('\\', '/'))
  .replaceAll('__VERIFY_SCRIPT__', resolve(HERE, 'verify-output.mjs').replaceAll('\\', '/'))

JSON.parse(tools)
writeFileSync(join(runtime, 'rulith-tools.json'), tools)
writeFileSync(join(runtime, 'input.json'), readFileSync(join(HERE, 'data', 'input.json')))
console.log(JSON.stringify({
  runtime,
  tools: join(runtime, 'rulith-tools.json'),
  input: join(runtime, 'input.json'),
  output: join(runtime, 'output.json'),
}, null, 2))
