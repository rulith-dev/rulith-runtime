// SPDX-License-Identifier: Apache-2.0
/**
 * The contract between the workbench and the conversation it embeds.
 *
 * These documents are different origins. Only a view-readiness receipt crosses between them;
 * neither reaches into the other's DOM or exchanges credentials or commands. Everything they agree on is
 * therefore in one query parameter and in what each of them does with it, which is exactly
 * the kind of agreement that breaks silently: rename it on one side and the child keeps
 * rendering its own rails inside the parent's, with two Agent lists and two Worker panels on
 * one screen and nothing raised anywhere.
 *
 * The conversation page itself is not re-implemented for embedding, and these arms are also
 * there to keep it that way: the same elements, moved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { localPage } from '../local/local-ui.mjs'
import { managerPage } from '../local/manager-ui.mjs'

const script = /<script>([\s\S]*?)<\/script>/.exec(localPage)[1]

test('both sides name the embedded presentation the same way', () => {
  assert.match(managerPage, /\+'embedded=1'/, 'the workbench asks for it in the address it loads')
  assert.match(localPage, /get\('embedded'\)==='1'/, 'the conversation page decides from its own address')
})

test('embedded, only the Agent list is repeated; the Case inspector is this page\'s own column', () => {
  // The workbench draws the Agents, so this page's sidebar would be a second list of them.
  // Its inspector is a different matter: the Cases in focus, the unresolved call, the
  // frontier and the Worker activity are read from the events *this conversation* is
  // receiving, and are the right-hand column of the workbench rather than a copy of it.
  assert.match(localPage, /\.app\.embedded \.sidebar\{display:none\}/)
  assert.match(localPage, /\.app\.embedded \.inspector\{display:block\}/,
    'the inspector is kept, not hidden and re-invented by the shell')
  assert.match(localPage, /\.app\.embedded\{display:grid;grid-template-columns:minmax\(0,1fr\) 330px\}/)
  assert.match(localPage, /\.app\.embedded \.composer\{left:0;right:330px\}/,
    'a composer that ignores the inspector column sits under it')
  assert.match(localPage, /@media\(max-width:900px\)\{\.app\.embedded\{grid-template-columns:minmax\(0,1fr\)\}\.app\.embedded \.inspector\{display:none\}\.app\.embedded \.composer\{right:0\}\}/,
    'it folds away only when the frame itself is too narrow to hold it')
  assert.match(localPage, /\.runtimecontrols\[hidden\]\{display:none\}/,
    'starting a role belongs to the workbench, which is where a person sees its state')
})

test('the conversation list and the Case evidence are moved, not rebuilt', () => {
  // Moving the live elements is what keeps switching conversations, starting a new one, the
  // Case roots, the frontier and the unresolved call working exactly as they do standalone.
  assert.match(script, /\$\('convbody'\)\.appendChild\(\$\('newcase'\)\)/)
  assert.match(script, /\$\('convbody'\)\.appendChild\(\$\('cases'\)\)/)
  // The evidence sections are captured once and moved between two hosts; they are never
  // duplicated, and the dialog is closed — returning focus — before they are moved back.
  assert.match(script, /evidenceSections\.push\(section\)/)
  assert.match(script, /const narrow=evidenceNarrow\(\),host=narrow\?\$\('evidencebody'\):\$\('inspector'\)/)
  assert.match(script, /const wasOpen=!narrow&&!\$\('evidencemodal'\)\.hidden/)
  assert.match(script, /if\(wasOpen\)closeModal\('evidencemodal'\)/, 'a dialog hidden by CSS leaves the page inert')
  assert.match(script, /if\(wasOpen&&\$\('inspector'\)\.focus\)\$\('inspector'\)\.focus\(\)/,
    'focus cannot be returned to a control that this width does not have')
  assert.match(script, /for\(const section of evidenceSections\)if\(section\.parentNode!==host\)host\.appendChild\(section\)/)
  assert.match(script, /\$\('evidenceopen'\)\.hidden=!narrow/,
    'a button that opens a dialog for panels already on screen is a button with nothing to do')
  assert.match(script, /query\.addEventListener\('change',\(\)=>syncEvidence\(\)\)/, 'a resize has to put them back')
  for (const id of ['convmodal', 'convbody', 'convclose', 'evidencemodal', 'evidencebody', 'evidenceclose', 'inspector'])
    assert.match(localPage, new RegExp(`id="${id}"`), `the embedded presentation lost #${id}`)
  for (const id of ['cases', 'newcase', 'roots', 'recovery', 'frontier', 'workers', 'composer', 'stream'])
    assert.match(localPage, new RegExp(`id="${id}"`), `the conversation page lost #${id}`)
})

test('the dialogs that hold them are dialogs, with names, a close and Escape', () => {
  for (const id of ['convmodal', 'evidencemodal']) {
    const markup = localPage.slice(localPage.indexOf(`id="${id}"`))
    assert.match(markup.slice(0, 200), /role="dialog" aria-modal="true" aria-labelledby="/)
  }
  assert.match(localPage, /aria-label="Close conversations"/)
  assert.match(localPage, /aria-label="Close Case evidence"/)
  // Add files is the fourth: a dialog that is reopened mid-turn has to be inert-backed,
  // Escape-closed and focus-restoring like the other three, which is what being in this list is.
  assert.match(script, /MODALS=\['runtimemodal','convmodal','evidencemodal','filesmodal'\]/)
  assert.match(script, /if\(event\.key!=='Escape'\)return;closeAttachMenu\(true\);for\(const id of MODALS\)closeModal\(id\)/)
  assert.match(script, /lastFocus=document\.activeElement/, 'a dialog gives focus back where it came from')
  assert.match(localPage, /class="ghost embedded-only" id="convopen"/, 'the centre is how they are reached')
  assert.match(localPage, /class="ghost" id="evidenceopen"/)
})

test('choosing a conversation closes the dialog it was chosen in', () => {
  assert.match(script, /render\(true\);if\(EMBEDDED\)closeModal\('convmodal'\)/)
  assert.match(script, /if\(EMBEDDED\)closeModal\('convmodal'\);\$\('prompt'\)\.focus\(\)/)
})

test('embedded, settings open beside the conversation rather than replacing it', () => {
  assert.match(script, /a\.sidelink'\)\)\{link\.target='_blank';link\.rel='noopener noreferrer'\}/,
    'navigating the frame to the setup page would take the conversation away')
  assert.match(script, /if\(MANAGER&&!EMBEDDED\)/,
    'a way back to the workbench, inside the workbench, would be the workbench inside itself')
})

test('the composer answers in the page, because a sandboxed frame has no browser dialog', () => {
  // allow-modals is deliberately absent from the frame the workbench creates, so alert()
  // inside this document returns without showing anything. Both failure paths of a send are
  // therefore rendered, not alerted.
  const code = script.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(code, /\balert\(/, 'a send that fails must not fail silently when embedded')
  assert.doesNotMatch(managerPage, /allow-modals/, 'the fix is the page answering, not the sandbox letting dialogs through')
  assert.match(script, /sayCompose\('Business key must be valid JSON\.'\)/)
  assert.match(script, /sayCompose\(r\?\.teaching\|\|'The message could not be submitted\./)
  assert.match(localPage, /id="composererr" role="alert"/, 'the answer is announced, not only drawn')
  assert.match(localPage, /\.composererr:empty\{display:none\}/)
})

test('embedded, the launcher address is not held at all', () => {
  // The workbench strips it before loading this page; dropping it here as well means a
  // hand-typed address cannot put the manager's own browser key back into this document,
  // nor into the tabs its settings links open.
  assert.match(script, /var MANAGER=EMBEDDED\?'':managerReturnHref\(location\.search\)/)
  assert.match(script, /LINKQ=\(path\)=>path\+'\?k='\+encodeURIComponent\(K\)\+\(MANAGER\?'&manager='/,
    'standalone still carries the way back to its sibling pages')
})

test('a dialog here makes the rest of the document inert and keeps Tab inside it', () => {
  assert.match(script, /\$\('app'\)\.inert=true/, 'aria-modal is a claim; inert is what makes it true')
  assert.match(script, /\$\('app'\)\.inert=MODALS\.some\(\(other\)=>!\$\(other\)\.hidden\)/)
  assert.match(script, /function trapTab\(event\)/)
  assert.match(script, /event\.preventDefault\(\);last\.focus\(\)/)
  assert.match(script, /event\.preventDefault\(\);first\.focus\(\)/)
})

test('the header wraps rather than pushing its last controls out of a column that never scrolls', () => {
  assert.match(localPage, /\.top\{flex-wrap:wrap;row-gap:6px;height:auto;min-height:58px\}/)
  assert.match(localPage, /\.app\.embedded \.top\{height:auto/)
})

test('readiness is a bounded receipt and never carries authority or reads the other DOM', () => {
  assert.match(localPage, /postMessage\(\{type:'rulith-ui-ready',view\},parentOrigin.origin\)/)
  assert.match(managerPage, /event.source!==entry.el.contentWindow/)
  assert.match(managerPage, /event.origin!==entry.origin/)
  assert.match(managerPage, /event.data.view!==entry.view/)
  for (const page of [localPage, managerPage])
    assert.doesNotMatch(page, /contentDocument|contentWindow\.document/)
})

test('the embedded conversation keeps every behaviour it has on its own', () => {
  // These are the parts a person would notice missing: the composer, the Case preferences it
  // carries, the Trace view, tool disclosure, Markdown, the session log and Runtime details.
  for (const marker of ['id="composer"', 'id="casepopover"', 'data-view="trace"', 'renderMarkdown',
    'renderToolCall', 'id="exportlog"', 'id="runtimemodal"', 'projectCaseRoots', 'projectRecovery'])
    assert.ok(localPage.includes(marker), `the embedded conversation lost ${marker}`)
  assert.doesNotMatch(script, /EMBEDDED\s*\?\s*fetch|if\(EMBEDDED\)\s*return/,
    'embedding changes presentation only; no route and no behaviour may depend on it')
})
