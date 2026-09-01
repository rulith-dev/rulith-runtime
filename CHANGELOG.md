# Changelog

All notable changes to the local runtime are documented here.

## Unreleased

## 0.4.2 - 2026-09-01

- Marked the Local UI document `no-store` so a restarted runtime cannot reuse stale HTML.
- Automatically reloads an old Local tab when its per-run key is rejected by the new process.

## 0.4.1 - 2026-09-01

- Replaced the below-fold Local settings disclosure with a centered, accessible settings modal.
- Added role-aware settings panes and one-click save-and-restart for Agent and Worker.

## 0.4.0 - 2026-09-01

- Hard-cut the existing `rulith` npm package from the retired MCP executable to Rulith Local.
- Added the global `rulith start --role agent|worker|agent+worker` command.
- Moved the default private configuration to `~/.rulith/local.json`; `rulith --help` is side-effect free.
- Restricted the npm publication to canonical runtime and example files, excluding generated local workspaces.

## 0.1.0-beta.2 - 2026-09-01

- Replaced Station as a separate product surface with one role-aware Rulith Local host and Agent workbench.
- Added Agent, Worker, and Agent+Worker startup modes while preserving separate child-process credentials.
- Unified Agent and Worker display events over structured child-process IPC.
- Enabled bounded file list/count/search/read/hash Tools by default; write Tools still require an explicit `read-write` host ceiling.
- Returned structured, attestable rows from every workspace read Tool and published file writes atomically.
- Compiled database templates to driver parameters instead of interpolated SQL values.
- Added bounded MCP Tool discovery while keeping every remote call behind a separately approved local Tool and governed Action.
- Kept restricted HTTP GET and fenced HTTP write results on the same governed result membrane.
- Generated every manifest digest from repository-canonical LF bytes and pinned LF in Git, fixing the broken manifest carried by the previous beta tag.

## 0.1.0-beta.1 - 2026-08-25

- Published the domain-neutral Agent Runtime, Worker, and local control host as an independent
  Apache-2.0 repository.
- Added the verified file calculation workflow: local JSON read, exact board
  derivation, local JSON write, independent read-back, and board acceptance.
- Kept model credentials in the Agent process and source credentials in the Worker.
- Added an English local control room for starting, configuring, and observing both
  processes.
- Added manifest drift checks, CI, structured bug reports, and workflow feedback.

The public repository begins at this version. Earlier private deployment history is
not part of the public compatibility contract.
