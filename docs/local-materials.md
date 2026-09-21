# Local materials

Use **+ → Add files**, or drop a file onto the conversation composer. A file is stored in this Agent profile's local material area before it appears as ready. You can remove it from the message before sending. A message may carry up to eight files, each at most 8 MiB.

Sending a message carries attachment names and opaque material IDs. It does not upload their contents to the Gateway, grant a tool, or certify the document's statements. The Agent must discover and call an authorized material-reading Action before it can use the contents.

The initial reader supports UTF-8 text and preserves other files as binary material. It does not extract text from PDF or DOCX containers. Adding those files does not mean their text has been extracted.

## Authorize the reader

The Worker advertises `rulith.materials.read@1` when its profile has a material area. Configure a `file` Source whose access location is that exact area, then explicitly authorize this Tool on the Source's Connection. The material area belongs to the selected Agent profile; it is not a shared filesystem root for all Agents.

A material-only access mode uses no fact mapping:

```json
{
  "id": "read_material",
  "action": "read_material",
  "title": "Read added material",
  "operation": "read",
  "tool": "rulith.materials.read@1",
  "params": { "material": "string" },
  "returns": []
}
```

The material ID is an input to this Action. It is not a file path or a credential. The Tool's result refers to an Artifact; the Agent reads that reference through the existing `ReadArtifact` tool. Reading the bytes does not create an attested business fact.

## Delivery permissions

The Gateway's Artifact policy explicitly grants delivery per Agent and Source. For example, the following row allows a local Host to obtain a bounded read authorization while denying Gateway proxying and remote-model disclosure:

```json
{
  "sources": {
    "<agentId>/materials": { "localRead": true, "offMachine": false }
  }
}
```

The actual Agent ID and Source name must match the configured Source. Missing permission is a refusal. Enabling `offMachine` allows the separately authorized proxy path; it does not enable broader tool or Source access.

Rulith obtains current Gateway authorization before reading the local copy. The Host then checks the exact byte window, chunk integrity, current owner and model destination. A local-only material cannot be sent to a non-loopback model endpoint. Endpoint checks describe the configured destination; a user-operated loopback proxy may itself forward data elsewhere.

Local delivery is negotiated only for this profile's Worker Connection. An Agent-only profile or material held by another Connection uses the separately authorized proxy path. Once local delivery is agreed, an offline custodian or failed claim remains a visible refusal; it does not silently switch to proxy delivery.

An ordinary MCP client can receive permitted material through the Gateway proxy. Those bytes pass through bounded server memory and the network. They are not saved as Artifact payloads on the Gateway. This is different from a local delivery in which the Gateway carries only the authorization and metadata.

## Retained originals

The Worker retains immutable originals and their integrity metadata. Closing a conversation or Case does not delete referenced materials. Keep this area with the profile's backups if the original evidence must remain available. An offline Worker is temporarily unavailable; missing or damaged originals are reported as unavailable or corrupt. The Gateway cannot reconstruct an original from its hash.

This material transport is the foundation for document workflows. The full document-to-capability assistant, including rule extraction, clarification and checking, still needs its own workflow and acceptance.
