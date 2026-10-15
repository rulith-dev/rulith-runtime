# General Worker toolkit

Worker adapters for programming work on one project directory, bound in Rulith as Source `lab`
(type `file`). Plain Node 20+, no dependencies. They give the model ordinary engineering moves —
read, search, list, glob, write, patch, view an image, run a command, run a long job, run the
owner-pinned test or measurement, fetch a web page and search the web. Every call returns a
Worker receipt. This toolkit ships with the Runtime and is off by default. Deep Rulith remains
the agent host; capability packages adopt these bare tool contracts through their own business
Actions, adding preconditions and effects. The kit itself adds no business Actions.

`tool-descriptions.json` provides short model-facing text for packages adopting the contracts.
Use it in the package's Action descriptions. It is separate from `worker-tools.json` because the
fixed Worker manifest/protocol has no description field; it is not silently dropped on that hop.

This is a side-effect fence, not a sandbox: commands run as the Worker's operating-system user.

## Install on a Worker

1. Create a kit home directory outside the project with `specs/test.json` (the pinned test; see
   `pinned-test.example.json`), optional `specs/<id>.json` measurements
   (`pinned-measure.example.json`) and optional `settings.json` (below).
2. With the Agent paired and its Worker enabled once in the Rulith Runtime manager, run
   `rulith kit install general --agent <name> --kit-home <dir> [--manager-home <dir>]`.
   The manager directory defaults to `RULITH_MANAGER_HOME` or `~/.rulith/manager`.
   For scripts, `node kits/general/install.mjs` accepts the same flags.
   It copies the adapters into that Agent's Worker root, merges the eighteen kit tools into the
   Agent's own tool manifest and sets the Worker environment: `ENG_KIT_HOME`,
   `RULITH_WORKSPACE_TOOLS=read` (Console uses the built-in read tools to bind the Source) and
   `RULITH_WORKER_RUN_TIMEOUT_SECONDS` (the longer of `runDeadlineSeconds` and
   `pollMaxWaitSeconds` and `webTimeoutSeconds`, plus 60). The adapter directory remains
   `adapters/engineering-work/` so the original engineering tool entries stay compatible.
   Turn the Agent's Worker off and on afterwards. Installation is local; it does not pair,
   start a Worker, bind a Source, or contact a service.
3. Run it again after changing `settings.json` limits or `webSearch.keyEnv`. Export the search
   key in the environment that launches the Worker; the installer stores only the variable's name,
   adding it to `web.search@1`'s `env.pass`. Commands and other tools do not receive that key.
4. Accreditation: the Board records a Worker result only for predicates its Source accredits.
   Build the Capability with `node pack/build-pack.mjs` and install it on the Agent; it declares
   Source `lab` with the `eng.*` and `web.*` words and adds no rules or Actions.
5. Console: bind Source `lab` to the project root and the Worker Connection, pin the desired
   kit tools (allow direct use) and lock. Non-strict exploration mode lets the model supply
   write and run inputs; each such call is marked as not grounded.

## Settings (`<kit home>/settings.json`)

See `settings.example.json`. All fields are optional.

| Field | Default | Meaning |
| --- | --- | --- |
| `runDeadlineSeconds` | 35 | Longest ordinary command; its process tree is killed after this. |
| `jobLimitSeconds` | 0 | Longest background job; 0 means no limit. |
| `pollMaxWaitSeconds` | 35 | Longest wait of one `eng.job_poll`. |
| `allowedPaths` | `[]` | Absolute directories outside the project that commands may name (toolchains, model files). Reads and writes stay inside the project. |
| `allow` | `[]` | Relaxed rules: `install` (project-local dependency installs), `delete` (deletion inside the project), `git_rewrite` (`git reset`, `git clean`), `git_commit` (commits, merges, rebases, tags). |
| `shell` | `false` | Run commands through the system shell (pipes, redirects, `.cmd` scripts). |
| `treeExclude` | `[]` | Project-relative directories left out of the tree digest (build outputs, caches). `.git` is always excluded. |
| `imageMaxBytes` | 5242880 | Maximum image bytes (up to 20 MiB); the Worker's object budget also applies. |
| `webMaxBytes` | 1048576 | Maximum response bytes for fetch/search (up to 8 MiB). |
| `webTimeoutSeconds` | 20 | Total fetch/search deadline, including redirects and DNS (up to 120 seconds). |
| `webSearch` | absent | `{ "provider": "deepseek", "keyEnv": "DEEPSEEK_API_KEY" }`; no literal keys or credential files. |

