// SPDX-License-Identifier: Apache-2.0
/**
 * Run a Rulith page's browser script in Node, against the smallest document that its own
 * code actually touches.
 *
 * These pages are plain scripts inside a template string, so their logic — which section is
 * shown, which button is disabled, what is escaped before it becomes markup — is otherwise
 * only exercised by a person looking at a browser. That is exactly the kind of check that
 * quietly stops happening, and a typo in an element id fails silently in a browser too: the
 * handler is simply never attached.
 *
 * This is not a browser and does not pretend to be one. There is no layout, no CSS, no
 * parsing of markup a script assigns, and no event dispatch beyond calling a handler the
 * script registered. What it gives is the part that can be wrong without anybody noticing:
 * ids that do not exist, markup built from unescaped values, state that shows two sections at
 * once, a control enabled when the state says it cannot be used, and a button that calls the
 * wrong route.
 */

/** The element ids the markup declares. */
export const declaredIds = (html) => [...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1])
/** The element ids the script asks for. */
export const referencedIds = (html) => [...html.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1])
/**
 * Which of them the markup ships hidden.
 *
 * A dialog that is closed until something opens it is closed in the markup and nowhere else,
 * so a document that starts every element visible would let "this dialog is not open" pass
 * without anything having closed it.
 */
const hiddenIds = (html) => new Set([...html.matchAll(/<[a-zA-Z]+[^>]*\bid="([^"]+)"[^>]*>/g)]
  .filter((match) => /\shidden(?=[\s>])/.test(match[0])).map((match) => match[1]))

/**
 * The names a test may reach for, if the page happens to define them.
 *
 * A page defines the handful it needs and nothing more, so each is read through `typeof`
 * rather than named directly: a page without `instanceCard` must still load.
 */
const EXPORTED = ['render', 'api', 'act', 'run', 'instanceCard', 'agentOptions', 'choose',
  'controlSpec', 'applyControls', 'statusOf', 'openDialog', 'closeDialog', 'frames', 'busy', 'say']

const DECODE = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
/**
 * The `<option>` elements an assigned `innerHTML` would have produced.
 *
 * A page that restores a selection has to compare against the *values* the document holds,
 * not against the markup they were escaped into, so the shim has to decode the same way a
 * parser does or the test would agree with the bug.
 */
const parseOptions = (html) => [...String(html ?? '').matchAll(/<option value="([^"]*)"([^>]*)>/g)]
  .map((match) => ({
    value: match[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => DECODE[name]),
    disabled: /\sdisabled(?=[\s>])/.test(match[2] + '>'),
  }))

function element(id, doc) {
  return {
    id,
    tagName: '',
    inert: false,
    get options() { return parseOptions(this.innerHTML) },
    hidden: false,
    textContent: '',
    innerHTML: '',
    className: '',
    href: '',
    src: '',
    value: '',
    checked: false,
    disabled: false,
    onclick: null,
    dataset: {},
    listeners: {},
    attributes: {},
    children: [],
    parentNode: null,
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    getClientRects() { return this.hidden ? [] : [{ width: 10, height: 10 }] },
    setAttribute(name, value) { this.attributes[name] = value },
    removeAttribute(name) { delete this.attributes[name]; if (name === 'href') this.href = '' },
    getAttribute(name) { return this.attributes[name] },
    focus() { doc.activeElement = this },
    appendChild(node) { this.children.push(node); node.parentNode = this; return node },
    removeChild(node) { this.children = this.children.filter((child) => child !== node) },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); this.parentNode = null },
    querySelector() { return null },
    querySelectorAll() { return [] },
    closest() { return null },
  }
}

/**
 * @param {string} html   The whole page, exactly as the server sends it.
 * @param {object} options
 * @param {(path: string, init: object) => Promise<object>} options.respond
 *   Answers the page's `fetch`; receives the path and the request it made.
 */
export async function runPageScript(html, { search = '?k=page-test-key', respond, openWindow } = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (script === undefined) throw new Error('The page has no script to run.')
  /** Every request the page made: { path, method, body }. */
  const calls = []
  /** Timer callbacks the page scheduled; never run, so a poll loop cannot leak into a test. */
  const timers = []
  const opened = []
  /** Elements the script created itself — the embedded workspace frames, in practice. */
  const created = []

  const document = {
    hidden: false,
    activeElement: null,
    listeners: {},
    getElementById: (id) => elements.get(id),
    createElement(tag) {
      const node = element('', document)
      node.tagName = String(tag).toUpperCase()
      created.push(node)
      return node
    },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  const hidden = hiddenIds(html)
  const elements = new Map(declaredIds(html).map((id) => {
    const node = element(id, document)
    node.hidden = hidden.has(id)
    return [id, node]
  }))
  const fetchImpl = async (path, init = {}) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body)
    calls.push({ path, method: init.method ?? 'GET', body, headers: init.headers ?? {} })
    const answer = await respond(path, { method: init.method ?? 'GET', body, signal: init.signal })
    return {
      ok: answer.status === undefined || answer.status < 400,
      status: answer.status ?? 200,
      json: async () => answer.body ?? {},
    }
  }
  /** The one media query the shell asks about, and a way for a test to answer it. */
  const media = { narrow: false, listeners: [] }
  const setNarrow = (value) => {
    media.narrow = value === true
    for (const handler of media.listeners) handler({ matches: media.narrow })
  }
  const windowStub = {
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    listeners: {},
    open: (url, target) => {
      const tab = { url, target, closed: false, opener: {},
        location: { replace(value) { tab.url = value } }, close() { tab.closed = true } }
      opened.push(tab)
      return openWindow ? openWindow(tab) : tab
    },
    matchMedia: () => ({
      get matches() { return media.narrow },
      addEventListener: (type, handler) => media.listeners.push(handler),
      addListener: (handler) => media.listeners.push(handler),
    }),
  }
  const exported = EXPORTED.map((name) => `${name}:(typeof ${name}==='undefined'?undefined:${name})`).join(',')
  const run = new Function('document', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'window', 'console',
    `${script}\nreturn {${exported}, state: () => (typeof state==='undefined'?undefined:state)};`)
  const page = run(
    document,
    { search, origin: 'http://127.0.0.1:9000' },
    fetchImpl,
    (callback, ms) => { timers.push({ callback, ms }); return timers.length },
    () => {},
    windowStub,
    { log() {}, error() {} },
  )
  // The page's last statement loads state; let it settle before a test inspects anything.
  await new Promise((done) => setImmediate(done))
  await new Promise((done) => setImmediate(done))
  /** Hand a keyboard event to whatever the page registered for it. */
  const press = (key) => {
    for (const handler of document.listeners.keydown ?? []) handler({ key, preventDefault() {} })
  }
  const message = (event) => { for (const handler of windowStub.listeners.message ?? []) handler(event) }
  return { ...page, elements, calls, timers, opened, created, document, press, setNarrow, message, $: (id) => elements.get(id) }
}
