// The app's name and icon on the page dsh serves (design §3.2 页面标题、图标; D-1019b: the app is named Rulith). dsh's web
// frontend ships its own index.html with the title "DeepSeek Harness", DeepSeek's whale as the icon and a manifest of the
// same name; the host rewrites those three lines of every index response (dsh's webserver `tapIndex`) and serves Rulith's
// icon and manifest itself. The browser half keeps the tab title Rulith's while dsh's layout changes it (client.js).
// 中文说明：页面标题、图标与应用清单换成 Rulith 的；只改这三处，dsh 的页面其余不动。

export const TITLE = 'Rulith';
export const ICON_PATH = '/rulith/icon.svg';
export const MANIFEST_PATH = '/rulith/manifest.webmanifest';
// Rulith's mark, as Console's favicon draws it.
export const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#172f2b"/>'
  + '<path d="M9 7h8c5 0 7 2 7 6 0 3-1 5-4 6l5 7h-6l-5-7h-1v7H9zm4 4v4h4c2 0 3-1 3-2s-1-2-3-2z" fill="#d5f0df"/></svg>';
// Relative addresses in a manifest resolve against the manifest's own address, so these are absolute paths of the page.
export const MANIFEST = JSON.stringify({ name: TITLE, short_name: TITLE, start_url: '/', scope: '/', display: 'standalone',
  icons: [{ src: ICON_PATH, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });

/**
 * One index response with Rulith's title, icon and manifest: every `<title>`, every icon `<link>` (dsh's light and dark
 * favicons become one) and the manifest `<link>`. Nothing else of the page changes. Pure.
 */
export function brandIndex(html) {
  let iconDone = false;
  return String(html)
    .replace(/<title>[^<]*<\/title>/gi, `<title>${TITLE}</title>`)
    .replace(/<link\b[^>]*\brel=["'](?:shortcut )?icon["'][^>]*>/gi, () => {
      if (iconDone) return '';
      iconDone = true;
      return `<link rel="icon" type="image/svg+xml" href=".${ICON_PATH}">`;
    })
    .replace(/<link\b[^>]*\brel=["']manifest["'][^>]*>/gi, `<link rel="manifest" href=".${MANIFEST_PATH}">`);
}

/** Install the index rewrite and the two routes on dsh's web server; returns nothing (each part is a ctx effect). */
export function installBrand(ctx) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.tapIndex !== 'function') return;
  ctx.effect(() => webServer.tapIndex(brandIndex));
  const serve = (type, body) => async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  ctx.effect(() => webServer.register({ kind: 'exact', path: ICON_PATH, handler: serve('image/svg+xml', ICON_SVG) }));
  ctx.effect(() => webServer.register({ kind: 'exact', path: MANIFEST_PATH, handler: serve('application/manifest+json', MANIFEST) }));
}
