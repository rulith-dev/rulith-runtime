# Local MCP setup

Open the URL printed by `rulith start`, then **MCP services · install and configure**.
Stop Agent and Worker using Runtime controls before changing executable configuration.

1. Search the official **MCP Registry** by server name, browse results and open **Details and setup**. Review the publisher, version, repository and installation option. Complete the declared arguments or credential fields, then install/configure that option. The Filesystem quickstart preset and manual stdio / HTTP configuration remain available.
2. Discover tools, inspect their input schema, and explicitly select each tool's read/write/run classification. Discovery never calls a tool.
3. Save the selected tools. Start Worker so its advertisement includes them.
4. Download the Source definition. In the Agent's Console **Configuration → Sources**, import and review it.
5. Under **Runtime**, bind that Source to the correct Connection and the location displayed by Local; enable and lock its required tools.
6. The Agent discovers the authorized Actions through `QueryBoard` and calls `ApplyAction`.

Local stores one atomic configuration in `mcp/services.json` beside `local.json`. Executables and npm cache live under that same `mcp` directory. Worker startup merges the existing manifest and vault into generated local files; duplicate Source names or Tool IDs are refused. The original input files are not edited. Removing a service removes its local saved configuration and stopped projections; Cloud grants and existing receipts remain governed in Console.

Tokens and environment values are not returned by the Local status API or included in the Source download. Put credentials in the dedicated token/environment fields. Filesystem installation uses an exact package version and integrity, disables npm lifecycle scripts, and does not install globally or auto-upgrade. Custom stdio executables must already be installed. HTTP endpoints with credentials in their URL are refused.

Directory search uses the public [MCP Registry API](https://modelcontextprotocol.io/registry/registry-aggregators), with pagination, five-minute bounded in-memory caching and no background polling. Search matches server names, not a locally invented list of recommended services. The registry includes both open-source and hosted services; a listing is not a code security review, a license grant, or Agent authorization. Network failure is shown explicitly; saved services and manual configuration remain available.

Automatic directory setup supports npm packages exposing one Node.js executable over stdio, and fixed HTTPS Streamable HTTP endpoints with declared static headers. It rereads the selected version's metadata before preparing it, rejects inactive/changed records, checks the npm package's `mcpName`, exact version and SHA-512 integrity, and disables lifecycle scripts. It does not run arbitrary runtime commands from directory metadata. PyPI, OCI, NuGet, Cargo, MCPB, custom runners, ambiguous executables, URL templates and interactive OAuth setup require manual installation/configuration; the details page explains unsupported templates. Installation can still fail if a third-party package needs disabled lifecycle scripts or has an incomplete declaration.

Directory configuration stays in Local memory until tool discovery and saving; unsaved preparations expire after ten minutes. All directory launch arguments and environment/header values remain private, including secrets embedded in arguments. Saved service records retain directory identity, reviewed metadata digest, package version and integrity for inspection. Each npm service uses its own working directory under `mcp/workspaces/<source-name>`. To change its launch inputs, reopen directory details and configure them again; ordinary tool reselection reuses saved inputs without returning secrets to the browser.

The first importer supports named inputs representable by the existing Worker scalar, optional and JSON types. It retains the full MCP schema for review; constraints such as enums, bounds and nested object schemas are enforced by the MCP server. Reserved `source`, incompatible parameter names and composed/open root input schemas require a manually authored adapter. Up to 32 tools can be selected for one Source.

Plain MCP results are material. The generated definitions use `returns: []` and do not invent domain predicates or certified business facts. Write/run actions retain the existing grounding and constitutional checks; installing a write tool does not authorize arbitrary writes. A capability can separately declare the result mappings and premises needed for its business workflow.

Runtime and Gateway changes in this batch are not published yet. An older Gateway may refuse the imported generic MCP Source definition.
