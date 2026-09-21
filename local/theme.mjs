// SPDX-License-Identifier: Apache-2.0
/** UI readiness only: no credentials, business data or commands cross this boundary. */
export const workbenchReadyScript = String.raw`
if(window.parent!==window){
  const params=new URLSearchParams(location.search),target=params.get('parentOrigin'),view=params.get('view');
  try{const parentOrigin=new URL(target);
    if(parentOrigin.origin===target&&parentOrigin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parentOrigin.hostname)&&/^[0-9]+$/.test(view||''))
      window.parent.postMessage({type:'rulith-ui-ready',view},parentOrigin.origin);
  }catch{}
}
`
/**
 * The presentation every Rulith Local browser page shares.
 *
 * Local used to carry its own palette — a blue-black page with teal as the dominant accent
 * — while Console moved to a neutral charcoal scale with blue for anything navigable and a
 * light primary button. Two products that a person moves between in one task should not
 * disagree about what "this is the main action here" looks like, so the Console decision is
 * restated here rather than re-invented: neutral charcoal surfaces, blue links and focus,
 * light primary buttons, subtle borders, generous whitespace, and the brand teal reserved
 * for the RULITH mark alone. The values and their measured contrast are recorded in
 * `rulith-java/docs/console-theme.md`; this file is the Local-side copy, not a second
 * decision. Geometry stays each page's own business: this sheet only supplies tokens and
 * the small component vocabulary (`.btn`, `.card`, `.txt`, `.pill`, tables, code) that the
 * pages already needed in four slightly different dialects.
 *
 * It is a plain string so any page — including a manager page that does not exist in this
 * package — can inline it into a `<style>` element with no build step and no network fetch.
 */