Always refused: privilege elevation, killing processes or stopping services, push/publish, global
installs or configuration (git subcommands are checked anywhere in a shell line), inline interpreter code (`node -e`, `python -c`, …) and paths that
escape the project or the allowed directories. With `shell: true` these checks see only the
command line as written: a shell or script can still run anything the Worker's user can, so enable
it only for a project you trust.

## Behaviour

The original twelve `eng.*@1` contracts, parameter tables, predicate mappings and receipt fields
are preserved. New contracts:

| Tool | Inputs | Result |
| --- | --- | --- |
| `eng.glob@1` | `pattern`, optional `limit` (1–128; default 64) | Sorted project files, at most 1.8 KiB of rows; `truncated` if capped. Supports `*`, `**`, `?`, character classes. Skips `.git` at every depth, tree exclusions, and links; refuses walks over 20,000 entries. |
| `eng.apply_patch@1` | `patch` | Up to four files, 16 KiB patch, 1 MiB per existing text file. Codex `*** Begin Patch` / `*** Add File` / `*** Update File` / `*** Delete File` / `*** End Patch`. Exact `@@` context hunks, optional section anchor and `*** End of File`. Every hunk/path is validated before writes; I/O errors restore prior files. Existing parent directories are required. Deletes require `allow: ["delete"]`. |
| `eng.read_image@1` | `path` | PNG/JPEG/GIF/WebP, identified by magic bytes. No facts or inline image bytes; the Worker takes custody, verifies the digest and registers an artifact reference through its existing reporting path. |
| `eng.read@2` | `path`, optional byte `offset` | Same bounded read result as `eng.read@1`, plus `eng.file_read{path,digest,bytes}`. This digest describes the full file; the inline text may be a window. `eng.read@1` still returns no facts. |
| `web.fetch@1` | `url` | GET of HTTP(S) without credentials/cookies; HTML becomes readable text. `web.page{url,final_url,status,digest,fetched_at}`; the digest covers the complete fetched response bytes. |
| `web.search@1` | `query` | Bounded provider result text and `web.search{query,provider,digest,fetched_at}`. The digest covers the complete scrubbed result text. Missing key refuses with `web search key unavailable`. |

Patch receipts have one `eng.file_state` row per file (the same arguments as `eng.write_file`)
and `eng.tree_step`. Deletion uses the SHA-256 of empty bytes and zero bytes as its absent
readback. A receipt replays the first genuine edge that invalidates the last passing test when
needed. Patches too large to report every file state within the inline budget refuse before writes.
Files with CRLF keep their line endings on update. Ambiguous hunks, repeated paths, moves, binary
patches, absolute paths, traversal and links are refused.

Web fetch checks every resolved DNS address and every redirect (at most five), then pins a checked
address to the actual connection. Loopback, unspecified, private, link-local, multicast, shared
carrier NAT and IPv6 transition destinations are refused. Responses use identity encoding; compressed
responses and binary media are refused. Search uses the DeepSeek Anthropic-compatible Messages API
and its native `web_search_20250305` tool, with a small provider interface for later providers.
Redirects from that API are refused. Keys and upstream error bodies are never logged or reported.
Tests use local HTTP stubs with a directly injected guard/provider; no setting, environment flag or
tool argument can bypass the production SSRF guard. Web calls remain read tools bound to the `file`
Source `lab`, which accredits the new receipt words as well as the engineering words.

