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
   (`engineering_work`, the second edition, in the Gateway's authoring format: `id`, `title`,
   `vocabulary.defines/imports`, `rules`, `acceptance`, `pins`, `actions`) and `pack/sources-v3.json`
   (`engineering_work_sources` version 3). The Gateway compiles the program to the Kernel's
   `rulith-domain-program`; the native format is not an install input. One authoring program defines
   one namespace, so the program defines the `eng.*` words only; Source `lab` accredits the `eng.*`
   receipt words and `web.page`/`web.search` (accreditation needs no definition). The criterion
   `eng.check_passed` is not accredited: only the package rule derives it.
   The program adds the check criterion rule and acceptance bridge, and no business Actions.
   The older `pack/program.json` and `pack/sources.json` stay byte-identical (that program defines two
   namespaces and does not compile). Install v2 on a new Board: same-name packages cannot be installed
   together or hot-upgraded.
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
| `treeExclude` | `[]` | Project-relative directories left out of the tree digest (build outputs, caches); `**/<name>` matches that folder at any depth. `.git` at the root is always excluded; a nested `.git` is hashed like any other folder unless you add `**/.git`. Owner exclusions are not a place for tested code: a write tool or `eng.apply_patch` writing under one is a tree step. |
| `imageMaxBytes` | 5242880 | Maximum image bytes (up to 20 MiB); the Worker's object budget also applies. |
| `webMaxBytes` | 1048576 | Maximum response bytes for fetch/search (up to 8 MiB). |
| `webTimeoutSeconds` | 20 | Total fetch/search deadline, including redirects and DNS (up to 120 seconds). |
| `webSearch` | absent | `{ "provider": "deepseek", "keyEnv": "DEEPSEEK_API_KEY" }`; no literal keys or credential files. |

Always refused: privilege elevation, killing processes or stopping services, push/publish, global
installs or configuration (git subcommands are checked anywhere in a shell line; `git -c` and
`--config-env` too), inline interpreter code (`node -e`, `python -c`, …), paths in the root `.git` (as
the working directory or a command word) and paths that escape the project or the allowed directories.
Inline code includes combined and attached forms (`node -pe`, `node -e<code>`, `python -c<code>`,
`python -Ic`, `python -Rc`, `perl -ne`), a `data:` URL in any `--option=data:…`, given as an option's
value (`--import data:…`, `-r data:…`) or named as the script, and the Python modules that evaluate
their arguments (`-m timeit`, `pdb`, `profile`, `cProfile`, `code`, `IPython`). A preloaded module that
is a file or package (`node --import tsx`, `-r ts-node/register`) is readable code and runs. Only the
interpreter's own options are read: the words before the script (or `python -m`), an option's separate
value included. Words after the script are its arguments, so `node test.mjs -p 8080`,
`python run.py -config a.yml`, `node --test test/ -r` and `deno run -A main.ts -p 8080` run. An unknown
long option without `=`, and for node an unknown short option, is taken to have a value, so it cannot
end the scan early (a rare false refusal rather than a gap). Interpreters: `node`, `nodejs`, `bun`,
`tsx`, `ts-node`, `python`/`python3`/`pythonw`/`pypy`/`pypy3`/`py`, `perl`, `ruby` (`-E` is the
encoding), `php` (`-r`, `-B`, `-R`, `-E`), `R`/`Rscript` (`-e`), `deno` (`eval`, `repl --eval`,
`--eval`/`--print` before the script, any `data:` word), and `awk` unless its program is a file (`-f`).
Launchers and wrappers are read through: `npx`, `bunx`, `pnpx`, `uvx`, `npm exec`/`x`, `pnpm exec`/`dlx`,
`yarn dlx`, `bun x`, `deno x`, `uv run`, `uv tool run`, `poetry run`, `pipenv run`, `pdm run`, `hatch run`,
`pipx run`, `conda run`, `rye run`, `bundle exec`, `time`, `nice`, `nohup`, `timeout`, `xargs`, `find` and
`stdbuf`: every later word is read as a command (an interpreter, a shell, git, awk or another launcher), so
a value the launcher takes cannot hide the program. Their whole option list is scanned for `-c`, `--call`
and `--shell-mode` (a shell line); `yarn exec` is itself a shell line and, like a shell named after a
launcher, needs the owner's `shell` setting. More than four nested launchers are refused.
The fence is about visible intent, not a sandbox. Known gaps: other launchers and wrappers not listed
above, interpreters not listed (for example `java`/`jshell`, `lua -e`, `R CMD`), program text in other
tools' arguments (`sed`'s `e` command, `find -exec sh` with the shell enabled, a build tool's inline
scripts), and a script file named on the line, which can still do anything the Worker's user can; what
the fence buys is that the ordinary ways to hide code in a command line are refused and the code is a
project file anyone can read.

