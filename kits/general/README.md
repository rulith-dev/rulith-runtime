# General Worker toolkit

Worker adapters for programming work on one project directory, bound in Rulith as Source `lab`
(type `file`). Plain Node 20+, no dependencies. They give the model ordinary engineering moves —
read, search, list, glob, write, patch, view an image, run a command, run a long job, run the
named project acceptance check or owner-pinned test/measurement, fetch a web page and search the web. Every call returns a
Worker receipt. This toolkit ships with the Runtime and is off by default. Deep Rulith remains
the agent host; capability packages adopt these bare tool contracts through their own business
Actions, adding preconditions and effects. The kit itself adds no business Actions.

This is a side-effect fence, not a sandbox: commands run as the Worker's operating-system user.

## Install on a Worker

1. Create a kit home directory outside the project. Only legacy `eng.test@1` needs
   `specs/test.json` (see `pinned-test.example.json`); v2 uses project files below.
   Optional `specs/<id>.json` measurements
   (`pinned-measure.example.json`) and optional `settings.json` (below).
2. With the Agent paired and its Worker enabled once in the Rulith Runtime manager, run
   `rulith kit install general --agent <name> --kit-home <dir> [--manager-home <dir>]`.
   The manager directory defaults to `RULITH_MANAGER_HOME` or `~/.rulith/manager`.
   For scripts, `node kits/general/install.mjs` accepts the same flags.
   It copies the adapters into that Agent's Worker root, merges the twenty kit tools into the
   Agent's own tool manifest and sets the Worker environment: `ENG_KIT_HOME`,
   `RULITH_WORKSPACE_TOOLS=read` (Console uses the built-in read tools to bind the Source) and
   `RULITH_WORKER_RUN_TIMEOUT_SECONDS` (the longer of `runDeadlineSeconds` and
   `pollMaxWaitSeconds` and `webTimeoutSeconds`, plus 60, capped at 604,800 seconds).
   The adapter directory remains
   `adapters/engineering-work/` so the original engineering tool entries stay compatible.
   Turn the Agent's Worker off and on afterwards. Installation is local; it does not pair,
   start a Worker, bind a Source, or contact a service.
3. Run it again after changing `settings.json` limits or `webSearch.keyEnv`. Export the search
   key in the environment that launches the Worker; the installer stores only the variable's name,
   adding it to `web.search@1`'s `env.pass`. The key sits in the Worker process environment.
   Any command the model runs through `eng.run`/`eng.job_start` as the same OS user can read it,
   even though it is not passed directly into those adapters. Use a dedicated low-privilege search key.
4. Accreditation: the Board records a Worker result only for predicates its Source accredits.
   From this directory run `node pack/build-pack.mjs`. Install `pack/program-v2.json`
   (`engineering_work` version 2, native `rulith-domain-program`) and `pack/sources-v2.json`
   (`engineering_work_sources` version 2). Source `lab` accredits the `eng.*` and `web.*` words.
   The program adds the check criterion rule and acceptance bridge, and no business Actions.
   The older `pack/program.json` and `pack/sources.json` stay byte-identical. Install v2 on a new
   Board: same-name packages cannot be installed together or hot-upgraded.
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
| `eng.glob@1` | `pattern`, optional `limit` (1–128; default 64) | Sorted project files, at most 1.8 KiB of rows; `truncated` if capped. Supports `*`, `**`, `?`, character classes. Skips `.git` at every depth, tree exclusions, and links; refuses walks over 20,000 entries. At most 20 wildcard tokens; walking and matching share a five-second deadline (`glob complexity refused`). This allows ordinary repositories on slower disks while bounding pathological requests. |
| `eng.apply_patch@1` | `patch` | Up to four files, 16 KiB patch, 1 MiB per existing text file. Codex `*** Begin Patch` / `*** Add File` / `*** Update File` / `*** Delete File` / `*** End Patch`. Exact `@@` context hunks, optional section anchor and `*** End of File`. Every hunk/path is validated before writes; I/O errors restore prior files. Existing parent directories are required. Deletes require `allow: ["delete"]`. |
| `eng.read_image@1` | `path` | PNG/JPEG/GIF/WebP, identified by magic bytes. No facts or inline image bytes; its manifest opts into `artifactOutput: true` and the `rulith.artifacts` envelope. The Worker takes custody, verifies the digest and registers an artifact reference through its existing reporting path. Other run adapters retain their ordinary stdout. |
| `eng.read@2` | `path`, optional byte `offset` | Same bounded read result as `eng.read@1`, plus `eng.file_read{path,digest,bytes}`. This digest describes the full file; the inline text may be a window. `eng.read@1` still returns no facts. |
| `web.fetch@1` | `url` | GET of HTTP(S) without credentials/cookies; HTML becomes readable text. `web.page{url,final_url,status,digest,fetched_at}`; the digest covers the complete fetched response bytes. |
| `web.search@1` | `query` | Bounded provider result text and `web.search{query,provider,digest,fetched_at}`. The digest covers the complete scrubbed result text. Missing key refuses with `web search key unavailable`. |