export const localThemeCss = String.raw`
:root{
  color-scheme:dark;
  /* Four text levels, as Console: page title, section title, body, supporting text. */
  --fs-1:18px;--fs-2:15px;--fs-3:14px;--fs-4:12.5px;
  /* Neutral charcoal scale. The page is darkest, a side rail sits just above it, cards are
     mid grey, and panel2 is the raised/hover surface. --field is darker than a card so an
     input or a verbatim block reads as "enterable" or "as received". */
  --bg:#151515;--side:#1c1c1c;--panel:#242424;--panel2:#2e2e2e;--field:#1a1a1a;
  --line:#313131;--line2:#414141;
  --fg:#ededed;--dim:#a9a9a9;--faint:#999999;
  /* Blue carries "navigable or informational": links, selection, focus rings. */
  --accent:#5c9cf5;--accent-d:#4a86dd;
  /* Teal is the RULITH mark and nothing else. */
  --brand:#35d0ba;
  /* Light surface + dark ink is "the primary action of this area". */
  --btn-fg:#f2f2f2;--btn-ink:#171717;
  /* Semantic colours assist a written status; they never carry it alone. */
  --green:#4fd18e;--amber:#edb642;--red:#f77b86;
  --radius:10px;
  --content-width:1240px;--content-gutter:30px;
  --font:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --mono:ui-monospace,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);font:var(--fs-3)/1.65 var(--font)}
h1,h2,h3{margin:0 0 10px;font-weight:650;line-height:1.35}
h1{font-size:24px}
h2{font-size:var(--fs-2)}
h3{font-size:var(--fs-3)}
p{margin:0 0 12px}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
small,.muted{color:var(--dim);font-size:var(--fs-4)}
.faint{color:var(--faint)}
.kicker{font-size:var(--fs-4);font-weight:650;letter-spacing:.8px;color:var(--faint);text-transform:uppercase;margin:20px 0 8px}

/* Centred, readable work area. A page opts in by wrapping its content in .page; .reading
   narrows the column for a form without moving its centre line, so a wizard and a table
   page still share one axis. */
.page{width:100%;max-width:var(--content-width);margin-inline:auto;padding-inline:var(--content-gutter)}
.reading{--content-width:960px}

/* Surfaces. */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px;margin:0 0 16px}
.card>h2,.card>h3{margin-top:0}
.card.danger{border-color:rgb(247 123 134/32%)}
.sub{color:var(--dim);font-size:var(--fs-3)}

/* Controls. A bare <button> is the secondary control, because pages and scripts create
   plenty of them without a class; .btn promotes one to the area's primary action. */
button{font:inherit;font-size:var(--fs-3);font-family:inherit;color:var(--fg);background:transparent;border:1px solid var(--line2);border-radius:8px;padding:9px 16px;cursor:pointer}
button:hover{border-color:var(--faint)}
button:disabled{opacity:.55;cursor:not-allowed;filter:none}
.btn,.button,.primary{display:inline-flex;align-items:center;gap:7px;background:var(--btn-fg);color:var(--btn-ink);font-weight:650;padding:9px 16px;border-radius:8px;border:0;cursor:pointer;font-size:var(--fs-3);font-family:inherit;text-decoration:none}
.btn:hover,.button:hover,.primary:hover{filter:brightness(.94);text-decoration:none;border-color:transparent}
/* A pressed secondary control is outlined in blue, not promoted to a primary button:
   a row of tabs that all look like the main action tells a reader nothing. */
button[aria-pressed=true]{border-color:var(--accent-d);color:var(--accent)}
.btn.s{background:transparent;color:var(--fg);border:1px solid var(--line2);font-weight:400}
.btn.s:hover{border-color:var(--faint);filter:none}
.btn.s[aria-pressed=true]{border-color:var(--accent-d);color:var(--accent)}
.btn.sm{padding:6px 12px;font-size:var(--fs-4)}
.btn.danger{background:transparent;color:var(--red);border:1px solid rgb(247 123 134/42%);font-weight:400}
.btn.danger:hover{background:rgb(247 123 134/10%);filter:none}
.btn:disabled,.primary:disabled,.button[aria-disabled=true]{opacity:.55;cursor:not-allowed;filter:none}
.linkbtn{background:none;border:0;padding:0;color:var(--accent);font-size:var(--fs-4);cursor:pointer;font-family:inherit}
.linkbtn:hover{text-decoration:underline}

/* Text entry. The reference Console sheet defeated its own focus ring by declaring
   outline:none at a higher specificity; the ring is stated explicitly here instead. */
input,select,textarea,.txt{font:inherit;font-size:var(--fs-3);font-family:inherit;color:var(--fg);background:var(--field);border:1px solid var(--line2);border-radius:8px;padding:9px 12px;min-width:0}
input[type=checkbox],input[type=radio]{accent-color:var(--accent);min-width:0;padding:0;vertical-align:middle}
input:focus,textarea:focus,select:focus{border-color:var(--accent-d)}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
input:disabled,select:disabled,textarea:disabled{background:#171717;opacity:.62;cursor:not-allowed}
input[readonly],textarea[readonly]{color:var(--dim);background:var(--panel)}
textarea{resize:vertical;font:var(--fs-4)/1.6 var(--mono);min-height:90px}
label{display:block;margin:12px 0}
label>input:not([type=checkbox]):not([type=radio]),label>select,label>textarea{display:block;width:100%;margin-top:5px}
.field{display:block;margin:0 0 12px}
.fieldgrid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.row.top{align-items:flex-start}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:18px}

/* Status. The word says what happened; the colour only helps find it. */
.pill{display:inline-flex;align-items:center;gap:5px;padding:2.5px 10px;border-radius:99px;font-size:var(--fs-4);border:1px solid var(--line2);color:var(--dim)}
.pill.ok{color:var(--green);border-color:rgb(79 209 142/38%);background:rgb(79 209 142/9%)}
.pill.wait{color:var(--amber);border-color:rgb(237 182 66/38%);background:rgb(237 182 66/9%)}
.pill.info{color:var(--accent);border-color:rgb(92 156 245/38%);background:rgb(92 156 245/9%)}
.pill.bad{color:var(--red);border-color:rgb(247 123 134/38%);background:rgb(247 123 134/9%)}
.kv{display:flex;gap:8px;justify-content:space-between;margin:6px 0;color:var(--dim)}
.kv b{color:var(--fg);font-weight:500;text-align:right;min-width:0;overflow-wrap:anywhere}

/* Verbatim material stays on the darker field surface, never recoloured to look decided. */
code,pre{font:var(--fs-4)/1.55 var(--mono);overflow-wrap:anywhere}
code{background:var(--field);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
pre{background:var(--field);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:0;overflow:auto;white-space:pre-wrap}

/* Tables keep their own width and scroll inside .table; narrowing them to fit a phone
   hides columns a reader came for. */
.table{overflow:auto;border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:11px 12px;border-bottom:1px solid var(--line);font-size:var(--fs-4);vertical-align:top}
th{color:var(--dim);font-weight:650;background:rgb(0 0 0/8%);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}

details{margin:12px 0}
summary{cursor:pointer;color:var(--accent)}
summary:hover{color:var(--fg)}
.empty-note{border:1px dashed var(--line2);border-radius:var(--radius);padding:30px 24px;text-align:center;color:var(--dim)}
.empty-note b{color:var(--fg)}
.notice{border-left:3px solid var(--accent);background:var(--panel2);border-radius:0 8px 8px 0;padding:12px 14px;white-space:pre-wrap}
.notice.error{border-left-color:var(--red)}
.brand-mark{width:14px;height:14px;border-radius:4px;background:var(--brand);flex:none;display:inline-block}
::selection{background:rgb(92 156 245/32%);color:var(--fg)}
[hidden]{display:none!important}

/* The way back to whatever launched this page. Quiet, never a primary action, and it only
   appears when a caller supplied one — see managerReturnHref. */
.manager-return{display:inline-flex;align-items:center;gap:6px;color:var(--dim);font-size:var(--fs-4);border:1px solid var(--line);border-radius:8px;padding:5px 10px;background:var(--panel2);text-decoration:none}
.manager-return:hover{color:var(--fg);border-color:var(--line2);text-decoration:none}

@media(max-width:920px){
  :root{--content-gutter:16px}
  .fieldgrid{grid-template-columns:1fr}
}
`

