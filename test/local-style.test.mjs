// SPDX-License-Identifier: Apache-2.0
/**
 * What the Local browser pages are allowed to look like, and what a return link may be.
 *
 * Two different failures are guarded here. The first is drift: four pages each carrying
 * their own palette is how "Local looks like Console" quietly stops being true one page at
 * a time, so every page must take its colours from the one shared sheet and none may keep
 * a retired literal. The second is the return link. Its address is supplied by whoever
 * launched the page, which in the general case means it is attacker-controlled input being
 * written into an href — the arms below are the specific ways that goes wrong.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { localThemeCss, managerReturnHref } from '../local/theme.mjs'
import { localPage } from '../local/local-ui.mjs'
import { setupPage } from '../local/setup-ui.mjs'
import { workerToolsPage } from '../local/worker-tools-ui.mjs'
import { attachRegistryBrowser } from '../local/mcp-registry-ui.mjs'

const PAGES = [['local', localPage], ['setup', setupPage], ['worker tools', workerToolsPage]]

test('every Local page takes its palette from the one shared sheet', () => {
  for (const [name, page] of PAGES) {
    assert.ok(page.includes(localThemeCss), `${name} must inline the shared theme, not restate a palette`)
    const styles = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    assert.equal(styles.length, 1, `${name} must carry exactly one stylesheet`)
    // Page-specific CSS follows the shared sheet, so its rules win where they disagree.
    const own = styles[0][1].slice(styles[0][1].indexOf(localThemeCss) + localThemeCss.length)
    assert.ok(own.trim().length > 0, `${name} must keep its own geometry after the shared tokens`)
  }
})

test('the retired blue-black and teal surfaces are gone from every page', () => {
  // The exact literals the Local pages used before the Console palette. Teal survives only
  // as --brand, declared once in the shared sheet and used for the RULITH mark.
  const retired = /#(?:48d7c2|2dc8b6|37cbbc|0d0f12|0b1017|111317|15181d|1b1f25|292e36|8eb6ff|4fd19b|e5ad55|ef7d7d|e3eaf2|a0b0c4|3a4049|20242b|2b3543|101722|445064|182334|0e1115|20262f|0d1117|252a31|272b31|202329|353a43|22262d|17202c|081413|071b18|061512|04110e)\b/i
  for (const [name, page] of PAGES) {
    const css = /<style>([\s\S]*?)<\/style>/.exec(page)[1]
    assert.doesNotMatch(css, retired, `${name} still carries a retired colour literal`)
    assert.equal((css.match(/#35d0ba/g) || []).length, 1, `${name} must reach the brand teal through --brand only`)
    assert.match(css, /--accent:#5c9cf5/)
    assert.match(css, /--btn-fg:#f2f2f2/)
  }
  assert.doesNotMatch(attachRegistryBrowser.toString(), /#[0-9a-f]{6}/i,
    'the directory browser must style through classes, not inline colour')
})

test('each page keeps the ids its controller and its routes depend on', () => {
  for (const id of ['stream', 'composer', 'cases', 'sidefoot', 'runtimemsg', 'runtimeopen', 'casepopover'])
    assert.match(localPage, new RegExp(`id="${id}"`), `local page lost #${id}`)
  for (const id of ['home', 'tools-link', 'chat-link', 'headerlinks', 'notice', 'pair', 'resources', 'run'])
    assert.match(setupPage, new RegExp(`id="${id}"`), `setup page lost #${id}`)
  for (const id of ['back', 'headerlinks', 'result', 'tool-rows', 'registry-results', 'registry-prepare'])
    assert.match(workerToolsPage, new RegExp(`id="${id}"`), `worker tools page lost #${id}`)
  // worker-tools-browser.mjs reads the checkbox as the row's first input; a decorative
  // input added ahead of it would silently save the wrong tool selection.
  assert.match(workerToolsPage, /<th><\/th><th>Tool and inputs<\/th>/)
})

test('a page only offers a way back when a launcher supplied one, and never invents a port', () => {
  for (const [name, page] of PAGES) {
    assert.ok(page.includes(managerReturnHref.toString()),
      `${name} must decide the return link with the shared, tested rule`)
    assert.match(page, /Back to agents/, `${name} must name the return destination`)
    // The link's address comes from the validated value and nowhere else. The pages do
    // carry loopback strings — an example model endpoint, an example MCP endpoint — but
    // those are placeholder text in an input, never a destination a page navigates to.
    assert.match(page, /\.href\s*=\s*(manager|MANAGER)\b/,
      `${name} must take the return address from the validated launcher value`)
    assert.doesNotMatch(page, /\.href\s*=\s*['"]https?:\/\/(?:127\.|localhost|\[::1\])/i,
      `${name} must not hard-code a manager address`)
  }
})

test('a return address is a loopback manager root with only its own browser capability', () => {
  const href = (value) => managerReturnHref('?k=local-key&manager=' + encodeURIComponent(value))
  assert.equal(href('http://127.0.0.1:7391/'), 'http://127.0.0.1:7391/')
  assert.equal(href('http://localhost:9000'), 'http://localhost:9000/')
  assert.equal(href('https://127.0.0.1:8443/'), 'https://127.0.0.1:8443/')
  assert.equal(href('http://[::1]:7391/'), 'http://[::1]:7391/')
  assert.equal(href('http://127.8.9.10:1/'), 'http://127.8.9.10:1/')

  assert.equal(href('http://127.0.0.1:7391/?key=SECRET#tab'), 'http://127.0.0.1:7391/')
  assert.equal(href('http://127.0.0.1:7391/?k=manager-access-1234&secret=drop#tab'), 'http://127.0.0.1:7391/?k=manager-access-1234')

  for (const rejected of [
    'javascript:alert(1)',                 // an href is an execution surface
    'data:text/html,<script>x</script>',
    'file:///C:/Windows/System32',
    'http://evil.example/agents',          // a return link is not a redirector
    'http://localhost.evil.example/',
    'http://127.0.0.1.evil.example/',
    'http://10.0.0.5:7391/',
    'http://user:pw@127.0.0.1:7391/',      // credential material in a visible link
    'http://127.0.0.1:7391/control',       // return navigation is not an operation
    'http://127.0.0.1:7391/?k=short',
    'http://127.0.0.1:7391/?k=manager-access-1234&k=manager-access-5678',
    '//127.0.0.1:7391/agents',             // no base: not a URL at all
    'not a url',
    '',
  ]) assert.equal(href(rejected), '', `${rejected || '(empty)'} must not become a link`)

  assert.equal(managerReturnHref(''), '')
  assert.equal(managerReturnHref(undefined), '')
  assert.equal(managerReturnHref('?k=local-key'), '', 'a page opened on its own has nowhere to return to')
})

test('the local key never rides along on the return link', () => {
  const search = '?k=abcdef0123456789&manager=' + encodeURIComponent('http://127.0.0.1:7391/?k=manager-access-1234&key=SECRET')
  const result = managerReturnHref(search)
  assert.doesNotMatch(result, /abcdef0123456789/)
  assert.doesNotMatch(result, /SECRET/)
})

test('the conversation and the tool tables keep their own width', () => {
  // Narrowing these to fit a phone is how a reader loses the columns they came to compare;
  // the shared sheet scrolls a table inside its container instead.
  assert.match(localPage, /\.composebox\{position:relative;width:min\(790px,100%\)/)
  assert.match(localPage, /\.stream\{[^}]*calc\(\(100% - 790px\)\/2\)/)
  assert.match(workerToolsPage, /table\{min-width:660px\}/)
  assert.match(localThemeCss, /\.table\{overflow:auto/)
  // A header that cannot shrink drags the whole shell wider than the window, and the shell
  // never scrolls sideways — the conversation just gets cut off at the right edge.
  assert.match(localPage, /\.top>div\{min-width:0\}/)
})
