# Contributing

The local runtime is intentionally small and protocol-focused. Contributions should
preserve these boundaries:

- Business vocabulary and workflow policy belong in capability packages and examples,
  not in Agent Runtime, Worker, or the Rulith Local host.
- Worker implementations must remain capability-scoped and fail closed when a tool,
  source, credential, or argument contract is missing.
- A work receipt is evidence of execution, not authority to verify or close a case.
- Local credentials must never be serialized into board commands, recipes, packages,
  logs, fixtures, or issue reports.
- Runtime-facing text and documentation are English.

Before opening a pull request, run:

```bash
npm run verify:manifest  # should fail if downloadable source changed without reviewed anchors
npm run manifest         # explicit trust-anchor update; review this diff
npm run check
npm test
```

`npm run manifest` is an explicit source update whose diff must be reviewed and
committed. Packaging never runs it automatically. To cut a release, run
`npm run release:prepare -- <version>`, add the changelog entry, run
`npm run manifest` and `npm run release:verify`, commit, then run
`npm run release:tag`. Push the commit and annotated tag explicitly before publishing.
After npm confirms publication, run `npm run release:verify-published -- <version>`.
That gate fetches the registry tarball, compares its integrity and manifest-listed file hashes,
installs it into a disposable directory, and starts the installed workbench on loopback.
It verifies the public artifact rather than assuming the tagged source was published.
For document-assistant releases, follow the published-account browser run in
`docs/document-authoring-acceptance.md` and keep its evidence separate from the
simulated-Gateway Chromium tests.

Changes to the Cloud wire contract should include a compatibility note and a focused
test that fails against the previous behavior.

## Releases that change the client protocol

When a release cannot talk to the Gateway that production runs (for example 0.9.1, the first
published `rulith/v2` Host), `latest` must keep pointing at the release production accepts
until the Gateway itself is cut over.

The Gateway checks the client protocol (the MCP date and the `rulith/v2` capabilities), not the
exact release. It pins the one Runtime release it recommends in
`rulith-java/protocol/src/main/resources/contracts/mcp-client-release.json`, and its repository
checks confirm that release's commit is on this repository's `main`; its Console shows
`npm install --global rulith@<pinned version>`, and its refusals carry the same command. So every
Runtime release recommended for production, a compatible patch included, means re-pinning and
redeploying the Gateway. Until then the Console keeps recommending the pinned release, and a
person who follows Setup installs it, even over a newer compatible one.

1. Prepare, tag and verify the release as above, land the release commit on `main`, and push
   the commit and its `v<version>` tag (the example setup downloads from that tag). From the
   Gateway repository, run its pairing gate against this checkout and the verified previous
   package: `node scripts/verify-mcp-cutover.mjs <this checkout> <previous package>`. It checks
   that the Gateway's pin names this exact package version.
2. Publish without moving `latest`: `npm publish --tag next`. Then run
   `npm run release:verify-published -- <version>`, which resolves the exact version rather
   than a dist-tag.
3. Before the cutover, confirm the public registry serves the exact version the Gateway pins:
   `npm view rulith@<version> dist.integrity` must print its integrity. A version published
   moments earlier can still answer 404 for a while, and the new Console would then show a
   command that fails.
4. Move `latest` in the same maintenance step as the Gateway cutover, after the new Gateway is
   serving: `npm dist-tag add rulith@<version> latest`. Before that step, `latest` still matches
   the Gateway in production; after it, both match the new pair.
5. Rollback. If the Gateway is rolled back, point `latest` back to the previous release in the
   same step: `npm dist-tag add rulith@<previous version> latest`. Leave the new version
   published; npm versions are immutable, and nothing the rolled-back service shows names it.
   The Gateway authenticates before it checks the client release, and a cutover that started
   from a fresh identity store leaves the rolled-back Gateway on its earlier one:
   - Agents and Workers paired after the cutover hold credentials the old store never issued.
     They are rejected with 401 first (exit 3). The old Gateway's refusals carry no pairing or
     release advice: the Agent says to rotate the Agent token, and the Worker says to copy a
     fresh Connection id and key and quotes the old Gateway's one-line reason. Both must pair
     again from the old Console as well as reinstall `latest`.
   - Clients still holding pre-cutover credentials but running the new release are refused at
     `initialize` as a version mismatch. The old Gateway names no release, so the Runtime
     points to the Console, whose unpinned command installs `latest` again.