- `eng.run` takes a command line and a project-relative `cwd`.
- `eng.read` returns as much text as fits the Worker's inline receipt (8 KiB on rulith.ai; the text is
  counted as it is encoded there): about 5 KB of plain code per call. `eng.read(path)` gives the start
  of the file in `head` and, when the rest does not fit, its last KiB in `tail`; `eng.read(path, offset)`
  gives the window from `offset` in `head`. Both say `next_offset` (where the unread part starts, or
  null), `complete` and `start_line`; paging by `next_offset` from 0 returns the file exactly.
- `eng.write_file` with `expect_digest` `""` creates a file that must not exist yet; to replace a file,
  pass the digest `eng.read` reported for it.
- Refusals say what is wrong in fixed words: `spec refused: <the field at fault>`, `parent directory missing`,
  `path not found`, `path is a directory`, `path not readable` (never a path or a value). The verdict is also
  written to stderr, which the Worker reports as the failure reason.
- While a job runs, writes, runs and measurements are refused but reads go ahead (recording no generation
  step). `eng.list` gives the folder's `entries` count (a receipt holds at most 32 rows); `eng.search` skips
  files it cannot read and counts them in `unreadable_files`.
- A read (`list`, `read`, `search`, `tree_state`) walks the tree once, before it runs. `treeExclude`
  entries are paths from the project root, or `**/<name>` for a folder of that name at any depth (for
  example `**/node_modules`). `eng.search` over a path inside a skipped folder walks that folder on demand.
- `eng.list` and `eng.search` keep at most 1.8 KB of rows (a receipt carries every row twice within the
  Worker's inline budget) and add `truncated: true` when they stop short.
- `eng.tree_state` also lists the pinned measurement specs as `measure_specs`.
- `eng.write_file` and `eng.patch_file` require the expected SHA-256 of the current file (the
  digest of empty bytes for a new file) and read the bytes back after writing.
- Long work goes through `eng.job_start`, `eng.job_poll`, `eng.job_stop`. Jobs run in a detached
  supervisor and survive the adapter; while a job is live, only poll and stop are accepted.
- The tree digest covers the project except exclusions; it is cached by size and modification
  time. The generation advances once per receipt whose tree differs from the last one.
- Only `eng.test` produces `eng.test_result` and only `eng.measure_pinned` produces measurement
  facts; numbers printed by other commands never become facts.
- All adapters for one Source serialize through a lock in the kit home.

## Pinned measurements

`<kit home>/specs/<spec_id>.json` pins one measurement; `eng.measure_pinned(spec_id)` runs it `repeats`
times and records `eng.measurement` facts in integer milli-units. The measuring program is `binary`
(inside the project, digest-pinned); `candidate_binary`, `workload` and `config` are recorded or
rechecked on every repeat. Two ways to read the number:

- `json_integer_milli`: the program prints one JSON object (at most 1 KiB) with an integer `field`.
- `json_file_number_milli`: the program writes a JSON `file` inside the project; `path` (keys and
  array indexes, negative from the end) names one number, scaled by 1000. The file must be rewritten
  by the run.

An interpreted harness (for example a Python script) names its `interpreter` (a command name or
absolute path); the command is then `[interpreter, binary, ...]`. See `pinned-measure.example.json`
and `pinned-measure-interpreted.example.json`.

The agent may pin a measurement itself instead of waiting for the owner: it writes the spec to
`<project>/.deep-rulith/measure/<name>.json` and runs `eng.measure_pinned` with `spec_id`
`self-<name>`. The first run that passes every check copies the spec to `<kit home>/specs/self-<name>.json`,
where it never changes; later edits of the project copy are ignored. A refused spec is not frozen, so it
can be corrected under its name. The `self-` prefix stays on every receipt, so the
owner can review such specs afterwards and tell them from the owner's own.

## Completing a goal

Declare the goal with a `desired` outcome, then propose with `add_axiom` a rule that derives that outcome
from the pinned test that passed (`exit_code 0`) at the final generation and tree digest. Nobody closes
the goal: the Board completes it by itself once it certifies the outcome from that test receipt.
