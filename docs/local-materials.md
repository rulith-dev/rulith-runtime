# Local materials

Use **+ → Add files**, or drop a file onto the conversation composer. A file is stored in this Agent profile's local material area before it appears as ready. You can remove it from the message before sending. A message may carry up to eight files, each at most 8 MiB.

Adding a file gives the page a local `ui_` selection handle. Sending a message is what exposes a separate immutable `mat_` selector and full digest to the Agent. Neither value is the private custody ID used to store bytes. Sending does not upload contents to the Gateway, grant a tool, or certify the document's statements. The Agent must discover and call an authorized material-reading Action before it can use the contents.

An attachment send requires the page's request ID. The Host durably records one receipt for that click, binding the request ID, current Agent and owner, conversation key, and exact selected versions. Retrying the same click recovers its submission ID; changing the conversation or selection under that request ID is refused. The conversation key is retry context, not an authoritative Rulith Case binding. If the Host stops after recording the receipt, an exact retry can finish the per-material ledger. A stranded per-material submission lock still refuses the retry until repaired; it is not silently discarded.

For a new Case, the receipt also stores a private random task proof. The Host registers only its SHA-256 digest through the signed-in device and waits for an exact registration reply before passing the proof to the local Agent in a private task header. The Agent sends it only on the first create-form `OpenCase` MCP call; it is not model input, task body, event, or conversation history. A registration outage or mismatched reply leaves the durable click locally pending for an exact retry and sends nothing to the Agent. Attachments cannot currently target an existing `caseId`. A standalone Host without the signed-in device registration channel refuses attached tasks; text-only tasks still work. The Java Gateway/Core binding and material-read enforcement are separate integration work and are not implied by this local transport.

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

The submitted `mat_` selector is an input to this Action. It is not a file path or a credential. The Tool's result refers to an Artifact; the Agent reads that reference through the existing `ReadArtifact` tool. Reading the bytes does not create an attested business fact. The current read Tool has no signed Case context, so this selector split alone does not enforce whether a later Case submitted the same attachment; that check belongs to the future local-material production guard.

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

A failed addition offers **Add again** while the selected file is still available in
the open page. This retries local storage, not sending a message or reading the file
through an Action. An earlier request with an unconfirmed response may already have
stored a copy; explicit retry can retain another immutable original. Removing a chip
removes it from the draft, not from custody storage.

The page records the model service at file selection. If that destination changes,
retry refuses before storing bytes and asks the person to remove and select the file
again. An unset endpoint resolves to the same default used by the Agent. Older materials
recorded with an empty destination are preserved but require re-selection before use;
they are not silently granted disclosure to the default provider.

The Worker retains immutable originals and their integrity metadata. Closing a conversation or Case does not delete referenced materials. Keep this area with the profile's backups if the original evidence must remain available. An offline Worker is temporarily unavailable; missing or damaged originals are reported as unavailable or corrupt. The Gateway cannot reconstruct an original from its hash.

The store format is `rulith-materials/3`. An older material area is refused with `materials_store_migration_required`; its files are left in place. Add the files again under a fresh profile area to use them with this release. There is no automatic migration.

The document-to-capability assistant uses this transport for its local source document and checked result. The selector split is a prerequisite for the later Source-bound production guard; it does not itself authorize a new Artifact payload role.
