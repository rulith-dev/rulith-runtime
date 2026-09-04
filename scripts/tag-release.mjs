// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const tag = `v${pkg.version}`
const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
if (status.trim() !== '') throw new Error('refusing to tag a dirty worktree; commit the verified release first')
try {
  execFileSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], { cwd: root, stdio: 'ignore' })
  throw new Error(`${tag} already exists`)
} catch (error) {
  if (error instanceof Error && error.message === `${tag} already exists`) throw error
}
execFileSync('git', ['tag', '-a', tag, '-m', `rulith ${pkg.version}`], { cwd: root, stdio: 'inherit' })
console.log(`created annotated tag ${tag}`)
