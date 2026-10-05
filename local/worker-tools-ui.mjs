// SPDX-License-Identifier: Apache-2.0
import { attachRegistryBrowser } from './mcp-registry-ui.mjs'
import { startWorkerToolsPage } from './worker-tools-browser.mjs'
import { localThemeCss, managerReturnHref, workbenchReadyScript } from './theme.mjs'

/**
 * Where the environment's page sends each request the shared controller makes.
 *
 * The controller was written for one Agent's host and calls that host's fixed paths. The
 * environment's tools are served by the manager instead, so every path it can use is mapped here
 * to the explicit manager route that does the same thing, and nothing else is reachable from the
 * page: a path with no entry goes out as it is and the manager answers it with a 404.
 */
const ENVIRONMENT_ROUTES = Object.freeze({
  '/worker-tools/state': '/manager/tools/state',
  '/worker-tools/save': '/manager/tools/save',
  '/worker-tools/remove': '/manager/tools/remove',
  '/mcp-services/install': '/manager/tools/mcp-install',
  '/mcp-services/prepare': '/manager/tools/mcp-prepare',
  '/mcp-services/probe': '/manager/tools/mcp-probe',
  '/mcp-services/apply': '/manager/tools/mcp-apply',
  '/mcp-services/remove': '/manager/tools/mcp-remove',
  '/mcp-services/search': '/manager/tools/mcp-search',
  '/mcp-services/detail': '/manager/tools/mcp-detail',
  '/mcp-services/downloads': '/manager/tools/mcp-downloads',
})

/**
 * The tools page for one scope: `instance` is one Agent's own tools and the settings that are
 * its own, served by that Agent's host; `environment` is the tools every Agent shares, served by
 * the manager. They are one page because they are one job — a list of tools, a way to add one,
 * a way to connect an MCP service — and differ only in what belongs to the environment:
 *
 *   · no runtime card, built-in tool settings or script template, which are an Agent's own;
 *   · who uses the tools, the keys that are kept here, and the folders a service shares.
 */
