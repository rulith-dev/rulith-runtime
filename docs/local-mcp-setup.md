# This environment’s tools

The Runtime manager keeps one tool library for the Agents on this computer: tool definitions and
MCP services installed there are available to every Agent's Worker that uses it, with no per-Agent
tool selection; Console still decides what each Agent may call. The Rulith app does not need it:
the official general kit (`eng.*`) that setting an Agent up on this computer installs is per Agent.

The English workbench page that edited the library (**This environment’s tools**) is retired with
the workbench in Rulith 0.19.0. The library keeps working: edit its files by hand (formats below),
or use the manager's operations, which carry the same review-then-confirm steps the page drove:
`GET /manager/tools/state` (definitions, services and key names, never values), `/manager/tools/save`
and `/manager/tools/remove` for declared tools, `/manager/tools/mcp-prepare`, `mcp-probe`,
`mcp-apply` and `mcp-remove` for MCP services, and `/manager/instances/tools` to check an Agent's
move to the library again.

- **Declared tools:** HTTP, database query/write, workspace and declared MCP tools in the library's
  `worker-tools.json`. Script (`run`) tools stay in the Agent's own tool file because their code
  runs from that Agent's folder.
- **MCP tools:** services in `mcp/services.json` with the tools selected from each. Removing a
  service removes its local configuration; it does not revoke Cloud permissions or remove
  historical receipts.

Source keys stay in the environment vault, `worker-secrets.json`. They are never copied into tool
contracts. Per-Agent permissions remain in Console.

## Shared trust in an environment

A tool's own credentials, installed in this environment, are available to the tool processes of every Agent that uses the environment; Rulith only sends each Agent the calls it is authorized for. Put tools whose credentials some Agents must not reach into a separate environment.

This is the rule for what an MCP service saves with itself: its environment values, headers or
token travel with its launch settings into the composed files of every Agent that uses the
environment, and the service starts in each Agent’s Worker with them. Console decides which of
the calls an Agent makes are allowed, but not which processes hold the credential. Source keys
in the environment vault are different: a Worker is given the file’s location and reads only the
secret material of the entry for a Source Console has granted to its Agent. A separate environment is a separate
manager directory: start Rulith with its own `RULITH_MANAGER_HOME` (and `RULITH_MANAGER_PORT`).

## Add an MCP service

1. Prepare and discover the service (`/manager/tools/mcp-prepare`, then `/manager/tools/mcp-probe`),
   review the discovered input schemas and choose each selected tool's read/write/run
   classification, then apply it once (`/manager/tools/mcp-apply` with `confirmed: true`).
   Discovery never calls a tool. Rediscovery keeps selections only when the input schema is
   unchanged.
2. In the Agent's Console **Configuration → Sources**, establish the Source and review it.
3. Under **Runtime**, bind that Source for the Agent at its local location; enable and lock its
   required tools. Repeat this authorization for each Agent that needs it.
4. The Agent discovers the authorized Actions through `QueryBoard` and calls `ApplyAction`.

Installing and discovering prepare a change; they do not alter an existing saved tool. No package is
upgraded automatically. Applying from an outdated preparation is refused. A changed tool contract
needs to be locked again in Console. Only local tools whose composition changed reload, after running
work finishes; a change that is saved stays saved when one Agent's reload cannot be made, and that
Agent keeps its previous tools until a later change reloads it.

Tokens and environment values are not returned by the status operation or included in a Source
definition. Blank fields preserve stdio credentials only for an unchanged executable, arguments and
working directory; a changed target requires fresh values or explicit clearing. HTTP credentials
remain bound to their endpoint. Filesystem installation uses an exact package version and
integrity, disables npm lifecycle scripts, and does not install globally or auto-upgrade. Custom
stdio executables must already be installed. HTTP endpoints with credentials in their URL are
refused.

## Files, keys and migration

The library lives under `<manager-root>/library`, by default `~/.rulith/manager/library`.
It uses the existing manifest and MCP formats:

| File or folder | Content |
| --- | --- |
| `library.json` | Marker `{ "format": "rulith-environment-tools/1" }` |
| `worker-tools.json` | `rulith-worker-tools/1`, without `run` entries |
| `worker-secrets.json` | Environment Source keys, a JSON object keyed by Source name |
| `mcp/services.json` | `rulith-local-mcp/1`, saved services with their own launch credentials |
| `mcp/packages/`, `mcp/npm-cache/` | Installs and download cache |
| `mcp/workspaces/<service>/` | Discovery scratch, remapped per Agent at startup |

Directories are created with mode 0700 and files with mode 0600 where supported. On Windows,
protect the manager root with your account’s filesystem permissions. A file that cannot be
read or parsed is named and preserved, never replaced with an empty configuration.

