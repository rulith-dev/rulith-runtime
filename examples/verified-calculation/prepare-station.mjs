#!/usr/bin/env node
/**
 * Derive a calculation Station config from an existing working Station config.
 * Secrets are copied locally but never printed. The source config is not modified.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(process.env.RULITH_CALC_RUNTIME ?? join(HERE, 'runtime'))
const sourcePath = process.argv[2]
if (!sourcePath || !existsSync(sourcePath)) {
  console.error('usage: node prepare-station.mjs <existing-working-rulith-station.json>')
  process.exit(2)
}
for (const required of ['input.json']) {
  if (!existsSync(join(runtime, required))) {
    console.error(`missing ${join(runtime, required)} — run prepare-runtime.mjs first`)
    process.exit(2)
  }
}

let source
try { source = JSON.parse(readFileSync(resolve(sourcePath), 'utf8')) } catch (error) {
  console.error(`cannot read source Station config: ${error?.message ?? error}`)
  process.exit(2)
}
const gateway = resolve(HERE, '..', '..')
const config = {
  ...source,
  repl: {
    ...(source.repl ?? {}),
    args: ['--agent', 'verified-calculation', '--ui'],
    env: {
      ...(source.repl?.env ?? {}),
      RULITH_CASE_BOARDS: 'on',
      RULITH_SERVE_CONCURRENCY: '1',
      RULITH_UI_PORT: process.env.RULITH_CALC_UI_PORT ?? '7789',
      RULITH_SERVE_PORT: process.env.RULITH_CALC_SERVE_PORT ?? '7800',
    },
  },
  worker: {
    ...(source.worker ?? {}),
    env: {
      ...(source.worker?.env ?? {}),
      RULITH_WORKER_ROOT: HERE,
      RULITH_TOOLS_FILE: join(runtime, 'worker-tools.json'),
    },
  },
  paths: {
    repl: resolve(gateway, 'agent', 'rulith-agent.mjs'),
    worker: resolve(gateway, 'worker', 'rulith-worker.mjs'),
  },
}
const output = join(runtime, 'rulith-station.json')
writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
console.log(`Station config prepared at ${output} (credential values intentionally not printed)`)
