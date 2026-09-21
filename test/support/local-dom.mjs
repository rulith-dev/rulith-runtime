// SPDX-License-Identifier: Apache-2.0
/**
 * The conversation page's own script, running against a document with a real shape.
 *
 * `mini-dom.mjs` gives the manager page a flat bag of elements by id, which is all that page's
 * logic needs. The composer is different: adding a file is a chain of things that only mean
 * anything in a tree — a menu closes because the click landed outside it, a chip disappears
 * because its own remove button was pressed, focus lands somewhere a keyboard can continue
 * from. A flat bag would let all three pass while none of them worked.
 *
 * So this parses the page's markup into nodes with parents, children, classes and attributes,
 * runs the shipped script against it, and dispatches events the way a browser does: the node's
 * own handler, then every ancestor, then the document. It is still not a browser — no layout,
 * no CSS, no navigation — and the browser-only arms live in `test/browser/` where a browser
 * decides them. What it checks is the part that is invisible until someone opens the page:
 * which handler ran, what the page then sent, and what it left on screen.
 */

/** Elements that have no closing tag, so the parser must not nest what follows inside them. */
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const DECODE = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }
const decode = (value) => String(value).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => DECODE[name])
const ATTRIBUTE = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttributes(text) {
  const found = {}
  for (const match of String(text ?? '').matchAll(ATTRIBUTE)) {
    found[match[1]] = decode(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return found
}

/** One compound selector: `tag`, `.class`, `#id`, `[attr]`, `[attr="value"]`, or a run of them. */
function matchesCompound(node, compound) {
  for (const part of compound.match(/[.#]?[\w-]+|\[[^\]]+\]/g) ?? []) {
    if (part.startsWith('.')) { if (!node.classList.contains(part.slice(1))) return false }
    else if (part.startsWith('#')) { if (node.id !== part.slice(1)) return false }
    else if (part.startsWith('[')) {
      const [, name, value] = /\[([\w-]+)(?:[~|^$*]?=["']?([^\]"']*)["']?)?\]/.exec(part) ?? []
      if (name === undefined) return false
      const held = node.getAttribute(name)
      if (held === undefined || held === null) return false
      if (value !== undefined && held !== value) return false
    } else if (node.tagName !== part.toUpperCase()) return false
  }
  return true
}

/** `a b c`: the node matches `c`, and has ancestors matching `b` then `a`, in order. */
function matchesSelector(node, selector) {
  const parts = String(selector).trim().split(/\s+/)
  if (!matchesCompound(node, parts[parts.length - 1])) return false
  let at = parts.length - 2, parent = node.parentNode
  while (at >= 0) {
    if (!parent) return false
    if (parent.tagName !== undefined && matchesCompound(parent, parts[at])) at -= 1
    parent = parent.parentNode
  }
  return true
}

function createNode(tag, doc) {
  const node = {
    tagName: String(tag).toUpperCase(),
    attributes: {},
    dataset: {},
    children: [],
    parentNode: null,
    listeners: {},
    onclick: null,
    text: '',
    raw: null,
    inert: false,
    disabled: false,
    checked: false,
    files: [],
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,

    get id() { return this.attributes.id ?? '' },
    get className() { return this.attributes.class ?? '' },
    set className(value) { this.attributes.class = String(value) },
    get hidden() { return this.attributes.hidden !== undefined },
    set hidden(value) { if (value) this.attributes.hidden = ''; else delete this.attributes.hidden },
    get type() { return this.attributes.type ?? '' },
    set type(value) { this.attributes.type = String(value) },
    get value() { return this.attributes.value ?? '' },
    set value(next) { this.attributes.value = String(next) },
    get classList() {
      const node = this
      const held = () => String(node.attributes.class ?? '').split(/\s+/).filter(Boolean)
      const write = (list) => { node.attributes.class = [...new Set(list)].join(' ') }
      return {
        contains: (name) => held().includes(name),
        add: (name) => write([...held(), name]),
        remove: (name) => write(held().filter((entry) => entry !== name)),
        toggle: (name, force) => (force === undefined ? !held().includes(name) : force === true)
          ? write([...held(), name]) : write(held().filter((entry) => entry !== name)),
      }
    },

    get textContent() {
      return this.children.length === 0 ? this.text
        : this.text + this.children.map((child) => child.textContent ?? '').join('')
    },
    set textContent(value) {
      for (const child of this.children) child.parentNode = null
      this.children = []; this.raw = null; this.text = String(value ?? '')
    },
    get innerHTML() { return this.raw ?? this.children.map((child) => child.outerHTML).join('') },
    /** Assigning markup replaces the children with the nodes that markup describes. */
    set innerHTML(value) {
      for (const child of this.children) child.parentNode = null
      this.children = []; this.text = ''; this.raw = String(value ?? '')
      for (const child of parseMarkup(this.raw, doc)) this.appendChild(child, true)
    },
    get outerHTML() {
      const attributes = Object.entries(this.attributes)
        .map(([name, held]) => held === '' ? ' ' + name : ' ' + name + '="' + held + '"').join('')
      const open = '<' + this.tagName.toLowerCase() + attributes + '>'
      if (VOID.has(this.tagName.toLowerCase())) return open
      return open + this.text + this.children.map((child) => child.outerHTML).join('') + '</' + this.tagName.toLowerCase() + '>'
    },

    setAttribute(name, held) {
      this.attributes[name] = String(held)
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = String(held)
    },
    getAttribute(name) { return this.attributes[name] ?? null },
    removeAttribute(name) { delete this.attributes[name] },
    focus() { doc.activeElement = this },
    blur() { if (doc.activeElement === this) doc.activeElement = null },
    click() { doc.dispatch(this, 'click', { target: this }) },
    getClientRects() { return this.hidden ? [] : [{ width: 10, height: 10 }] },
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    removeEventListener(type, handler) { this.listeners[type] = (this.listeners[type] ?? []).filter((entry) => entry !== handler) },
    appendChild(child, keepRaw = false) {
      if (child.parentNode) child.parentNode.removeChild(child)
      child.parentNode = this; this.children.push(child)
      if (!keepRaw) this.raw = null
      doc.register(child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((entry) => entry !== child)
      child.parentNode = null; this.raw = null
      return child
    },
    replaceChildren(...next) {
      for (const child of this.children) child.parentNode = null
      this.children = []; this.text = ''; this.raw = null
      for (const child of next) this.appendChild(child)
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    insert(node, offset) {
      if (!this.parentNode) return node
      const at = this.parentNode.children.indexOf(this)
      if (node.parentNode) node.parentNode.removeChild(node)
      this.parentNode.children.splice(at + offset, 0, node)
      node.parentNode = this.parentNode; this.parentNode.raw = null
      doc.register(node)
      return node
    },
    after(node) { return this.insert(node, 1) },
    before(node) { return this.insert(node, 0) },
    prepend(node) { this.children.unshift(node); node.parentNode = this; this.raw = null; doc.register(node); return node },
    contains(node) {
      for (let walk = node; walk; walk = walk.parentNode) if (walk === this) return true
      return false
    },
    closest(selector) {
      for (let walk = this; walk; walk = walk.parentNode) if (walk.tagName !== undefined && matchesSelector(walk, selector)) return walk
      return null
    },
    descendants() {
      const found = []
      const walk = (node) => { for (const child of node.children) { found.push(child); walk(child) } }
      walk(this)
      return found
    },
    querySelectorAll(selector) { return this.descendants().filter((node) => matchesSelector(node, selector)) },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null },
    cloneNode() {
      const copy = createNode(this.tagName, doc)
      copy.attributes = { ...this.attributes }; copy.dataset = { ...this.dataset }; copy.text = this.text
      for (const child of this.children) copy.appendChild(child.cloneNode(true))
      return copy
    },
  }
  return node
}

/** Markup in, nodes out. Text is kept; comments and anything self-describing are not needed. */
function parseMarkup(source, doc) {
  const html = String(source ?? '')
  const roots = []
  const open = []
  const host = () => open.length ? open[open.length - 1] : null
  const add = (node) => { const parent = host(); if (parent) parent.appendChild(node, true); else roots.push(node) }
  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g
  let at = 0
  for (const match of html.matchAll(TAG)) {
    const before = html.slice(at, match.index)
    if (before) { const parent = host(); if (parent) parent.text += before }
    at = match.index + match[0].length
    const [, closing, tag, attributes, selfClosed] = match
    if (closing) {
      for (let depth = open.length - 1; depth >= 0; depth -= 1) {
        if (open[depth].tagName === tag.toUpperCase()) { open.length = depth; break }
      }
      continue
    }
    const node = createNode(tag, doc)
    for (const [name, held] of Object.entries(parseAttributes(attributes))) node.setAttribute(name, held)
    add(node)
    if (!VOID.has(tag.toLowerCase()) && !selfClosed) open.push(node)
  }
  const tail = html.slice(at)
  if (tail && host()) host().text += tail
  return roots
}

/** A file the page can read, shaped as the browser's File is where the page touches it. */
export function fileOf(name, { type = 'text/plain', bytes = 'hello', size } = {}) {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  return { name, type, size: size ?? data.byteLength, arrayBuffer: async () => data.buffer ?? data }
}

/** A promise a test settles by hand, for the arms about what happens while a request is open. */
export function deferred() {
  let settle = null
  const promise = new Promise((accept) => { settle = accept })
  return { promise, resolve: (value) => settle(value) }
}

const STATUS = {
  ok: true, mode: 'agent', roles: ['agent'], agent: true, worker: false,
  runtime: {
    configFile: 'D:/local/rulith-local.json',
    agent: { id: 'agent-alpha', credentialConfigured: true, modelService: 'http://127.0.0.1:8080/v1', model: 'test-model', modelKeyConfigured: true, thinking: 'standard' },
    worker: { connection: '', credentialConfigured: false, workspaceTools: 'read', toolsFile: '', sourcesFile: '' },
  },
}

/**
 * @param {string} html  The whole page, exactly as the server sends it.
 * @param {object} options
 * @param {(path: string, request: object) => Promise<object>|object} [options.respond]
 *   Answers the page's `fetch`; receives the path and `{method, body}`. Return
 *   `{status?, body}`; `/status` is answered for you unless you answer it yourself.
 */
export async function loadLocalPage(html, { search = '?k=page-test-key', respond } = {}) {
  const byId = new Map()
  const calls = []
  const timers = []
  const streams = []

  const doc = {
    activeElement: null,
    listeners: {},
    register(node) { if (node.id && !byId.has(node.id)) byId.set(node.id, node) },
    getElementById: (id) => byId.get(id) ?? undefined,
    createElement: (tag) => createNode(tag, doc),
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    querySelector: (selector) => root.querySelector(selector),
    /** The node's own handler, then every ancestor's, then the document's. */
    dispatch(node, type, event = {}) {
      const full = { type, target: node, preventDefault() {}, stopPropagation() {}, ...event }
      for (let walk = node; walk; walk = walk.parentNode) {
        if (typeof walk['on' + type] === 'function') walk['on' + type](full)
        for (const handler of walk.listeners?.[type] ?? []) handler(full)
      }
      for (const handler of doc.listeners[type] ?? []) handler(full)
      return full
    },
  }
  const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script>'))
  const root = createNode('body', doc)
  for (const node of parseMarkup(body, doc)) root.appendChild(node, true)
  for (const node of [root, ...root.descendants()]) doc.register(node)

  const answer = async (path, request) => {
    const given = respond ? await respond(path, request) : undefined
    if (given !== undefined) return given
    if (path.startsWith('/status')) return { body: STATUS }
    return { status: 404, body: { ok: false, teaching: 'Not in this fixture: ' + path } }
  }
  const fetchImpl = async (path, init = {}) => {
    const request = { method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers ?? {} }
    calls.push({ path, ...request })
    const given = await answer(path, request)
    return { ok: (given.status ?? 200) < 400, status: given.status ?? 200, json: async () => given.body ?? {} }
  }
  const media = { narrow: false, listeners: [] }
  const windowStub = {
    listeners: {},
    innerWidth: 1400,
    addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler) },
    matchMedia: () => ({
      get matches() { return media.narrow },
      addEventListener: (type, handler) => media.listeners.push(handler),
      addListener: (handler) => media.listeners.push(handler),
    }),
  }
  /** The page opens one; a test pushes events into it the way the host's stream does. */
  class EventSourceStub {
    constructor(url) { this.url = url; this.onmessage = null; streams.push(this) }
  }

  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  if (script === undefined) throw new Error('The page has no script to run.')
  const exported = ['state', 'drafts', 'renderAttachments', 'addFiles'].map((name) => `${name}:(typeof ${name}==='undefined'?undefined:${name})`).join(',')
  const run = new Function('document', 'location', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'window', 'console', 'EventSource',
    `${script}\nreturn {${exported}};`)
  const page = run(
    doc,
    { search, origin: 'http://127.0.0.1:9000', reload() {} },
    fetchImpl,
    (callback, ms) => { timers.push({ callback, ms }); return timers.length },
    () => {},
    (callback, ms) => { timers.push({ callback, ms, repeating: true }); return timers.length },
    windowStub,
    { log() {}, error() {} },
    EventSourceStub,
  )

  const flush = async () => { for (let turn = 0; turn < 6; turn += 1) await new Promise((done) => setImmediate(done)) }
  await flush()

  const nodeOf = (target) => typeof target === 'string' ? (byId.get(target) ?? root.querySelector(target)) : target
  const api = {
    ...page,
    root,
    document: doc,
    calls,
    timers,
    $: (id) => byId.get(id),
    find: (selector) => root.querySelector(selector),
    all: (selector) => root.querySelectorAll(selector),
    activeId: () => doc.activeElement?.id ?? '',
    flush,
    /** Click something the way a person does: its handler, its ancestors', the document's. */
    click: async (target, event) => { doc.dispatch(nodeOf(target), 'click', event); await flush() },
    /** A key the page listens for on the document (Escape, Tab, Enter in the composer). */
    press: async (key, extra = {}) => { doc.dispatch(nodeOf(extra.on ?? 'app'), 'keydown', { key, shiftKey: false, ...extra }); await flush() },
    type: async (text) => { byId.get('prompt').value = text; doc.dispatch(byId.get('prompt'), 'input', {}); await flush() },
    submit: async () => { doc.dispatch(byId.get('composer'), 'submit', {}); await flush() },
    /** The file picker: what the input carries, then the change the browser raises. */
    choose: async (files) => { byId.get('fileinput').files = files; doc.dispatch(byId.get('fileinput'), 'change', {}); await flush() },
    dropOn: async (target, files) => { doc.dispatch(nodeOf(target), 'drop', { dataTransfer: { files } }); await flush() },
    dragOver: async (target) => { doc.dispatch(nodeOf(target), 'dragover', { dataTransfer: { files: [] } }); await flush() },
    /** What the host's event stream sends, as the page receives it. */
    emit: async (event) => { for (const stream of streams) stream.onmessage?.({ data: JSON.stringify(event) }); await flush() },
    /** The filename and status of every chip on screen, in order, per host. */
    chips: (id = 'attachlist') => byId.get(id).querySelectorAll('.chip').map((chip) => ({
      name: chip.querySelector('.chip-name').textContent,
      said: chip.querySelector('.chip-state').textContent,
      remove: chip.querySelector('.chip-drop'),
    })),
  }
  return api
}
