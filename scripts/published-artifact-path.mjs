// SPDX-License-Identifier: Apache-2.0
import { resolve, sep } from 'node:path'

/** A manifest key from a downloaded package may only address a file in that package. */
export function publishedArtifactPath(packageRoot, file) {
  const root = resolve(packageRoot)
  const pieces = typeof file === 'string' ? file.split('/') : []
  if (pieces.length < 2 || pieces.some(piece => !/^[A-Za-z0-9._-]+$/.test(piece) || piece === '.' || piece === '..'))
    throw new Error(`unsafe artifact-manifest path: ${String(file)}`)
  const target = resolve(root, file)
  if (!target.startsWith(root + sep)) throw new Error(`unsafe artifact-manifest path: ${file}`)
  return target
}
