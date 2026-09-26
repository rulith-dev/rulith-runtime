// SPDX-License-Identifier: Apache-2.0
import { localThemeCss, managerReturnHref, workbenchReadyScript } from './theme.mjs'
export const setupPage = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Setup · Rulith</title>
<style>
${localThemeCss}
/* A wizard is a reading task: one centred column, narrower than the tables elsewhere in
   Local, with each step a card on the same centre line as the header and the footer. */
body{max-width:960px;margin:0 auto;padding:36px var(--content-gutter) 64px}
h1{font-size:26px;margin:0 0 10px}
p{color:var(--dim)}
header{display:flex;gap:14px 20px;align-items:center;flex-wrap:wrap;justify-content:space-between;margin:0 0 30px}
header strong{display:inline-flex;align-items:center;gap:9px;font-size:var(--fs-2);letter-spacing:.2px}
header .row{gap:14px}
nav{display:flex;gap:4px;flex-wrap:wrap;margin:26px 0 0;border-bottom:1px solid var(--line)}
nav button{background:transparent;color:var(--dim);border:0;border-bottom:2px solid transparent;border-radius:0;padding:8px 14px;margin-bottom:-1px;font-size:var(--fs-3)}
nav button:hover{color:var(--fg)}
nav button[aria-current=step]{color:var(--fg);border-bottom-color:var(--accent)}
section{padding:22px 24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);margin:18px 0}
section>h2:first-child{margin-top:0}
#notice{white-space:pre-wrap;color:var(--amber)}
#notice:empty{display:none}
#notice:not(:empty){margin:16px 0 0;padding:11px 14px;border-left:3px solid var(--amber);background:var(--panel2);border-radius:0 8px 8px 0}
.code{font:32px/1.25 var(--mono);letter-spacing:7px;text-align:center;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:16px 12px;margin:14px 0 8px;overflow-wrap:anywhere}
.resource{border-top:1px solid var(--line);padding:12px 0}
.resource:first-child{border-top:0}
.resource>input{display:block;width:100%;margin-top:6px}
.resource label,#service-list label{margin:0}
#service-list label{border-top:1px solid var(--line);padding:11px 0}
#service-list+p{margin:16px 0 0}
#resource-result:empty,#context-name:empty{display:none}
@media(max-width:640px){body{padding:22px 16px 48px}section{padding:16px}.code{font-size:24px;letter-spacing:4px}}
</style></head><body>
<header><strong><span class="brand-mark"></span>RULITH · Setup</strong><span class="row" id="headerlinks"><a id="home">Open workspace</a></span></header>
<h1>Connect this computer</h1><p>Keep local resources here. Choose their Agent and authorize access in Console.</p>
<nav aria-label="Setup steps"><button data-step="pair">1 · Connect</button><button data-step="resources">2 · Resources</button><button data-step="run">3 · Start</button></nav>
<div id="notice" role="status" aria-live="polite"></div>
<section id="pair"><h2>How will you use Rulith?</h2>
<div id="pair-form"><label><input type="radio" name="mode" value="existing_agent" checked> Connect an existing agent or MCP client</label><label><input type="radio" name="mode" value="local_agent"> Run the agent with Rulith</label>
<label>Console address<input id="console-url" type="url" value="https://console.rulith.ai" autocomplete="url"></label><label>Computer name<input id="machine-name" maxlength="120" placeholder="My computer"></label>
<button class="primary" id="pair-start">Get pairing code</button></div>
<div id="pair-code" hidden><p>Open Console, sign in, and confirm this code for your Agent.</p><div class="code" id="code"></div><small id="expiry"></small><div class="actions"><a id="console-link" class="button" target="_blank" rel="noopener noreferrer">Open Console</a><button id="pair-check">Check connection</button></div></div>
<div id="linked" hidden><p id="linked-description"></p><button data-step="resources" class="primary">Continue to resources</button></div></section>
<section id="resources" hidden><h2>Choose local resources</h2><p id="context-name"></p><p>Only selected locations and tool descriptions are sent to Console. Credentials stay in the local vault.</p>
<div id="example" hidden><details><summary>Prepare the calculation sample</summary><label>New, empty directory<input id="sample-dir" placeholder="D:\Rulith\calculation"></label><button id="sample-prepare">Prepare sample files</button></details></div>
<div id="resource-list"></div><div id="service-list"></div><p><a id="tools-link">Install or manage local tools</a></p><div class="actions"><button id="resource-refresh">Refresh resources</button><button id="resource-share" class="primary">Send selection for authorization</button></div><p id="resource-result"></p></section>
<section id="run" hidden><h2>Authorize and start</h2><p>Start the Worker so Console can check the tools it provides. In Console, review and authorize the resources you selected.</p><div class="actions"><button id="worker-start">Start Worker</button><a id="authorize-link" class="button" target="_blank" rel="noopener noreferrer">Review in Console</a></div>
<div id="model-fields" hidden><h2 style="margin-top:28px">Local agent model</h2><p>Use an OpenAI-compatible or Anthropic endpoint. This configuration stays on this computer.</p><label>Model endpoint<input id="model-url" type="url" placeholder="http://127.0.0.1:8080/v1"></label><label>Model name<input id="model-name" autocomplete="off"></label><label>API key<input id="model-key" type="password" autocomplete="new-password" placeholder="Leave blank to keep the saved key only for the same service; optional for localhost"></label><label>Maximum output tokens per response<input id="model-max-output-tokens" type="number" min="256" max="65536" step="1" value="6000"></label><p>A higher limit may cost more. The model service may set a lower limit.</p><button id="model-save">Save model settings</button><div class="actions"><button class="primary" id="agent-start">Start local Agent</button><a id="chat-link">Open conversation</a></div></div>
<p id="existing-client">Use the MCP configuration shown in Console with your existing client. It uses that client's model; no second model configuration is needed here.</p>
<p id="process-state"></p><button id="runtime-stop">Stop local roles to edit setup</button></section>
<script>
const $=id=>document.getElementById(id), key=new URLSearchParams(location.search).get('k')||'';
let state={},context={},busy=false,step='pair',pollTimer;
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
${managerReturnHref.toString()}
/* Optional, and only ever what the launcher said: a manager passes its own loopback
   address in the manager parameter, which is carried on to the other Local pages so the
   way back survives this wizard. Nothing is assumed when it is absent, and the launcher's
   browser access key is retained for the authenticated return; other query fields are dropped. */
