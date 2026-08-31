# Changelog

All notable changes to the local runtime are documented here.

## Unreleased

- Enabled bounded file list/count/search/read/hash Tools by default; write Tools still require an explicit `read-write` host ceiling.
- Returned structured, attestable rows from every workspace read Tool and published file writes atomically.
- Compiled database templates to driver parameters instead of interpolated SQL values.
- Added bounded MCP Tool discovery while keeping every remote call behind a separately approved local Tool and governed Action.
- Kept restricted HTTP GET and fenced HTTP write results on the same governed result membrane.

## 0.1.0-beta.1 - 2026-08-25

- Published the domain-neutral Agent Runtime, Worker, and Station as an independent
  Apache-2.0 repository.
- Added the verified file calculation workflow: local JSON read, exact board
  derivation, local JSON write, independent read-back, and board acceptance.
- Kept model credentials in the Agent process and source credentials in the Worker.
- Added an English local control room for starting, configuring, and observing both
  processes.
- Added manifest drift checks, CI, structured bug reports, and workflow feedback.

The public repository begins at this version. Earlier private deployment history is
not part of the public compatibility contract.
