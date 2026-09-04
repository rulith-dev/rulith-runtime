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

Changes to the Cloud wire contract should include a compatibility note and a focused
test that fails against the previous behavior.