The manager's tool state lists key names and types only. Add or change a Source key by editing
`worker-secrets.json`. The file is never returned by a route. Keys live once
in this environment: `RULITH_ENVIRONMENT_SECRETS_FILE` names that vault. A Worker reads an entry
only for a Source granted to its Agent in Console, and only when its Agent’s own vault has no
entry under that name.

**An environment key supplies secret material only** (a token, headers, the userinfo of a database
DSN) for the Source granted under its name. It cannot say what the Source is, or where or how it
connects; the Worker refuses the whole entry, and its log says which part, without quoting it, when:

- its `type`, if stated, is not the granted Source’s type;
- a `url` or `access` it states is not the granted address, or the Source was granted no address
  (an entry cannot add one);
- a database `dsn` does not have the granted host, port and database. The userinfo is what it
  supplies and may be anything; a query that names a `host`, `hostaddr`, `port`, `dbname`,
  `service` or `servicefile` of its own is a second address and is refused. The granted access
  must be a URL, since there is no address to compare otherwise;
- it states a `command`, `args` or `cwd`, or a `transport` other than the one the granted address
  implies (`streamable-http` for an `http(s)` address, `stdio` for a `stdio:` locator).

A `token`, `headers` and a checked `dsn` are all it supplies; any other field it carries (`env`,
`timeoutMs`, `allowHosts` …) is ignored and named in the Worker’s log. How to start or reach a Source
stays in the Agent’s own vault, which is why migration keeps such entries there (below).

**When a key is picked up.** A Worker reads the vault when it starts and again when it is first
given work for a Source it has not loaded yet. Adding a key therefore needs no reload only for a
Source granted to the Agent after its Worker started, before work first names it. A key you add or
change for a Source the running Worker has already loaded (granted before the Worker started, or
used since) is not seen until that Agent’s Worker reloads: set that Agent up on this computer again in the app,
or restart Rulith. No other Agent needs reloading, and nothing is
copied. Existing private deployment entries retain today’s precedence; migration removes moved keys
from active per-instance vaults. An MCP service’s own env, headers or token travel with its
configuration (see Shared trust above) and remain absent from status responses and Source definitions.

Each Agent starts with its own script definitions and non-secret Source locations plus the
entire library. The composed `environment/worker-tools.json` and `environment/worker-secrets.json`
inside its profile hold definitions and service inputs, without environment Source keys.
These composed files are private, replaced atomically and removed when the Worker stops. They hold
the launch settings and credentials of the environment’s MCP services, so a file that cannot be
removed (Windows can hold one open for a moment) is retried four times over about fifteen seconds
and once more when the manager closes, and is then named on Rulith’s terminal: delete it yourself
once nothing is using it, and Rulith never removes one from under a Worker that is running again.
Duplicate identical definitions merge; differing definitions, duplicate handlers and the
128-tool advertisement limit refuse startup with a notice rather than overwriting an entry.
File operations use the governed file Source’s root for that Agent. Discovery scratch becomes
`<profile>/environment/work/<service>`; an explicitly configured service folder is shared by
every Agent using that service, and the tool state names it.

On the first manager start after upgrading from a Runtime without the library, existing per-instance tools, MCP services,
installed packages and secret-bearing vault entries are merged into the library before local
tools are restored. Equal entries deduplicate, and migrated Agents receive all library tools.
Permissions in Console do not widen. Script tools and non-secret locations stay with their
Agent, as do externally configured manifests and vaults. A vault entry moves into the
environment’s keys only if it holds a credential and states nothing but `type`, `token`,
`headers` and `dsn`. One that also says where or how to connect (a `url` or `access`, a
`transport`, `command`, `args` or `cwd`) or carries anything else the environment ignores
(`env`, `timeoutMs` …) stays in that Agent’s own vault, where it works as it always did, and the
Agent’s notice names it. Original files that the move rewrites or removes are retained
in `<profile>/tools-before-environment/`; per-instance MCP caches and duplicate installs
are removed after the move commits. Interrupted migration resumes on the next start, including
a move containing only a manifest or keys. Restore from that backup before downgrading.

**The backup keeps the old secrets.** `tools-before-environment/` holds, exactly as they were, the
files the move rewrote or removed: the Agent’s tool file if tools moved out of it, its vault if keys
did, and its MCP service file. So the keys and the MCP services’ credentials that moved into the
environment are still in it, in plain text, readable only by your account where permissions are
supported. Rulith never reads or deletes it. When every Agent has started on the environment’s
tools and you no longer need to restore from it or downgrade, delete it yourself: stop Rulith,
then remove the folder `tools-before-environment` from each profile
(`~/.rulith/manager/instances/<id>/` by default), and any copy of the profile you made before. The
Recycle Bin or Trash keeps a copy until it is emptied. Do not delete it while its Agent still shows
the notice described next (in the tool state): the move is not finished, and the folder is the only copy of the
originals. Deleting it changes nothing the environment or any Agent runs.

