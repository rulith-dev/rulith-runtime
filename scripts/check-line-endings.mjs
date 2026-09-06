// SPDX-License-Identifier: Apache-2.0
/**
 * Refuse to pack a tarball whose files do not match their repository-canonical bytes.
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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

function relativeFile(root, path) {
  return relative(root, path).split(sep).join('/')
}

function expandDeclared(root, entry) {
  const path = resolve(root, entry)
  const stat = statSync(path)
  if (stat.isFile()) return [relativeFile(root, path)]
  if (!stat.isDirectory()) return []
  return readdirSync(path, { withFileTypes: true }).flatMap((child) =>
    expandDeclared(root, resolve(path, child.name)))
}

/** The published allow-list: everything npm ships plus everything the manifest hashes. */
export function publishedFiles(root = ROOT) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'artifact-manifest.json'), 'utf8'))
  const manifested = Object.keys(manifest.files ?? {})
  if (manifested.length === 0) throw new Error('artifact-manifest.json lists no files; the check would pass vacuously')
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const declared = Array.isArray(pkg.files) ? pkg.files.flatMap((entry) => expandDeclared(root, entry)) : []
  // npm includes package.json, README and LICENSE independently of `files`. Everything
  // else is expanded from the exact allow-list the package declares.
  const automatic = readdirSync(root).filter((name) => /^(?:readme|licen[cs]e)/iu.test(name))
  return [...new Set(['package.json', ...automatic, ...declared, ...manifested])]
}

/** Published canonical files that contain a CR byte in the working tree. */
export function carriageReturnOffenders(root = ROOT) {
  return publishedFiles(root).filter((file) => readFileSync(resolve(root, file)).includes(0x0d))
}

/**
 * Bytes that make a published text file stop behaving like text.
 *
 * A single NUL is enough: `grep` and `ripgrep` classify the file as binary and answer
 * `binary file matches` instead of the matching lines. That is not cosmetic. This package
 * is audited by searching it — for retired names, for credentials, for a route that was
 * supposed to be deleted — and a file containing one NUL answers every such search with
 * silence that reads exactly like a clean result. The one file in this repository that had
 * one was `agent/rulith-agent.mjs`, from a `\0` written literally into a Map-key template
 * instead of as an escape; a reviewer grepping it for `agent_protocol` would have been told
 * nothing was there.
 *
 * The rule is therefore the C0 controls minus the three that legitimately occur in source
 * (tab, LF, CR — CR has its own check above), plus DEL. Anything in that set is refused
 * with its offset, because the fix is always the same: write it as an escape sequence, or
 * do not put it in a text file.
 */
const CONTROL_BYTE_NAMES = { 0x00: 'NUL', 0x07: 'BEL', 0x08: 'BS', 0x0b: 'VT', 0x0c: 'FF', 0x1a: 'SUB', 0x1b: 'ESC', 0x7f: 'DEL' }
// Tab, LF and CR are the three that legitimately occur in source; CR has its own check
// above. VT and FF are neither: they are named in the table below precisely because they
// were meant to be refused, and letting them through made this a rule that described
// itself rather than one that ran.
const forbiddenByte = (byte) => ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f)

export function controlByteOffenders(root = ROOT) {
  const offenders = []
  for (const file of publishedFiles(root)) {
    const bytes = readFileSync(resolve(root, file))
    for (let index = 0; index < bytes.length; index++) {
      if (!forbiddenByte(bytes[index])) continue
      const byte = bytes[index]
      offenders.push({ file, offset: index, byte, name: CONTROL_BYTE_NAMES[byte] ?? `0x${byte.toString(16).padStart(2, '0')}` })
      break // one report per file is enough to fail and to locate
    }
  }
  return offenders
}

export const teaching = (offenders) => `Refusing to pack: ${offenders.length} published file(s) contain CR bytes.

${offenders.map((file) => `  · ${file}`).join('\n')}

artifact-manifest.json hashes the LF text of each file, but npm pack ships the bytes in
this working tree. Publishing from this checkout produces a tarball that does not match
its own manifest, so anyone verifying a release hash sees a mismatch.

Fix the checkout rather than the bytes:

  git config core.autocrlf false
  git rm --cached -r .
  git reset --hard

.gitattributes pins these files to LF, so a fresh clone is already correct.`

export const controlByteTeaching = (offenders) => `Refusing to pack: ${offenders.length} published file(s) contain control bytes.

${offenders.map((entry) => `  · ${entry.file}: ${entry.name} at byte offset ${entry.offset}`).join('\n')}

A published source file must stay searchable. grep and ripgrep treat a file containing NUL
as binary and print "binary file matches" instead of the matching lines, so every audit that
works by searching this package — for a retired route, for a credential, for a name that was
supposed to be deleted — gets silence from that file and reads it as a clean result.

Write the byte as an escape sequence in the source (\\u0000), or choose a separator that is
printable. Then re-run: npm run manifest`

// An explicit root keeps the rule testable against a purpose-built tree. A check whose
// only subject is the checkout it happens to be running in cannot be shown to go red on
// demand, and one that has never gone red is a claim rather than a guard.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('check-line-endings.mjs')) {
  const root = process.argv[2] ?? ROOT
  const offenders = carriageReturnOffenders(root)
  if (offenders.length > 0) {
    console.error(teaching(offenders))
    process.exit(1)
  }
  const controls = controlByteOffenders(root)
  if (controls.length > 0) {
    console.error(controlByteTeaching(controls))
    process.exit(1)
  }
  console.log('source bytes: all published canonical files are LF and free of control bytes')
}
