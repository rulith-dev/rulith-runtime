#!/usr/bin/env node
/**
 * Derive a verified-calculation Rulith Local config from an existing config.
 * Secrets are copied locally but never printed. The source config is not modified.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const runtime = resolve(process.env.RULITH_CALC_RUNTIME ?? join(HERE, 'runtime'))
const sourcePath = process.argv[2]
if (!sourcePath || !existsSync(sourcePath)) {
  console.error('usage: node prepare-local.mjs <existing-working-rulith-local.json>')
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
  console.error(`cannot read source Rulith Local config: ${error?.message ?? error}`)
  process.exit(2)
}
const gateway = resolve(HERE, '..', '..')
const config = {
  ...source,
  roles: ['agent', 'worker'],
  agent: {
    ...(source.agent ?? {}),
    args: [],
    env: {
      ...(source.agent?.env ?? {}),
      RULITH_SERVE_CONCURRENCY: '1',
      RULITH_SERVE_PORT: process.env.RULITH_CALC_SERVE_PORT ?? '7800',
    },
  },
  worker: {
    ...(source.worker ?? {}),
    env: {
      ...(source.worker?.env ?? {}),
      RULITH_WORKER_ROOT: runtime,
      RULITH_TOOLS_FILE: join(runtime, 'worker-tools.json'),
    },
  },
  paths: {
    agent: resolve(gateway, 'agent', 'rulith-agent.mjs'),
    worker: resolve(gateway, 'worker', 'rulith-worker.mjs'),
  },
}
delete config.agent.env.RULITH_AGENT
const output = join(runtime, 'rulith-local.json')
writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
console.log(`Rulith Local config prepared at ${output} (credential values intentionally not printed)`)