With the owner's `shell: true` the classifier is advisory only. It splits the line into words with
its own quoting rules (`argv`), not the shell's, and the shell then interprets the line as written:
variables, substitutions, globbing and the shell's own quoting can run what the classifier never saw.
The line is shown verbatim (in `eng.check_spec` for a check) and the owner chose the shell, so
enable it only for a project you trust.

## What a pass means

The kit is a fence, not a sandbox. Everything a command, check, measurement or job runs executes as
the Worker's operating-system user, and the kit cannot stop such a process from doing what that user
can. In particular:

- A project script can find the kit home (it is an ordinary directory that user can read; removing
  `ENG_KIT_HOME` from its environment only avoids handing it the path) and forge currency: rewrite
  the tree cache so a changed file keeps its recorded digest (an unchanged size and modification time
  are trusted), rewrite the state file, or edit `settings.json`. A settings change is a tree step,
  but a script can rewrite all three consistently.
- A pass is therefore only as trustworthy as the project scripts the check runs, and the scripts
  they in turn run. The signed `eng.check_spec` pins the check's own files, not everything they
  import or start.
- A command's own writes under an owner exclusion or the root `.git` are not seen by the tree digest.
  In particular a script can write `.git/config` (`core.fsmonitor`, aliases), and a later
  `git status` or `git <alias>` in a check then runs code the digest never sees.
- Launchers, wrappers and interpreters not on the list above can hide inline code, and with the
  owner's `shell: true` the classifier is advisory only.
- A project path outside printable ASCII cannot be an acceptance check in v1 (`cwd`, `files` and
  command words are refused by field).

## Behaviour

The original twelve `eng.*@1` contracts, parameter tables, predicate mappings and receipt fields
are preserved. New contracts:

| Tool | Inputs | Result |
| --- | --- | --- |
| `eng.glob@1` | `pattern`, optional `limit` (1–128; default 64) | Sorted project files, at most 1.8 KiB of rows; `truncated` if capped. Supports `*`, `**`, `?`, character classes. Skips the root `.git`, tree exclusions (a nested `.git` only under `**/.git`), and links; refuses walks over 20,000 entries. At most 20 wildcard tokens; walking and matching share a five-second deadline (`glob complexity refused`). This allows ordinary repositories on slower disks while bounding pathological requests. |
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
- The tree's identity includes the settings that decide what is hashed and what may run:
  `tree_digest = sha256(file-tree digest ‖ sha256(the sorted effective exclusions, shell, allow and
  allowedPaths))`, both inner digests as lowercase hex. Widening `treeExclude` or changing `shell`,
  `allow` or `allowedPaths` therefore changes the digest even with no file changed: the next receipt
  records a tree step from the previous generation, and earlier passes stop being current like after
  a write. Time limits and web settings are not part of it.
- `.git` at the root is always excluded, so no write tool or `eng.apply_patch` writes there and no
  command runs in it or names a path in it (`path refused`), in any spelling the file system accepts
  (case, trailing dots or spaces, short names). A `.git` file or folder anywhere else is hashed.
- A write tool or `eng.apply_patch` that touches a path under an exclusion (the root `.git` aside) is a
  tree step even though the digest cannot see the change: owner exclusions are for build outputs and
  caches, not for tested code. A command's own writes there are not seen.
- Commands, checks, measurements and jobs run without the kit's and the Worker's variables: every
  `ENG_*` (including `ENG_KIT_HOME`) and `RULITH_*` variable is removed from their environment, and a
  job's supervisor receives its job file through such a variable rather than its command line, so a
  script is not handed the location of the owner's settings, specs, tree cache or state file. That is
  not secrecy and not protection: see "What a pass means" below.
- A project-relative path containing `:` is refused by every tool, reads included (`path refused`):
  on NTFS `file:name` is an alternate data stream that no directory walk sees. On POSIX, where `:` is
  an ordinary file-name character, a project containing such a name cannot be walked by the kit.
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
`self-<name>`, all in lower case (`spec refused: a self- spec_id is lower case` for any other case, so a
case-insensitive file system cannot open a frozen `self-` file as an owner spec). The first run that passes every check copies the spec to `<kit home>/specs/self-<name>.json`,
where it never changes; later edits of the project copy are ignored. A refused spec is not frozen, so it
can be corrected under its name. The `self-` prefix stays on every receipt, so the
owner can review such specs afterwards and tell them from the owner's own.

