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
npm run check
npm test
npm run manifest
git diff --exit-code artifact-manifest.json
```

Changes to the Cloud wire contract should include a compatibility note and a focused
test that fails against the previous behavior.
