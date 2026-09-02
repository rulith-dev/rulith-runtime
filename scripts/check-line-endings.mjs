// SPDX-License-Identifier: Apache-2.0
/**
 * Refuse to pack a tarball whose files cannot match their own manifest.
 *
 * `artifact-manifest.json` records the sha256 of each file's repository-canonical
 * (LF) text. `npm pack` ships the working-tree bytes. On a Windows checkout made with
 * `core.autocrlf=true` those two are not the same file: every published byte carries
 * CR, so the tarball disagrees with the manifest it ships beside — verified against the
 * registry copy of 0.4.0, which is CRLF throughout. Nothing failed at pack time and
 * nothing failed at install time; the only symptom was that a reader who checked the
 * hashes got a mismatch on a genuine release, which is the same signal as tampering.
 *
 * This refuses instead of normalizing on the fly. Rewriting bytes at pack time would
 * publish a tarball that never existed in any checkout, so `git show` of the tag and
 * the shipped file would still differ — the discrepancy would move rather than close,
 * and it would be invisible again.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Files listed in the manifest that contain a CR byte in the working tree. */
export function carriageReturnOffenders(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'artifact-manifest.json'), 'utf8'))
  const files = Object.keys(manifest.files ?? {})
  if (files.length === 0) throw new Error('artifact-manifest.json lists no files; the check would pass vacuously')
  return files.filter((file) => readFileSync(resolve(root, file)).includes(0x0d))
}

export const teaching = (offenders) => `Refusing to pack: ${offenders.length} manifest-listed file(s) contain CR bytes.

${offenders.map((file) => `  · ${file}`).join('\n')}

artifact-manifest.json hashes the LF text of each file, but npm pack ships the bytes in
this working tree. Publishing from this checkout produces a tarball that does not match
its own manifest, so anyone verifying a release hash sees a mismatch.

Fix the checkout rather than the bytes:

  git config core.autocrlf false
  git rm --cached -r .
  git reset --hard

.gitattributes pins these files to LF, so a fresh clone is already correct.`

// An explicit root keeps the rule testable against a purpose-built tree. A check whose
// only subject is the checkout it happens to be running in cannot be shown to go red on
// demand, and one that has never gone red is a claim rather than a guard.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-line-endings.mjs')) {
  const offenders = carriageReturnOffenders(process.argv[2] ?? ROOT)
  if (offenders.length > 0) {
    console.error(teaching(offenders))
    process.exit(1)
  }
  console.log('line endings: all manifest-listed files are LF')
}