Patch receipts report `eng.file_state` for each file (the same arguments as `eng.write_file`)
and `eng.tree_step`. Deletion uses the SHA-256 of empty bytes and zero bytes as its absent
readback. A receipt replays the first genuine edge that invalidates the last passing test when
needed, alongside the current mutation edge. The budget allows two edges per file; patches too
large to report every file state refuse before writes. Each retained or replaced line keeps its
original EOL, including mixed LF/CRLF files. Blank hunk context accepts an empty line or a single
space. Ambiguous hunks, repeated paths, moves, binary
patches, absolute paths, traversal and links are refused.

Web fetch checks every resolved DNS address and every redirect (at most five), then pins a checked
address to the actual connection. Loopback, unspecified, private, link-local, multicast, shared
carrier NAT, benchmarking/fake-IP, protocol/documentation, reserved and IPv6 transition destinations
are refused. Responses use identity encoding; compressed
responses and binary media are refused. Search uses the DeepSeek Anthropic-compatible Messages API
and its native `web_search_20250305` tool, with a small provider interface for later providers.
Redirects from that API are refused. Keys and upstream error bodies are never logged or reported.
Tests use local HTTP stubs with a directly injected guard/provider; no setting, environment flag or
tool argument can bypass the production SSRF guard. Web calls remain read tools bound to the `file`
Source `lab`, which accredits the new receipt words as well as the engineering words. They skip
the project tree digest and Source lock, including during network waits. Fetch scans the complete
fetched body with a linear HTML scanner, stopping once extracted text exceeds 16 KiB.
The receipt then clips text to its inline byte budget; its digest covers every fetched byte.

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
  written to stderr, which the Worker reports as the failure reason. Acceptance file-change refusals
  additionally name the validated project-relative file, as described below.
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
  Stop confirmation waits up to five seconds, bounded by `runDeadlineSeconds`, independently
  of the polling wait limit.
- The tree digest covers the project except exclusions; it is cached by size and modification
  time. The generation advances once per receipt whose tree differs from the last one.
- Only `eng.test` produces `eng.test_result` and only `eng.measure_pinned` produces measurement
  facts; numbers printed by other commands never become facts.
- The Worker runs items one at a time per Source. File and command adapters serialize through
  an exclusive lock in the kit home, compatible with the original engineering kit's lock.
  Contenders retry with jitter for up to two seconds before reporting `adapter busy`.
  The lock records its holder pid and acquisition time; a dead pid is recovered immediately.
  Locks and election claims expire after the installed Worker's maximum adapter run time
  plus another 60 seconds, even if the pid was reused or cannot be probed. Start times more
  than that lease in the future also expire after a clock correction. Restart the Worker
  after reinstalling changed limits.
  Recovery contenders serialize; fresh live holders remain exclusive. Stale temporary files
  left by interrupted kit saves are cleaned up on the next acquisition.

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

Certification means an acceptance contract was fulfilled: a root goal, criterion leaves and a signer.
After discovering check receipts, declare child goals with `desired` atoms
`eng.check_passed(check, spec_digest)` under the root using `declare_goal`. The person signs the
leaves in Console (`SignAcceptance`); the Kernel plants `acceptance(node, test)` with `test` equal
to the value of the atom's first declared argument, `check`. The package bridge connects that check
name to `acceptance_met(node)`. The leaf's own `goal_met` also requires the exact desired atom,
so its signed digest must hold. A bridge match for a different digest cannot fulfill that leaf.
The Board's contract machinery completes the root when all signed leaves fulfill.