/**
 * The return link a launcher asked for, or '' when it asked for nothing.
 *
 * Local pages are opened directly as often as they are opened from something else, so the
 * way back cannot be a constant: a hard-coded manager port would be wrong for every
 * installation that did not happen to pick it, and a page that always shows the link would
 * promise a destination that is not running. The launcher therefore passes its own address
 * in `?manager=`, and this function decides whether that address may be rendered at all.
 *
 * What it refuses, and why each refusal is separate:
 *   · anything but http/https — `javascript:` in an href is script execution on this page;
 *   · any host that is not loopback — the parameter is attacker-supplied in the general
 *     case, and a link to elsewhere turns an operator page into a redirector;
 *   · embedded credentials — a userinfo section is credential material in a visible href.
 *
 * The manager's browser access key is needed even for GET /. It is a per-run loopback UI
 * capability, not the cloud device token. Retain only this key on the manager root; discard
 * unrelated query fields and fragments. Never substitute this instance's own local key.
 * All these operator pages use no-referrer and the target remains loopback.
 */
export function managerReturnHref(search) {
  const raw = new URLSearchParams(String(search || '')).get('manager') || ''
  if (!raw) return ''
  let url
  try { url = new URL(raw) } catch { return '' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  if (url.username || url.password) return ''
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host !== 'localhost' && host !== '::1' && !/^127\.\d+\.\d+\.\d+$/.test(host)) return ''
  if (url.pathname !== '/') return ''
  const keys = url.searchParams.getAll('k')
  if (keys.length > 1 || (keys.length === 1 && !/^[A-Za-z0-9_-]{16,128}$/.test(keys[0]))) return ''
  return url.origin + '/' + (keys.length === 1 ? '?k=' + encodeURIComponent(keys[0]) : '')
}
