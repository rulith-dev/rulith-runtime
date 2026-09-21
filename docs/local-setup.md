# Set up Rulith

Run `rulith setup` and open the printed [Local manager](local-manager.md). Sign in through Console and approve the Agents this computer may use. Add an instance, choose its Agent, then open **Settings and details → Setup**. Each instance starts with its Agent and Worker stopped. Use `rulith setup --legacy` or an explicit `--config` for the original single-instance wizard.

1. Choose **existing agent / MCP client** or **run with Rulith**. The first uses your client's model; only the second needs local model settings.
2. In the manager, attach an Agent from the approved list. The standalone wizard instead asks for your Console origin and computer name, then uses a short code to confirm the target Agent in Console. Pairing alone grants no tool access.
3. Select local resource locations or installed MCP services. Their credentials stay in the local vault. Send the selection for authorization and start Worker.
4. Review the resources and actual tools in Console. Authorize your selection and wait for Worker confirmation.
5. For a Local agent, save your model endpoint/name/key on this computer, start Agent, and open the conversation. For an existing client, use its MCP configuration from Console.

HTTPS deployments and loopback development origins are supported. The wizard does not install Core/Gateway services. Model endpoints accept the Runtime's existing OpenAI-compatible and Anthropic interfaces; model keys may be omitted for loopback services.

Existing credentials are preserved. Replacing an Agent's client token requires an explicit choice in the authorized pairing flow and invalidates all copies of the previous token. Stop the relevant local role before changing its configuration. Pairing expires after ten minutes; lost responses resume the same request. Only device proof can retrieve credentials, and proof/private keys are removed after local persistence is acknowledged.

For the installed Verified Calculation capability, Local can prepare the sample in a new empty directory. It never overwrites existing files. Other native tool/vault formats remain available under Worker tools and deployment configuration.

## Reading the conversation

Common Markdown headings, emphasis, lists, tables, links and fenced code are rendered in replies. Raw HTML is escaped, and images do not trigger remote requests.

Each executed tool call has an expandable arguments/result card. Accepted means the Board accepted that operation; it does not certify a Case. Unknown outcomes and handoffs remain distinct. Local display copies are bounded to 32 KiB per argument/result preview, with visible truncation; model-facing responses are unchanged. Old events that recorded only status cannot recover missing arguments. Local history stays local and continues to use the existing bounded session log.
