// The shipped browser script (client.js) loaded the way dsh's module loader loads it, in a vm, with a stand-in for React
// that keeps each mounted component's hook state in call order, as React does. Effects run only when a test asks, and
// timers fire on the next turn. No DOM, no network: `reply(request)` answers every /rulith/api request.
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = new URL('../../harness/web/rulith-dsh-ui/lib/client.js', import.meta.url);

export const flush = async (turns = 4) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve)); };
/** Every element node under `node`, itself included. */
export const nodes = (node, out = []) => {
  if (node && typeof node === 'object') { out.push(node); for (const child of node.children || []) nodes(child, out); }
  return out;
};
/** The text a node shows. */
export const text = (node) => (typeof node === 'string' ? node : (node && node.children || []).map(text).join(''));
/** Values made in the page's realm, as plain data. */
export const plain = (value) => JSON.parse(JSON.stringify(value));

export function loadPage({ reply = () => ({ ok: true }), windowExtra = {} } = {}) {
  let plugin, active = null;
  const requests = [], opened = [];
  const React = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false) }),
    useState: (initial) => active.state(initial),
    useRef: (value) => active.ref(value),
    useCallback: (fn) => fn,
    useEffect: (fn) => { active.effects.push(fn); },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  };
  const window = { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } },
    localStorage: { getItem: () => null, setItem() {} }, crypto: globalThis.crypto, addEventListener() {}, removeEventListener() {},
    open: (url) => { const tab = { url, closed: false, location: { href: '', replace(next) { tab.location.href = next; } }, close() { tab.closed = true; } }; opened.push(tab); return tab; },
    ...windowExtra };
  vm.runInNewContext(fs.readFileSync(SOURCE, 'utf8'), {
    window, console, URL, setTimeout: (fn) => { setImmediate(fn); return 0; }, setInterval: () => 0, clearInterval() {},
    fetch: async (url, init = {}) => {
      const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: { ...(init.headers || {}) } };
      requests.push(request);
      const answer = await reply(request);
      return { json: async () => answer };
    },
  });
  /** One mounted component: its hook cells survive renders; `render()` draws it again with the current state. */
  const mount = (component, props = {}) => {
    const m = { cells: [], refs: [], effects: [], cursor: 0, refCursor: 0, props,
      state(initial) {
        const i = m.cursor++;
        if (!(i in m.cells)) m.cells[i] = typeof initial === 'function' ? initial() : initial;
        return [m.cells[i], (next) => { m.cells[i] = typeof next === 'function' ? next(m.cells[i]) : next; }];
      },
      ref(value) { const i = m.refCursor++; if (!(i in m.refs)) m.refs[i] = { current: value }; return m.refs[i]; },
      render(next = m.props) {
        m.props = next; m.cursor = 0; m.refCursor = 0; m.effects = [];
        const previous = active; active = m;
        try { return component(next); } finally { active = previous; }
      },
      async runEffects() { for (const fn of m.effects.splice(0)) await fn(); await flush(); },
    };
    return m;
  };
  /** Draw nested function components too (each freshly mounted): for what a first render shows. */
  const expand = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.tag === 'function') return expand(mount(node.tag, node.props).render());
    return { ...node, children: node.children.map(expand) };
  };
  return { plugin, requests, opened, mount, expand, posted: (route) => requests.filter((r) => r.method === 'POST' && r.url === '/rulith/api/' + route) };
}
