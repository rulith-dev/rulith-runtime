// SPDX-License-Identifier: Apache-2.0
/**
 * A file system fault a test cannot otherwise cause on demand.
 *
 * Windows will not remove a file another program has open, for as long as it stays open: a virus
 * scanner or an indexer does this to a file that was written a moment ago, and it ends by itself. A
 * test cannot hold a file that way from Node. `holdFiles` makes `rmSync` answer as Windows does
 * (`EBUSY`) for the paths it is asked about, while it is engaged, and runs the real `rmSync` for
 * everything else and for those paths once released — so what an arm sees is the code under test
 * meeting a refusal and then, later, the real file being removed.
 *
 * It replaces `rmSync` on the `node:fs` object and then re-syncs the ES module bindings, which is
 * what reaches a module that imported it by name. The test's own cleanup removes whole directories,
 * which is a different path and is never refused.
 */
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'

/**
 * @param {import('node:test').TestContext} t  Restores `rmSync` when the test ends.
 * @param {(path: string) => boolean} held  Which paths are held while engaged.
 * @returns {{ engage: () => void, release: () => void, refused: () => string[] }}
 */
export function holdFiles(t, held) {
  const original = fs.rmSync
  let engaged = true
  const refused = []
  const mocked = t.mock.method(fs, 'rmSync', function (path, ...rest) {
    if (engaged && held(String(path))) {
      refused.push(String(path))
      throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${path}'`), { code: 'EBUSY', syscall: 'unlink', path: String(path) })
    }
    return original.call(this, path, ...rest)
  })
  syncBuiltinESMExports()
  t.after(() => { engaged = false; mocked.mock.restore(); syncBuiltinESMExports() })
  return { engage: () => { engaged = true }, release: () => { engaged = false }, refused: () => [...refused] }
}