`eng.check_passed`, `eng.test_result`, `eng.tree_step` and `eng.check_spec` are package pins
(committed derivation). Model assertions and model rule heads using them are refused with
`goalpost_moved`; Worker receipts and package rules provide the evidence. The model does not
write a completion rule. Console signing and certification require the D-1016a Kernel/Gateway work.

## Project acceptance specs

Write `.rulith/acceptance/<check>.json` in the project, with a check matching
`^[a-z0-9][a-z0-9_-]{0,39}$`. For example (replace the digest with the actual test file SHA-256):

```json
{
  "command": ["node", "test/acceptance.mjs"],
  "cwd": ".",
  "files": { "test/acceptance.mjs": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  "output_dirs": ["test-output"],
  "shell": false
}
```

Specs are UTF-8 JSON objects, at most 16 KiB. `command` is a nonempty array of nonempty strings;
`cwd` is required and is `.` or a project-relative directory. `files` is an object mapping
test dependency paths to lowercase, 64-character SHA-256 hex strings. Paths are at most 512 UTF-16
code units and use `/`, with no
empty, `.` or `..` components, backslashes, colons or control characters. `shell` is an optional
boolean (default false); true uses the system shell as for the legacy pinned test. Unknown fields
are refused. `output_dirs` optionally lists paths excluded from tree digests, across all valid project
specs. They cannot hide `.rulith/acceptance`, any part of that directory, or their own test dependencies;
an output exclusion overlapping another spec's dependency is ignored for tree digests.
Include every test dependency in `files`; each digest hashes that file's exact bytes, without EOL
normalization. Files and specs cannot be links or pass through linked directories.

The **spec digest** hashes canonical JSON bytes: parse with `JSON.parse` (duplicate keys have its
last-key-wins meaning), recursively sort every object's keys by UTF-16 code unit order, retain array
order, encode keys and primitive values with `JSON.stringify`, and serialize compactly without
whitespace. Hash the UTF-8 encoding with SHA-256, with no BOM and no trailing newline. Optional
fields remain absent when omitted; defaults are not inserted. Object key order and JSON formatting
do not change the digest; changing a command, dependency digest or optional field does.

`eng.acceptance@1` takes no parameters. It reads only `.rulith/acceptance`, without the Source lock
or project tree walk, and returns sorted `eng.check_spec{check, spec_digest, files}` receipt rows,
where `files` is the dependency count. It does not read or verify dependencies. Each invalid spec
has an `error: "acceptance spec invalid"` text row in `errors` and contributes no fact. Worker
fact mappings apply only to valid spec `rows`. A legal filename's check is
included on its error row. Missing acceptance directories return no rows. Results stop at whole
rows within 1.8 KB and say `truncated: true` when further specs remain.

`eng.test@2` takes only `check`. It validates the project spec, verifies all listed files before
execution, then runs its command. A missing, unreadable, linked or changed dependency refuses with
`acceptance file changed: <project-relative path>`, with no facts and no command execution. Invalid
specs refuse with `acceptance spec invalid`; invalid check names/arguments use
`acceptance check invalid`. Receipts contain `eng.test_result{check, spec_digest, gen, tree_digest,
exit_code}` plus the usual `eng.tree_step`. A test that changes the tree stamps its final generation;
a no-change step is `(-1,-1)`. A nonzero exit is still reported, but cannot derive the criterion.
After execution the adapter rechecks dependencies and the spec digest, so a command cannot rewrite
its own frozen tests/spec and produce a passing fact. A changed valid spec uses `acceptance spec changed`.

The rule `ENG_CHECK_PASSED` derives `eng.check_passed(check, spec_digest)` from a successful result
at generation `g` unless an `eng.tree_step(from_gen:g, to_gen:n)` exists. The NAF variable `n` is
intentionally free. Later writes retract the criterion via closure. The frozen acceptance digest
lives on the Board in the signed leaf's desired atom: the kit does not copy specs into its home,
and the Source lock does not freeze the acceptance contract. `eng.test@1` still reads only
`<kit home>/specs/test.json` and retains its original contract and receipt shape.
