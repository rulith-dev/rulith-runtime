# Set up Rulith

Run `rulith setup` and open the printed [workbench](local-manager.md). Sign in through Console, select an Agent, and complete its first-use setup. The Agent starts with its first message; local tools default to off and follow this Agent's saved setting. Reopen its setup from **Settings and details → Setup**.

1. Choose **existing agent / MCP client** or **run with Rulith**. The first uses your client's model; only the second needs local model settings.
2. Attach the selected Agent from the signed-in account directory. Pairing alone grants no tool access.
3. Select local resource locations or installed MCP services. Their credentials stay in the local vault. Send the selection for authorization and enable **Use this computer’s tools and files**.
4. Review the resources and actual tools in Console. Authorize your selection and wait for Worker confirmation.
5. For a Local agent, save your model endpoint/name/key on this computer and send the first message; the Agent starts automatically. For an existing client, use its MCP configuration from Console.

HTTPS deployments and loopback development origins are supported. The wizard does not install Core/Gateway services. Model endpoints accept the Runtime's existing OpenAI-compatible and Anthropic interfaces; model keys may be omitted for loopback services.

Existing credentials are preserved. Replacing an Agent's client token requires an explicit choice in the authorized pairing flow and invalidates all copies of the previous token. Configuration changes reload the affected role automatically after its accepted work finishes. Pairing expires after ten minutes; lost responses resume the same request. Only device proof can retrieve credentials, and proof/private keys are removed after local persistence is acknowledged.

For the installed Verified Calculation capability, **Prepare calculation sample** writes the sample into a new empty directory, in the layout of `examples/verified-calculation/setup.mjs` (the Source's data in its `runtime` folder, the Release's default Source location), and points this Agent's Worker at it. It never overwrites existing files. The same click stops the Worker if it is running (a running Worker first finishes work it has claimed), sends its Source folder, `runtime`, for authorization when it is the only selected resource, enables local tools and reloads the Worker so Console can check its three calculation Tools. A running Agent keeps running. Other native tool/vault formats remain available under Worker tools and deployment configuration.

## Reading the conversation

Common Markdown headings, emphasis, lists, tables, links and fenced code are rendered in replies. Raw HTML is escaped, and images do not trigger remote requests.

Each executed tool call has an expandable arguments/result card. Accepted means the Board accepted that operation; it does not certify a Case. Unknown outcomes and handoffs remain distinct. Local display copies are bounded to 32 KiB per argument/result preview, with visible truncation; model-facing responses are unchanged. Old events that recorded only status cannot recover missing arguments. Local history stays local and continues to use the existing bounded session log.