function toolsPage(scope) {
  const environment = scope === 'environment'
  const options = environment ? { scope, header: 'x-rulith-manager', routes: ENVIRONMENT_ROUTES } : { scope }
  const title = environment ? 'This environment’s tools' : 'Agent tools'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · Rulith</title>
<style>
${localThemeCss}
/* The work here is an inventory, so the content column stays at the full Console width and
   the tables keep their own minimum width and scroll inside .table. Narrowing a tool table
   to fit a phone would hide the adapter and origin columns a reader came to compare. */
header{display:flex;align-items:center;flex-wrap:wrap;gap:12px 24px;padding:16px max(var(--content-gutter),calc((100% - var(--content-width))/2 + var(--content-gutter)));border-bottom:1px solid var(--line);background:var(--side)}
header b{font-size:var(--fs-2)}
.headerbrand{display:inline-flex;align-items:center;gap:10px}
header .crumb{color:var(--faint)}
#headerlinks{margin-left:auto;gap:16px}
main{display:block;width:100%;max-width:var(--content-width);margin-inline:auto;padding:26px var(--content-gutter) 60px}
h1{margin:0 0 8px}
article{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:20px 22px;margin:16px 0}
article>h2:first-child,article>h3:first-child{margin-top:0}
p{margin:8px 0 14px}
nav{margin:18px 0}
/* Only a search box that IS the row stretches. Scoped to a direct child because the same
   rule used to reach a checkbox nested in a label and stretch it to 160px. */
.row>input{min-width:160px;flex:1}
.row>label,.row>h2,.row>h3,.row>p{margin:0}
/* A checkbox beside a labelled select lines up on the control, not on the block centre. */
.row.baseline{align-items:flex-end;gap:10px 20px}
.row.baseline>label{padding-bottom:9px}
.row.baseline>label:has(>select){padding-bottom:0}
table{min-width:660px}
td:first-child{min-width:260px;max-width:600px;overflow-wrap:anywhere}
td div{color:var(--dim)}
td select{max-width:120px}
td b{font-weight:650}
td p{margin:6px 0}
.notice{position:sticky;bottom:12px;z-index:2;margin-top:18px;box-shadow:0 10px 30px rgb(0 0 0/45%)}
#library-banner{position:static;box-shadow:none;margin:0 0 16px}
.service{padding:12px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.service button{margin:8px 8px 0 0}
.service small{display:block}
.directory-results{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:14px;margin-top:16px}
.directory-card{display:flex;flex-direction:column;border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:16px;overflow-wrap:anywhere}
.directory-card>.btn{justify-content:center;width:100%;margin-top:auto}
.directory-card div{color:var(--dim);font-size:var(--fs-4)}
.directory-card .card-title{font-size:var(--fs-3)}
.package-downloads{color:var(--dim);font-size:var(--fs-4);margin:8px 0}
.package-downloads .download-count{display:block;color:var(--fg);margin-top:4px}
.outlink{white-space:nowrap}
#registry-detail{border-top:1px solid var(--line);margin-top:20px;padding-top:20px}
#registry-identity{overflow-wrap:anywhere}
#registry-option{max-width:100%}
#registry-inputs small{display:block;margin-top:4px}
#tool-definition{min-height:280px}
#builtin-settings{padding:14px 0}
.tight{max-width:700px}
#tools td:first-child{min-width:35px;width:35px;max-width:35px}
#change-review{position:fixed;inset:0;z-index:10;display:grid;place-items:center;padding:16px;background:rgb(0 0 0/65%)}
#change-review[hidden]{display:none}
#change-review article{width:min(760px,100%);max-height:90dvh;overflow:auto;margin:0}
#change-details{white-space:pre-wrap;overflow-wrap:anywhere}
@media(max-width:720px){main{padding:18px 16px 48px}article{padding:16px}header{padding:14px 16px;gap:10px 14px}#headerlinks{margin-left:0}td:first-child{min-width:230px}}
</style></head><body><header><span class="headerbrand"><span class="brand-mark"></span><b>Rulith</b></span><span class="crumb">${title}</span><span class="row" id="headerlinks"><a id="back">← Workbench</a></span></header><main>
${environment
    ? `<h1>This environment’s tools</h1><p class="muted">Tools and MCP services you add here are installed once, and every Agent in this environment advertises them. Console still decides what an Agent may call. Changing a tool changes its pin; Agents using it need it locked again in Console.</p>
<p id="used-by" class="muted"></p><p class="muted">Folders explicitly named in a service’s launch settings are shared by every Agent using it. Discovery scratch is separate for each Agent.</p>`
    : `<h1>Agent tools</h1><p class="muted">Manage built-in, declared and MCP tools in one place. Local configuration defines available tools; Console controls what an Agent may use.</p>
<p id="library-banner" class="notice" role="status" hidden></p>
<article><div class="row"><b id="runtime">Checking Runtime…</b><button id="refresh">Refresh</button><label><input id="worker-setting" type="checkbox">Use this environment’s tools and files</label></div><p id="runtime-note" class="muted"></p></article>`}
<nav class="row" aria-label="Tool management"><button data-panel="inventory">${environment ? 'Tools' : 'My tools'}</button><button data-panel="add">Add tools</button></nav>
<section id="inventory"><article><div class="row"><h2>${environment ? 'Tools in this environment' : 'Configured tools'}</h2><span id="tool-count" class="muted"></span></div><div class="row"><input id="tool-search" aria-label="Filter tools" placeholder="Find a Tool ID, adapter or service"><select id="tool-origin" aria-label="Configuration origin"><option value="">All origins</option>${environment ? '' : '<option value="builtin">Built-in</option>'}<option value="manifest">Tool manifest</option><option value="mcp">MCP service</option></select></div>
<div class="table"><table><thead><tr><th>Tool and configuration origin</th><th>Adapter / operation</th><th>${environment ? 'Used by' : 'Local configuration'}</th><th>Manage</th></tr></thead><tbody id="tool-rows"></tbody></table></div>
${environment ? '' : `<details id="builtin-settings"><summary>Built-in tool settings</summary><p>The built-in contracts are fixed by Worker. Workspace mode controls local availability; MCP discovery remains a fixed Source tool. Each Tool still needs Console authorization.</p><div class="row"><label>Workspace mode<select id="workspace-mode"><option value="off">Off</option><option value="read">Read only</option><option value="read-write">Read and write</option></select></label><button id="workspace-save" data-mutation>Save workspace mode</button></div></details>`}
<details${environment ? ' open' : ''}><summary>${environment ? 'MCP services, keys and files' : 'MCP services and local configuration files'}</summary><div id="services"></div><p>Tool manifest: <code id="manifest-path"></code></p>${environment
    ? `<h3>Keys in this environment</h3><div id="keys"></div><p class="muted">Keys stay in this environment. To add or change one, edit <code id="vault-path"></code>. A key is used only for a Source granted to the Agent in Console, and only for its credentials (a token, headers, a database connection string at the granted address), never to say what a Source is or where or how it connects.</p><p class="muted">An MCP service’s own credentials belong to that service and go with it to every Agent.</p>`
    : `<p>Source vault: <code id="vault-path"></code></p><p class="muted">Database credentials, HTTP secrets and Source roots continue to use the local Source vault. They are not included in tool contracts or sent to Cloud.</p>`}</details></article></section>
<section id="add" hidden><nav class="row" aria-label="Add tool method"><button data-add="directory">MCP directory</button><button data-add="mcp">Connect MCP</button><button data-add="manual">Declare a Tool</button><button data-add="templates">Templates</button></nav>
<article id="add-directory"><h2>Find an MCP service</h2><p class="muted">Search server names in the official MCP Registry. A directory listing is not a security review or Agent authorization.</p>
<form id="registry-search" class="row"><input id="registry-query" aria-label="Search MCP servers" placeholder="filesystem, memory, time…" maxlength="150"><button id="registry-search-button">Search directory</button></form>
<div class="row baseline"><label><input id="registry-supported" type="checkbox"> Supported setup only</label><label>Sort loaded results<select id="registry-sort"><option value="directory">Directory order</option><option value="downloads">Package downloads ↓</option><option value="updated">Registry updated ↓</option></select></label></div>
<p class="muted">Supported setup is based on the declared format; package identity and prerequisites are checked during installation. Downloads count packages across all versions, not unique users or tool calls. They do not certify quality.</p>
<p id="registry-status" role="status"></p><p id="registry-scope" class="muted"></p><div id="registry-results" class="directory-results"></div><button id="registry-more" hidden>Load more</button>
<div id="registry-detail" hidden><h3 id="registry-title"></h3><p id="registry-identity" class="muted"></p><p id="registry-description"></p><p id="registry-dates" class="muted"></p><div id="registry-links" class="row"></div><form id="registry-setup"><label>Local Source ID<input id="registry-source-name" required pattern="[a-z][a-z0-9_-]{0,39}" maxlength="40" placeholder="office-mail"></label><label>Installation option<select id="registry-option"></select></label><div id="registry-downloads" class="package-downloads"></div><p id="registry-limits" class="muted"></p><div id="registry-inputs"></div><button id="registry-prepare" class="primary">Install and discover tools</button></form></div></article>
<article id="add-templates" hidden><h2>Configuration templates</h2><div class="tight"><h3>Filesystem</h3><p>Install the fixed reference server and select one allowed directory. Then review and select its tools through the same service workflow.${environment ? ' The directory you choose is shared by every Agent in this environment.' : ''}</p><p id="preset-version" class="muted"></p><div class="row"><button id="template-use">Use Filesystem template</button><a href="https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem" target="_blank" rel="noreferrer">Source repository ↗</a></div></div></article>
<article id="add-manual" hidden><h2 id="manual-title">Add a declared Tool</h2><p class="muted">Declare HTTP, database, ${environment ? '' : 'script, '}workspace operations or an MCP tool. Saving does not execute it or grant Agent access.${environment ? ' A script tool runs files from one Agent’s own folder, so it stays with that Agent: add it to that Agent’s own tool file.' : ''}</p><form id="manual-form"><div class="fieldgrid"><label>Tool ID<input id="tool-id" required placeholder="acme.orders.lookup@1"></label><label>Definition template<select id="adapter-template"><option value="http">HTTP</option><option value="db-query">Database query</option><option value="db-exec-fenced">Database write</option>${environment ? '' : '<option value="run">Local script / command</option>'}<option value="mcp">Declared MCP tool</option><option value="workspace">Workspace operation</option></select></label></div><label>Tool definition (JSON)<textarea id="tool-definition" required spellcheck="false"></textarea></label><p class="muted">Keep credentials in the Source vault. Declare business parameters and result mappings explicitly; Local validates the tool contract.</p><div class="row"><button class="primary" data-mutation>Review Tool definition</button><button type="button" id="remove-tool" data-mutation hidden>Remove from local manifest</button></div></form></article>
<article id="add-mcp" hidden><h2 id="service-title">Connect an MCP service</h2><form id="config"><div class="fieldgrid"><label>Source name<input id="name" required pattern="[a-z][a-z0-9_-]{0,39}" maxlength="40" placeholder="office-mail"></label><label id="connection-choice">Transport<select id="mode"><option value="stdio">Existing stdio executable</option><option value="streamable-http">Streamable HTTP endpoint</option><option value="filesystem" hidden>Filesystem template</option><option value="registry" hidden>Directory service</option></select></label></div><p id="registry-configured" hidden></p><button type="button" id="reconfigure-registry" hidden>Change directory configuration</button>
<div id="filesystem-fields" hidden><label>Allowed directory<input id="directory" placeholder="Existing absolute directory"></label></div><div id="stdio-fields"><label>Executable<input id="command" placeholder="node or an absolute executable path"></label><label>Arguments (JSON array)<textarea id="args" spellcheck="false">[]</textarea></label><label>Working directory (optional)<input id="cwd"></label><details><summary>Environment and credentials</summary><label>Environment / secrets (JSON object; blank preserves saved values for the same target)<textarea id="env" autocomplete="off" spellcheck="false"></textarea></label></details></div>
<div id="http-fields" hidden><label>MCP endpoint<input id="url" placeholder="http://127.0.0.1:3001/mcp"></label><label>Bearer token (blank preserves it for the same endpoint)<input id="token" type="password" autocomplete="new-password"></label></div><label><input id="clear-secrets" type="checkbox"> Clear saved credentials on this edit</label><p id="secret-status" class="muted"></p><button id="probe" class="primary" data-mutation>Configure and discover tools</button></form></article>
<article id="discovery" hidden><h2>Select tools</h2><p class="muted">Review read / write / run classifications. Existing selections are preserved only when their input schema has not changed. Raw MCP output remains material.</p><div class="table"><table><thead><tr><th></th><th>Tool and inputs</th><th>Operation</th></tr></thead><tbody id="tools"></tbody></table></div><p id="truncated" class="muted"></p><button id="save" class="primary" data-mutation>Save selected tools locally</button></article>
<article id="handoff" hidden><h2>Connect this service to an Agent</h2><p>Local configuration is saved. Review the following steps in Console.</p><ol><li>Enable <b>Use this environment’s tools and files</b> for each Agent that should advertise configured tools.</li><li>Download the Source definition. Import and review it under the Agent's Configuration → Sources.</li><li>Under Runtime, bind the Source for this Agent, using the location below, then enable and lock its tools.</li><li>The Agent discovers authorized Actions with QueryBoard and uses ApplyAction.</li></ol><p>Source location: <code id="locator"></code></p><button id="download">Download Source definition</button><details><summary>Review Source definition</summary><pre id="definition"></pre></details></article></section>
<section id="change-review" role="dialog" aria-modal="true" aria-labelledby="change-title" hidden><article><h2 id="change-title"></h2><p id="change-impact"></p><pre id="change-details"></pre><div class="row"><button id="change-confirm" class="primary">Confirm change</button><button id="change-cancel">Cancel</button></div></article></section>
<div id="result" class="notice" role="status" aria-live="polite">Ready.</div></main><script>(${startWorkerToolsPage.toString()})(${attachRegistryBrowser.toString()},${JSON.stringify(options)});</script><script>${managerReturnHref.toString()}
/* Routes out of this page. "Back to setup" used to float over the bottom-right corner,
   where it covered the sticky result notice this page writes every outcome into; it sits
   with the other navigation instead. The manager return appears only when a launcher
   supplied a loopback address, and is applied after the controller has set its own links
   so every way out of here keeps the way back. */
const pageKey=new URLSearchParams(location.search).get('k')||'',manager=managerReturnHref(location.search);
const address=path=>path+'?k='+encodeURIComponent(pageKey)+(manager?'&manager='+encodeURIComponent(manager):'');
const links=document.getElementById('headerlinks');
document.getElementById('back').href=address('/');
${environment ? '' : `const setupLink=document.createElement('a');setupLink.id='backsetup';setupLink.textContent='Back to setup';setupLink.href=address('/setup');links.append(setupLink);
`}if(manager){const home=document.createElement('a');home.id='managerreturn';home.className='manager-return';home.textContent='← Back to agents';home.href=manager;links.append(home);}
${workbenchReadyScript}
</script></body></html>`
}

/** One Agent's own tools, served by that Agent's host. */
export const workerToolsPage = toolsPage('instance')
/** The tools every Agent in this environment shares, served by the manager. */
export const environmentToolsPage = toolsPage('environment')
