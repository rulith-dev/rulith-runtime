// SPDX-License-Identifier: Apache-2.0
/**
 * The Local host's side of the material area: add, list, attach, and route a local read.
 *
 * Four routes and one rule they all share: **contents stay on this machine unless an authorized
 * read asks for them.** Adding a file stores bytes and returns metadata. Listing returns
 * metadata. Attaching a material to a case forwards metadata and nothing else. The delivery
 * route produces bytes, and it produces none of them itself.
 *
 * That last part is the shape worth stating. This host does **not** authorize a local read and
 * holds no capability that could. The Gateway mints a per-read ticket; the Agent hands it here;
 * this host passes it to the custodian — the Worker child, which holds the Connection the ticket
 * was issued to — and the Worker exchanges it for a current Gateway authorization before reading
 * one byte. There is deliberately no host-signed fallback that would return a file's contents on
 * the strength of an attachment id: that would be this host issuing itself permission.
 *
 * The service holds no state of its own. Every call re-opens the store under the identity **in
 * force now**, because the thing a caller could change between two requests — which Gateway,
 * Connection and Agent this profile is — is exactly what the owner binding is about.
 */
import {
  MAX_ATTACHMENTS, MAX_MATERIAL_BYTES, MaterialError, decodeCanonicalBase64,
  normalizeModelDestination, openMaterialStore,
} from '../worker/material-store.mjs'

/**
 * The instruction a host writes when a person attached files and said nothing.
 *
 * It names the attachments by their metadata and tells the model to go and find an authorized
 * Action that reads them. It deliberately does not paraphrase, summarize, or hint at content:
 * the host has not read the files either, and a generated sentence that sounded like it had
 * would be the host asserting something no read has established.
 */
export function attachmentInstruction(materials) {
  const listed = materials.map((material) =>
    `· ${material.name} (${material.mediaType}, ${material.totalBytes} bytes, id ${material.id})`).join('\n')
  return `The user attached ${materials.length} local material${materials.length === 1 ? '' : 's'} and wrote no message.\n${listed}\n\n`
    + 'You have not been given their contents, and this host has not read them either. Inspect them by finding an'
    + ' authorized Action that references the material read Tool, and dispatch it with the material id above.'
    + ' Do not describe, summarize or assume anything about a material you have not actually read.'
}