A `self-` spec is written by the model, so it is held to what the model may do anyway. Its command
passes the same classifier as `eng.run` (`command refused`, `path refused`) and never goes through a
shell. Its `interpreter`, if any, is `node`, `python`, `python3`, `ruby` or `perl`, or an absolute
path under the owner's `allowedPaths`. It has no `output_dirs` (`spec refused: a self- spec has no
output_dirs`): a measurement's own outputs belong under the owner's `treeExclude`. A `self-` file in
`<kit home>/specs` never adds a tree exclusion, even one frozen by an earlier version with
`output_dirs`; only the owner's own specs and `treeExclude` do. Freezing it is no tree step either: the
tree digest covers the owner's spec files only (a change to one of those is a step), while a `self-`
spec's source under `.deep-rulith/measure/` is part of the project tree. The owner's specs are unchanged.

## Completing a goal

Certification means an acceptance contract was fulfilled: a root goal, criterion leaves and a signer.
After discovering check receipts, declare child goals with `desired` atoms
`eng.check_passed(check, spec_digest)` under the root using `declare_goal`. The person signs the
leaves in Console (`SignAcceptance`); the Kernel plants `acceptance(node, test)` with `test` equal
to the value of the atom's first declared argument, `check`. The package bridge connects that check
name to `acceptance_met(node)`. The leaf's own `goal_met` also requires the exact desired atom,
so its signed digest must hold. A bridge match for a different digest cannot fulfill that leaf.
The Board's contract machinery completes the root when all signed leaves fulfill.

Console renders the `eng.check_spec` fact whose `check` and `spec_digest` match a proposed leaf
next to that leaf, so the person reads the command, working directory, shell flag and every
frozen file digest the leaf's digest denotes before signing. Without such a
fact there is nothing to read; `eng.test@2` refuses a spec that `eng.acceptance@1` cannot report.

`eng.check_passed`, `eng.check_result`, `eng.check_spec` and `eng.tree_step` are package pins
(committed derivation). Model assertions and model rule heads using them are refused with
`goalpost_moved`; Worker receipts and package rules provide the evidence. The model does not
write a completion rule. Console signing and certification require the D-1016a Kernel/Gateway work.

Limits of the vocabulary, stated rather than enforced here:

- The authoring format's definitions carry only `id`, `as` and `args`; it has no `key` notion. A leaf
  whose desired atom omits `spec_digest` would match any digest. Console and the Kernel's signing
  guard must require both arguments of `eng.check_passed` on a signed leaf.
- The receipt facts carry no Source column. A run adapter is not told its Source name (the Worker
  passes only `RULITH_SOURCE_ACCESS` and `RULITH_SOURCE_TYPE`), so `"$source"` cannot be mapped.
  Each receipt is still bound to its invocation's Source by the Kernel's accreditation. Generations
  are per project: bind one `lab` project per Board when checks are used as criteria.
- The check observes what its process reports. Code under test runs inside the test process and can
  sabotage it (for example `process.exit(0)` before an assertion, or a wrapper that swaps code and
  restores it). The contract covers what the check observes, not an adversarial project; the person
  reads the command and every frozen file, wrappers included, in `eng.check_spec` before signing.

## Project acceptance specs

Write `.rulith/acceptance/<check>.json` in the project, with a check matching
`^[a-z][a-z0-9_-]{0,39}$` (a letter first: an all-digit name would become a number on the Board).
For example (replace the digest with the actual test file SHA-256):

```json
{
  "command": ["node", "test/acceptance.mjs"],
  "cwd": ".",
  "files": { "test/acceptance.mjs": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  "shell": false
}
```

Specs are UTF-8 JSON objects, at most 16 KiB, without a repeated key in any object, with exactly the
fields `command`, `cwd`, `files` and optional `shell`. `command` is a nonempty array of nonempty
strings, or with `shell: true` one nonempty string (the command line); `cwd` is required and is `.`
or a project-relative directory.
`files` maps at most 32 test dependency paths to lowercase, 64-character SHA-256 hex strings. Paths
are at most 512 UTF-16 code units and use `/`, with no empty, `.` or `..` components, backslashes,
colons or control characters. `shell` is an optional boolean (default false). Unknown fields are
refused. Include every test dependency in `files`; each digest hashes that file's exact bytes,
without EOL normalization. Files and specs cannot be links or pass through linked directories.
Command words (or the shell line), `cwd` and `files` paths are shown on the Board for a person to
sign, so they must be printable ASCII (0x20–0x7E) without a leading or trailing space; anything else
is refused, naming the field: `acceptance spec invalid: command`, `acceptance spec invalid: cwd` or
`acceptance spec invalid: files`. Invisible and look-alike characters (look-alikes such as the
Cyrillic e U+0435, the blank U+2800, combining marks) cannot be listed reliably by category, so in v1 a project path or
argument outside ASCII cannot be part of an acceptance check.

A spec has no output directories (an `output_dirs` field makes it invalid). The owner's `treeExclude`
setting is the only exclusion: every change a check's own run makes outside it is a tree step like
any other tool's, so a model-written spec cannot keep other checks passing on code they never tested.
A check whose own run changes the tree is stamped at the generation and digest before the run and
the same receipt records the step to the new one, so such a run never passes on the tree it created.
This holds when the run ends on the last recorded tree too (it reverted a change made outside the kit):
it tested the changed tree, so its receipt still carries a step. A
check that writes output must write it under a `treeExclude` directory the owner set, or outside the
project (for example the system temporary directory).

The model writes specs, so the command is classified exactly like `eng.run`: privilege elevation,
process control, push/publish, global installs, inline interpreter code, shell executables and
shell metacharacters are refused (`command refused`), paths outside the project need the owner's
`allowedPaths` (`path refused`), and the owner's `allow` list applies. `shell: true` runs through
the system shell only when the owner's `settings.json` enables `shell`; otherwise the check refuses
with `acceptance shell refused`. With `shell: true` the command is one string that the shell receives
exactly as written, and `eng.check_spec` shows exactly that string. Without `shell: true` the
command is an argv array and never goes through a shell.

The **spec digest** hashes canonical JSON bytes of the spec `{command, cwd, files, shell}` with its
default written out (`shell: false` when omitted): recursively sort every object's keys by UTF-16
code unit order, retain array order, encode keys and primitive values with `JSON.stringify`, and
serialize compactly without whitespace. Hash the UTF-8 encoding with SHA-256, with no BOM and no
trailing newline. Object key order, JSON formatting and omitted defaults do not change the digest;
changing the command, the working directory, a dependency digest or `shell` does.
The digest is thus a function of the `eng.check_spec` fact alone.

`eng.acceptance@1` takes no parameters. It reads only `.rulith/acceptance`, without the Source lock
or project tree walk, and returns sorted
`eng.check_spec{check, spec_digest, command, cwd, shell, files}` receipt rows. `command` is the
command as one line: a shell command line stands exactly as written; for an argv array, a word
without whitespace, quotes or control characters stands as written and any other word is a JSON
string (a token starting with `"` is JSON, every other token is literal). `files` is the JSON text
`[{"path":…,"sha256":…},…]` sorted by path. It does not read or verify dependencies. Each invalid
spec has an `error: "acceptance spec invalid"` text row (or the field-named form above) in `errors` and contributes no fact. A spec
whose row alone would not fit the Worker's inline receipt (7 KiB of the 8 KiB budget, measured as the
result text plus its facts) has `error: "acceptance spec too large"` instead. A legal filename's check
is included on its error row. A missing acceptance directory returns no rows; one that cannot be
listed (a file, a link, unreadable) returns the single error row `acceptance directory unreadable`
and blocks no other tool. Results stop at whole rows within the same budget and say
`truncated: true` when further specs remain.

