# Releasing

1. Prepare the version:

   ```bash
   npm run release:prepare -- <version>
   ```

   This updates the versions in `package.json` and `package-lock.json`, the package-version
   guard in `test/runtime.test.mjs`, the verified-calculation example's version references
   and pins, and the generated MCP surface and Worker protocol projection. It runs both
   generators, so a separate `node scripts/generate-worker-protocol.mjs` is not needed.
   Add the version's entry to `CHANGELOG.md`, then run
   `node scripts/update-artifact-manifest.mjs`; the prepare script does not refresh the
   artifact manifest.

2. Commit the prepared release. Run `npm pack` from the repository root. Its `prepack`
   hook runs `npm run release:verify`, including the manifest check, `npm run check`, and
   the full test suite. Keep the resulting `rulith-<version>.tgz` for publishing.

3. Create and push the annotated release tag:

   ```bash
   npm run release:tag
   git push
   git push origin v<version>
   ```

   The tag script creates `v<version>` from the committed package version and refuses a
   dirty worktree. It does not push the commit or tag.

4. The owner publishes the verified tarball with two-factor authentication:

   ```bash
   npm publish rulith-<version>.tgz --tag next
   ```

5. Wait for the registry and verify the published artifact:

   ```bash
   npm run release:await-published -- <version>
   ```

   This checks every 15 seconds for up to 900 seconds by default until the exact version
   and `next` dist-tag are visible, then runs `scripts/verify-published.mjs` for that
   version. Override the wait with `--timeout-seconds <seconds>` or select another tag
   with `--tag <tag>`.