const manager=managerReturnHref(location.search), address=path=>path+'?k='+encodeURIComponent(key)+(manager?'&manager='+encodeURIComponent(manager):'');
for(const [id,path]of[['home','/'],['chat-link','/'],['tools-link','/worker-tools']])$(id).href=address(path);
if(manager){const back=document.createElement('a');back.id='managerreturn';back.className='manager-return';back.textContent='← Back to agents';back.href=manager;$('headerlinks').prepend(back);}
async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:{'x-rulith-local':key,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const v=await r.json();if(!r.ok||v.ok===false)throw Error(v.teaching||'This step could not be confirmed.');return v;}
async function act(fn){if(busy)return;busy=true;$('notice').textContent='';document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn()}catch(e){$('notice').textContent=e.message}finally{busy=false;document.querySelectorAll('button').forEach(b=>b.disabled=false)}}
function show(next){step=next;for(const id of ['pair','resources','run'])$(id).hidden=id!==next;document.querySelectorAll('nav button').forEach(b=>b.setAttribute('aria-current',b.dataset.step===next?'step':'false'));}
document.querySelectorAll('[data-step]').forEach(b=>b.onclick=()=>act(async()=>{if(b.dataset.step!=='pair'&&!state.linked)throw Error('Connect this Local first.');show(b.dataset.step);if(step==='resources')await resources();}));
async function refresh(){state=await api('/setup/state');$('pair-form').hidden=state.linked;$('pair-code').hidden=state.linked||!state.code;$('linked').hidden=!state.linked;$('code').textContent=state.code||'';$('expiry').textContent=state.expiresAt?'Expires '+new Date(state.expiresAt).toLocaleTimeString():'';$('console-link').href=state.consoleUrl+'/console/#/setup?code='+encodeURIComponent(state.code||'');$('authorize-link').href=state.consoleUrl+'/console/#/setup?agentId='+encodeURIComponent(state.agentId||'')+'&clientMode='+encodeURIComponent(state.clientMode);$('linked-description').textContent='Connected. Your Agent and resource permissions are managed in Console.';$('model-fields').hidden=state.clientMode!=='local_agent';$('existing-client').hidden=state.clientMode==='local_agent';const status=await api('/status');$('process-state').textContent='Worker: '+(status.worker?'running':'stopped')+' · Agent: '+(status.agent?'running':'stopped');}
async function resources(){context=await api('/setup/context');$('context-name').textContent='Agent: '+context.agentName;$('authorize-link').href=state.consoleUrl+'/console/#/setup?agentId='+encodeURIComponent(context.agentId)+'&clientMode='+encodeURIComponent(state.clientMode);$('example').hidden=!context.sources.some(s=>s.name==='verified-calculation-local');$('resource-list').innerHTML=context.sources.filter(s=>['file','db','http','mcp'].includes(s.type)).map(s=>{const saved=state.resources.find(v=>v.name===s.name);return '<div class="resource" data-resource="'+escape(s.name)+'"><label><input type="checkbox" '+(saved?'checked':'')+'> '+escape(s.title||s.name)+'</label><input aria-label="'+escape(s.name)+' location" value="'+escape(saved?.access||'')+'" placeholder="'+(s.type==='file'?'Absolute local file or folder':'local://resource-name')+'"></div>'}).join('');$('service-list').innerHTML=state.services.filter(s=>!context.sources.some(c=>c.name===s.name)).map(s=>'<label><input type="checkbox" data-service="'+escape(s.name)+'" '+(state.resources.some(r=>r.name===s.name)?'checked':'')+'> '+escape(s.name)+' <small>'+escape(s.tools.map(t=>t.name+' ('+t.kind+')').join(', '))+'</small></label>').join('');if(!context.sources.length&&!state.services.length)$('resource-list').textContent='No resources configured yet. Install a capability in Console, or add a local MCP service.';}
$('pair-start').onclick=()=>act(async()=>{await api('/setup/pair/start',{consoleUrl:$('console-url').value,name:$('machine-name').value,clientMode:document.querySelector('[name=mode]:checked').value});await refresh();schedulePoll();});
async function check(){const v=await api('/setup/pair/poll',{});await refresh();if(v.state==='delivered'){$('notice').textContent='Connected. Select your resources next.';show('resources');await resources();}}
function schedulePoll(){clearTimeout(pollTimer);if(!state.linked&&state.code&&Date.parse(state.expiresAt)>Date.now())pollTimer=setTimeout(async()=>{if(!busy&&!document.hidden)await act(check);schedulePoll();},4000)}
$('pair-check').onclick=()=>act(check);
$('sample-prepare').onclick=()=>act(async()=>{await api('/setup/example',{directory:$('sample-dir').value});await refresh();await resources();$('notice').textContent='Sample files prepared. Review and send the selected folder.';});
$('resource-refresh').onclick=()=>act(async()=>{await refresh();await resources();});
$('resource-share').onclick=()=>act(async()=>{const selected=[...document.querySelectorAll('[data-resource]')].filter(el=>el.querySelector('[type=checkbox]').checked).map(el=>({name:el.dataset.resource,access:el.querySelector('input:not([type=checkbox])').value}));const services=[...document.querySelectorAll('[data-service]:checked')].map(el=>el.dataset.service);await api('/setup/resources',{resources:selected,services});await refresh();show('run');$('notice').textContent='Selection sent. Start Worker, then review the authorization in Console.';});
$('model-save').onclick=()=>act(async()=>{await api('/setup/model',{url:$('model-url').value,name:$('model-name').value,key:$('model-key').value,maxOutputTokens:Number($('model-max-output-tokens').value)});$('model-key').value='';await refresh();$('notice').textContent='Model settings saved locally.';});
for(const role of ['worker','agent'])$(role+'-start').onclick=()=>act(async()=>{await api('/control',{role,operation:'start'});await refresh();$('notice').textContent=role==='worker'?'Worker started. Confirm the reported tools in Console.':'Agent started. Open the conversation to submit your task.';});
$('runtime-stop').onclick=()=>act(async()=>{const s=await api('/status');for(const role of s.roles)if(s[role])await api('/control',{role,operation:'stop'});await refresh();});
act(async()=>{await refresh();$('machine-name').value=state.machineName;$('console-url').value=state.consoleUrl;$('model-url').value=state.model.url;$('model-name').value=state.model.name;$('model-max-output-tokens').value=state.model.maxOutputTokens===null?'':String(state.model.maxOutputTokens??6000);show(state.linked?'resources':'pair');if(state.linked)await resources();schedulePoll();});
${workbenchReadyScript}
</script></body></html>`