`eng.test@2` takes only `check`. It validates the project spec, refuses one too large to report
(`acceptance spec too large`), verifies all listed files before execution, classifies the command,
then runs it. A missing, unreadable, linked or changed dependency refuses with
`acceptance file changed: <project-relative path>`, with no facts and no command execution. Invalid
specs refuse with `acceptance spec invalid`; invalid check names/arguments use
`acceptance check invalid`. Receipts contain `eng.check_result{check, spec_digest, gen, tree_digest,
exit_code}` plus the usual `eng.tree_step`. A test whose own run changed the tree is stamped at the
pre-run generation, with the step from it to the new generation in the same receipt, so it cannot
derive the criterion; a no-change step is `(-1,-1)`. (`eng.test@1` keeps stamping its final
generation.) A nonzero exit is still
reported, but cannot derive the criterion. After execution the adapter rechecks dependencies and the
spec digest, so a command cannot rewrite its own frozen tests/spec and produce a passing fact. A
changed valid spec uses `acceptance spec changed`.

The rule `ENG_CHECK_PASSED` derives `eng.check_passed(check, spec_digest)` from a successful
`eng.check_result` at generation `g` unless an `eng.tree_step(from_gen:g, to_gen:n)` exists. The NAF
variable `n` is intentionally free. Later writes retract the criterion via closure. The frozen
acceptance digest lives on the Board in the signed leaf's desired atom: the kit does not copy specs
into its home, and the Source lock does not freeze the acceptance contract. `eng.test@1` still reads
only `<kit home>/specs/test.json` and returns its original four-argument `eng.test_result`, which
the v2 program defines unchanged and from which nothing is derived.