export function createMaterialService({ root, getIdentity, custodian, key }) {
  const configured = String(root ?? '').trim() !== ''
  /** The store under the identity in force now — never one captured at startup. */
  const open = () => {
    if (!configured) {
      throw new MaterialError('materials_not_configured',
        'This Rulith profile has no material area configured, so it stores and reads no local materials.')
    }
    return openMaterialStore(root, getIdentity())
  }
  return {
    key,
    configured,
    get root() { return configured ? String(root) : '' },
    /**
     * Create the area now, so a role that is about to be told where it is finds it there.
     *
     * Returns the resolved root, or `undefined` when the area cannot be opened at all — a
     * profile whose store is marked with another format version, or bound to another owner, is
     * one of those, and the right answer is to start the role without a material area rather
     * than pointing it at something this build refuses to read.
     */
    ensure() {
      try {
        return open().root
      } catch {
        return undefined
      }
    },
    /** The bindings a caller may be shown. Never a secret, and never a content byte. */
    overview() {
      if (!configured) return { configured: false }
      try {
        const identity = getIdentity()
        return {
          configured: true,
          modelDestination: identity.modelDestination,
          localOnly: identity.localOnly,
          materials: open().list().length,
        }
      } catch (error) {
        return { configured: true, unavailable: error instanceof MaterialError ? error.code : 'materials_unavailable' }
      }
    },
    /**
     * Store one file. Everything that could make this the wrong file to store is refused before
     * any byte lands, and the bytes land whole before the caller is told it worked.
     */
    add(body) {
      // A retry retains the destination shown when the file was selected. Never silently
      // attribute that selection to a different model after a configuration change.
      if (body?.modelDestination !== undefined
        && normalizeModelDestination(body.modelDestination) !== normalizeModelDestination(getIdentity().modelDestination)) {
        throw new MaterialError('material_destination_changed',
          'The model service changed after this file was selected. Remove it and add it again under the current configuration.')
      }
      const store = open()
      const bytes = decodeCanonicalBase64(body?.bytes)
      if (bytes.byteLength > MAX_MATERIAL_BYTES) {
        throw new MaterialError('material_too_large',
          `This file is ${bytes.byteLength} bytes and the per-file limit is ${MAX_MATERIAL_BYTES}.`)
      }
      const record = store.put({ name: body?.name, mediaType: body?.mediaType, bytes })
      return { material: store.publicMaterial(record) }
    },
    /** Metadata for this exact profile and owner. */
    list() {
      return { materials: open().publicList() }
    },
    /**
     * Validate membership for a case submission, and produce what may be forwarded.
     *
     * Membership is checked against the owner binding, and disclosure against the destination in
     * force, **before** anything reaches the Agent. A submission naming one material this profile
     * does not own fails as a whole: partially honouring it would send the Agent a list that does
     * not say which of the user's selections were dropped.
     *
     * What travels is metadata. There is no ticket to travel with it — the only ticket in this
     * protocol is the Gateway's, minted per read, and an attachment is not a read.
     */
    attachments(ids, context) {
      if (ids === undefined) return { attachments: [] }
      if (!Array.isArray(ids)) {
        throw new MaterialError('attachments_invalid', 'attachments must be an array of material ids.')
      }
      if (ids.length === 0) return { attachments: [] }
      if (ids.length > MAX_ATTACHMENTS) {
        throw new MaterialError('attachments_too_many',
          `A case submission carries at most ${MAX_ATTACHMENTS} attachments; this one names ${ids.length}.`)
      }
      if (new Set(ids.map(String)).size !== ids.length) {
        throw new MaterialError('attachments_repeated', 'A case submission names each attachment once.')
      }
      const store = open()
      const identity = getIdentity()
      const rows = []
      for (const raw of ids) {
        const id = String(raw ?? '')
        const record = store.selected(id)
        if (record.disclosure?.modelDestination !== identity.modelDestination) {
          throw new MaterialError('material_disclosure_refused',
            `${record.name} was added while this profile was configured for`
            + ` ${JSON.stringify(record.disclosure?.modelDestination ?? '')}, and the model destination is now`
            + ` ${JSON.stringify(identity.modelDestination)}. Add the file again under the current configuration if you`
            + ' meant to disclose it there.')
        }
        if (record.disclosure?.localOnly === true && !identity.localOnly) {
          throw new MaterialError('material_local_only',
            `${record.name} was added while this profile used a local model. It is not disclosed to a remote one.`)
        }
        try { store.verify(record.id) }
        catch (error) {
          if (error instanceof MaterialError) {
            throw new MaterialError(error.code, error.message.replaceAll(record.id, id))
          }
          throw new MaterialError('material_unavailable', 'The selected local material could not be verified.')
        }
        rows.push({ handle: id, record })
      }
      return { attachments: rows.map(({ handle, record }) => {
        try { return store.submitSelected(handle, context) }
        catch (error) {
          if (error instanceof MaterialError) {
            throw new MaterialError(error.code, error.message.replaceAll(record.id, handle))
          }
          throw new MaterialError('material_submission_unavailable', 'The selected local material could not be submitted.')
        }
      }) }
    },
    /**
     * Route one locally delivered read to the custodian, and hand back what it produced.
     *
     * This host contributes exactly two things and neither is authorization. It checks that the
     * destination the caller names is the one this profile is configured for — so a caller
     * cannot state a destination the operator never chose — and it carries the Gateway's ticket
     * to the process that holds both the bytes and the Connection the ticket was issued to.
     *
     * Everything that decides whether a byte may be read happens at the Gateway, per read, when
     * the custodian claims the ticket.
     */
    async deliver(body) {
      if (!configured) {
        throw new MaterialError('materials_not_configured', 'This Rulith profile holds no local material.')
      }
      const ticket = String(body?.ticket ?? '')
      if (ticket === '') {
        throw new MaterialError('local_ticket_missing',
          'A local read is completed from a delivery ticket the Gateway minted for it. There is no other way to ask.')
      }
      const identity = getIdentity()
      // Both sides of the owner binding, compared by the one process that holds both, before any
      // byte is asked for.
      //
      // The Connection side is checked by opening the area at all: an area belonging to another
      // Gateway or Connection refuses here. The Agent side is this: the identity came from the
      // running Agent's own authenticated MCP handshake, never from a model turn and never from
      // this request. A profile whose Agent has not yet confirmed one is refused rather than
      // served — an unconfirmed reader is not the same as an absent restriction, and the whole
      // question "whose files are these" is unanswerable until the Agent says who it is.
      const store = open()
      if (identity.agentId === '') {
        throw new MaterialError('material_identity_unconfirmed',
          'This Rulith profile has no confirmed Agent identity yet, so it does not yet know whose local material a read'
          + ' would be disclosing. Start the Agent and let it complete its authenticated session first.')
      }
      if (store.boundAgentId !== '' && store.boundAgentId !== identity.agentId) {
        throw new MaterialError('materials_store_owner_mismatch',
          'This material area belongs to a different Agent than the one this profile is now running.')
      }
      const asked = normalizeModelDestination(body?.modelDestination)
      if (asked === '' || asked !== identity.modelDestination) {
        throw new MaterialError('material_destination_mismatch',
          `This host is configured to send model content to ${JSON.stringify(identity.modelDestination)} and the caller`
          + ` states ${JSON.stringify(asked)}. A local read is refused rather than resolved in favour of either.`)
      }
      if (typeof custodian !== 'function') {
        throw new MaterialError('material_custodian_offline',
          'This Rulith host is not running the Worker that holds custody of local material, so no local read can be completed.')
      }
      const answer = await custodian({ ticket, modelDestination: asked })
      if (answer?.ok !== true) {
        throw new MaterialError(String(answer?.errorCode ?? 'material_local_read_failed'),
          String(answer?.teaching ?? 'The custodian did not complete this local read.'))
      }
      return { result: answer.result }
    },
    /** Retention records, for an operator asking what this profile is still holding. */
    retention() {
      return { retention: open().retention() }
    },
  }
}