If an Agent moved but some of its old files could not be removed (another program holds them
open), its notice says so, and until they are gone its Worker may refuse to start with a message
that a tool or Source “differs”: the old copy still sits beside the library’s. Close whatever holds
the files, then check that Agent again (`/manager/instances/tools`); starting the manager again retries it too, and the
notice goes when nothing is left. When the check cannot remove them it says why instead of
that the Agent is fine: its Agent or Worker is running (nothing is removed under a running Agent;
the files go the next time the manager starts with it stopped), a service or tool in the old
files differs from the environment’s (nothing is removed that is not the environment’s; delete that
old copy yourself if the environment’s is the right one), or a file cannot be read.

A differing Tool ID, service or key name leaves the affected Agent on its own unchanged files
with a notice. Resolve the conflicting side, turn that Agent's local tools off, then check it again. Profiles with live or orphaned processes are skipped.

MCP launch checks refuse roots, working directories and identifiable absolute path arguments
that expose the manager tree, at configuration and again at startup. Folders inside
`mcp/workspaces` (discovery scratch) and files inside `mcp/packages` (the library’s own
installed entry scripts) are permitted; those two folders themselves are not. These checks do not confine an
arbitrary executable; arguments containing flags, globs or embedded roots are not all
recognizable. A governed file Source whose root contains the manager directory remains an
existing limitation outside this change; choose separate Source folders.

Single-instance deployments retain their own `mcp/services.json`, manifest and Source vault, in the
same configuration formats.

## MCP directory

`/manager/tools/mcp-search`, `mcp-detail` and `mcp-downloads` read the public
[MCP Registry API](https://modelcontextprotocol.io/registry/registry-aggregators) and the public npm
last-month download counts, with pagination, five-minute bounded in-memory caching and no
background polling. A listing is not a code security review, a license grant, or Agent
authorization; a download count covers all versions of that package, not users or invocations.

Automatic directory setup supports npm packages exposing one Node.js executable over stdio, and fixed HTTPS Streamable HTTP endpoints with declared static headers. It rereads the selected version's metadata before preparing it, rejects inactive/changed records, checks the npm package's `mcpName`, exact version and SHA-512 integrity, and disables lifecycle scripts. It does not run arbitrary runtime commands from directory metadata. PyPI, OCI, NuGet, Cargo, MCPB, custom runners, ambiguous executables, URL templates and interactive OAuth setup require manual installation/configuration; the details page explains unsupported templates. Installation can still fail if a third-party package needs disabled lifecycle scripts or has an incomplete declaration.

Directory configuration stays in the manager's memory until tool discovery and saving; unsaved preparations expire after ten minutes. All directory launch arguments and environment/header values remain private, including secrets embedded in arguments. Saved service records retain directory identity, reviewed metadata digest, package version and integrity for inspection. Each npm service uses its own working directory under `mcp/workspaces/<source-name>`. To change its launch inputs, prepare it again; ordinary tool reselection reuses saved inputs without returning secrets.

The first importer supports named inputs representable by the existing Worker scalar, optional and JSON types. It retains the full MCP schema for review; constraints such as enums, bounds and nested object schemas are enforced by the MCP server. Reserved `source`, incompatible parameter names and composed/open root input schemas require a manually authored adapter. Up to 32 tools can be selected for one Source.

Plain MCP results are material. The generated definitions use `returns: []` and do not invent domain predicates or certified business facts. Write/run actions retain the existing grounding and constitutional checks; installing a write tool does not authorize arbitrary writes. A capability can separately declare the result mappings and premises needed for its business workflow.

Automatic grounded write/run Actions refuse required `json` parameters before saving or authorization, naming the affected parameter. The current grounding rule only accepts scalar values backed by trusted Board facts; objects, arrays and null cannot be grounded. JSON reads remain supported. Optional `json?` write/run inputs can be omitted or supplied as trusted scalar values; optional does not permit structured writes. Use an adapter with explicit scalar validation when appropriate, and never reclassify an actual write as a read. The inventory explains this restriction for built-ins such as `rulith.workspace.write_json@1` too; their local contracts remain available for separately authored capability execution. Console checks the advertised operation kind for every Source type and rejects the reserved business parameter name `source` before configuration publication.

This workflow is included in Runtime 0.7.4 and requires the matching Gateway/Console generic MCP Source support introduced in Java commit `87058e6`. An older Gateway may refuse the imported definition; updating Local alone does not add the Cloud authorization interface. Existing Source credentials and grants are not changed by installing this Runtime.
