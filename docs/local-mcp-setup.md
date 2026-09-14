# Local MCP setup

Open the URL printed by `rulith start`, then **MCP services · install and configure**.
Stop Agent and Worker using Runtime controls before changing executable configuration.

1. Install the fixed Filesystem catalog version and choose its allowed directory, or configure an existing stdio executable / Streamable HTTP endpoint.
2. Discover tools, inspect their input schema, and explicitly select each tool's read/write/run classification. Discovery never calls a tool.
3. Save the selected tools. Start Worker so its advertisement includes them.
4. Download the Source definition. In the Agent's Console **Configuration → Sources**, import and review it.
5. Under **Runtime**, bind that Source to the correct Connection and the location displayed by Local; enable and lock its required tools.
6. The Agent discovers the authorized Actions through `QueryBoard` and calls `ApplyAction`.

Local stores one atomic configuration in `mcp/services.json` beside `local.json`. Executables and npm cache live under that same `mcp` directory. Worker startup merges the existing manifest and vault into generated local files; duplicate Source names or Tool IDs are refused. The original input files are not edited. Removing a service removes its local saved configuration and stopped projections; Cloud grants and existing receipts remain governed in Console.

Tokens and environment values are not returned by the Local status API or included in the Source download. Put credentials in the dedicated token/environment fields. Filesystem installation uses an exact package version and integrity, disables npm lifecycle scripts, and does not install globally or auto-upgrade. Custom stdio executables must already be installed. HTTP endpoints with credentials in their URL are refused.

The first importer supports named inputs representable by the existing Worker scalar, optional and JSON types. It retains the full MCP schema for review; constraints such as enums, bounds and nested object schemas are enforced by the MCP server. Reserved `source`, incompatible parameter names and composed/open root input schemas require a manually authored adapter. Up to 32 tools can be selected for one Source.

Plain MCP results are material. The generated definitions use `returns: []` and do not invent domain predicates or certified business facts. Write/run actions retain the existing grounding and constitutional checks; installing a write tool does not authorize arbitrary writes. A capability can separately declare the result mappings and premises needed for its business workflow.

Runtime and Gateway changes in this batch are not published yet. An older Gateway may refuse the imported generic MCP Source definition.
