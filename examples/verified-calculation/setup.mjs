#!/usr/bin/env node
/**
 * Download the public REPL + Worker reference files and prepare a local verified
 * JSON calculation workspace. Agent capabilities are installed in Console;
 * credentials are never requested or written here.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const ORIGIN = process.env.RULITH_DOWNLOAD_ORIGIN ?? 'https://console.rulith.com'
const target = resolve(process.argv[2] ?? 'rulith-verified-calculation')
const FILES = [
  'prepare-runtime.mjs',
  'read-input.mjs',
  'write-output.mjs',
  'verify-output.mjs',
  'recipe.template.json',
  'worker-tools.template.json',
  'data/input.json',
]

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`refusing to overwrite non-empty directory: ${target}`)
  process.exit(2)
}

const downloads = new Map()
for (const file of FILES) {
  const response = await fetch(`${ORIGIN}/examples/verified-calculation/${file}`)
  if (!response.ok) throw new Error(`download failed (${response.status}): ${file}`)
  downloads.set(file, Buffer.from(await response.arrayBuffer()))
}
for (const file of ['rulith-agent.mjs', 'rulith-worker.mjs']) {
  const response = await fetch(`${ORIGIN}/${file}`)
  if (!response.ok) throw new Error(`download failed (${response.status}): ${file}`)
  downloads.set(file, Buffer.from(await response.arrayBuffer()))
}

mkdirSync(target, { recursive: true })
for (const [file, contents] of downloads) {
  const path = resolve(target, file)
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, contents)
}

const prepared = spawnSync(process.execPath, ['prepare-runtime.mjs'], {
  cwd: target,
  encoding: 'utf8',
})
if (prepared.status !== 0) {
  process.stderr.write(prepared.stderr || prepared.stdout || 'runtime preparation failed\n')
  process.exit(prepared.status ?? 1)
}

console.log(`Prepared ${target}`)
console.log('Next: set your Agent token, model credentials, Connection key, and run the two commands from the Rulith 5-minute quickstart.')
