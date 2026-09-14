// SPDX-License-Identifier: Apache-2.0
/** Browser controller for the single Worker tool inventory. No Cloud credentials or authority state. */
export function startWorkerToolsPage(attachRegistryBrowser) {
  const $ = id => document.getElementById(id)
  const key = new URLSearchParams(location.search).get('k') || ''
  const node = (tag, text) => { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; return result }
  let view = { tools: [], services: [], presets: [] }, status = {}, busy = false, registry, loadedDirectory = false
  let originalName, originalToolId, originalToolRevision, preparationId = '', probeId = '', downloadService
  const blocked = () => busy || status.agent || status.worker
  $('back').href = '/?k=' + encodeURIComponent(key)
  function say(message, error = false) { $('result').textContent = message; $('result').classList.toggle('error', error) }
  async function api(path, body) {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-rulith-local': key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.teaching || 'Local request failed.')
    return result
  }
  function buttons() {
    // Keep an in-flight discovery attached to the form that initiated it.
    $('add').inert = busy; $('inventory').inert = busy
    document.querySelectorAll('[data-panel]').forEach(button => { button.disabled = busy })
    document.querySelectorAll('[data-mutation]').forEach(button => { button.disabled = blocked() })
    document.querySelectorAll('[data-control]').forEach(button => {
      const role = button.dataset.control
      button.disabled = busy || !status.roles?.includes(role) || (button.dataset.operation === 'start' ? status[role] : !status[role])
    })
    $('runtime-note').textContent = status.agent || status.worker ? 'Stop Agent and Worker before changing tool configuration. Browsing and inspecting tools remain available.'
      : 'Changes apply when Worker starts. Agent permissions and actual Connection locks are managed in Console.'
    registry?.updateButtons()
  }
  async function action(message, run) {
    if (busy) return
    busy = true; buttons(); say(message)
    try { await run() } catch (error) { say(error.message, true) } finally { busy = false; buttons() }
  }
  function panel(name) {
    for (const id of ['inventory', 'add']) $(id).hidden = id !== name
    document.querySelectorAll('[data-panel]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.panel === name)))
  }
  function addMode(mode) {
    panel('add')
    for (const id of ['directory', 'manual', 'mcp', 'templates']) $('add-' + id).hidden = id !== mode
    document.querySelectorAll('[data-add]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.add === mode)))
    $('discovery').hidden = true; $('handoff').hidden = true; say('Ready.')
    if (mode === 'directory' && !loadedDirectory) { loadedDirectory = true; registry.search() }
  }
  function fields() {
    const mode = $('mode').value
    $('connection-choice').hidden = !['stdio', 'streamable-http'].includes(mode)
    $('registry-configured').hidden = mode !== 'registry'
    for (const [id, value] of [['filesystem-fields', 'filesystem'], ['stdio-fields', 'stdio'], ['http-fields', 'streamable-http']]) $(id).hidden = mode !== value
    $('clear-secrets').parentElement.hidden = !['stdio', 'streamable-http'].includes(mode)
  }
  function resetService(mode = 'stdio') {
    originalName = undefined; preparationId = ''; probeId = ''; downloadService = undefined
    $('config').reset(); $('name').readOnly = false; $('name').value = ''; $('mode').value = mode
    $('reconfigure-registry').hidden = true
    $('secret-status').textContent = ''; $('service-title').textContent = mode === 'filesystem' ? 'Filesystem template' : 'Connect an MCP service'
    fields()
  }
  function handoff(service) {
    downloadService = service; $('handoff').hidden = false
    $('locator').textContent = service.source.transport === 'stdio' ? 'stdio:' + service.name : service.source.url
    $('definition').textContent = JSON.stringify(service.definition, null, 2)
  }
  function editService(service) {
    addMode('mcp'); resetService(service.mode); originalName = service.name
    $('name').value = service.name; $('name').readOnly = true
    $('service-title').textContent = 'Configure ' + service.name
    $('directory').value = service.directory || ''; $('command').value = service.source.command || ''
    $('args').value = JSON.stringify(service.source.args || [], null, 2); $('cwd').value = service.source.cwd || ''; $('url').value = service.source.url || ''
    $('registry-configured').textContent = service.registry ? service.registry.name + ' · ' + service.registry.version + '. Discovery reuses the saved launch configuration.' : ''
    $('secret-status').textContent = service.mode === 'registry' ? 'Launch configuration stays on this machine.' : service.secretConfigured ? 'Credentials are configured locally. Blank fields preserve them only for the same launch target.' : ''
    $('reconfigure-registry').hidden = !service.registry
    $('reconfigure-registry').onclick = () => {
      addMode('directory'); $('registry-source-name').value = service.name; $('registry-source-name').readOnly = true
      registry.detail({ name: service.registry.name, version: service.registry.version })
    }
    handoff(service)
  }
  function renderTools() {
    const query = $('tool-search').value.toLowerCase(), filter = $('tool-origin').value
    $('tool-rows').replaceChildren()
    for (const tool of view.tools.filter(tool => (!filter || tool.origin === filter) && (tool.id + ' ' + tool.adapter + ' ' + (tool.service || '')).toLowerCase().includes(query))) {
      const row = node('tr'), identity = node('td'), contract = node('details')
      identity.append(node('b', tool.id), node('div', tool.service ? 'MCP service: ' + tool.service : tool.origin === 'builtin' ? 'Built into Worker' : 'Tool manifest'))
      contract.append(node('summary', 'View contract'), node('pre', JSON.stringify({ digest: tool.digest, sourceTypes: tool.sourceTypes, params: tool.params, returns: tool.returns }, null, 2)))
      identity.append(contract)
      const controls = node('td'), edit = node('button', tool.origin === 'manifest' ? 'Edit definition' : tool.origin === 'mcp' ? 'Configure service' : 'Built-in settings')
      edit.onclick = () => {
        if (tool.origin === 'manifest') editTool(tool)
        else if (tool.origin === 'mcp') editService(view.services.find(service => service.name === tool.service))
        else { $('builtin-settings').open = true; $('builtin-settings').scrollIntoView({ block: 'center', behavior: 'smooth' }) }
      }
      controls.append(edit)
      row.append(identity, node('td', tool.adapter + ' · ' + tool.kind), node('td', tool.configured ? 'Configured for Worker' : 'Disabled locally'), controls)
      $('tool-rows').append(row)
    }
    $('tool-count').textContent = view.tools.filter(tool => tool.configured).length + ' configured tools · ' + view.tools.filter(tool => !tool.configured).length + ' disabled built-ins'
  }
  async function refresh() {
    const [tools, runtime] = await Promise.all([api('/worker-tools/state'), api('/status')])
    view = tools; status = runtime
    $('runtime').textContent = 'Agent ' + (status.agent ? 'running' : 'stopped') + ' · Worker ' + (status.worker ? 'running' : 'stopped')
    $('workspace-mode').value = view.workspaceMode; $('manifest-path').textContent = view.manifestFile; $('vault-path').textContent = view.vaultFile
    $('services').replaceChildren()
    for (const service of view.services) {
      const card = node('div'); card.className = 'service'
      card.append(node('b', service.name), node('span', ' · ' + Object.keys(service.tools).length + ' selected tools '))
      const edit = node('button', 'Configure service'); edit.onclick = () => editService(service)
      const remove = node('button', 'Remove local service'); remove.dataset.mutation = ''
      remove.onclick = () => action('Removing local service configuration…', async () => {
        const result = await api('/mcp-services/remove', { name: service.name }); await refresh(); say(result.teaching)
      })
      card.append(edit, remove); $('services').append(card)
    }
    if (!view.services.length) $('services').textContent = 'No MCP services configured.'
    const preset = view.presets[0]
    $('preset-version').textContent = preset.package + '@' + preset.version
    $('template-use').textContent = preset.installed ? 'Configure Filesystem' : 'Use Filesystem template'
    renderTools(); buttons()
  }
  const templates = {
    http: { adapter: 'http', sourceTypes: ['http'], entry: '/path', fence: { method: 'GET' }, kind: 'read', params: {}, returns: [] },
    'db-query': { adapter: 'db-query', sourceTypes: ['db'], entry: 'SELECT value FROM records WHERE id={id}', kind: 'read', params: { id: 'string' }, returns: [] },
    'db-exec-fenced': { adapter: 'db-exec-fenced', sourceTypes: ['db'], entry: 'UPDATE records SET value={value} WHERE id={id}', kind: 'write', params: { id: 'string', value: 'string' }, returns: [] },
    run: { adapter: 'run', sourceTypes: [], entry: 'adapters/tool.mjs', kind: 'run', params: {}, returns: [], env: { pass: [] } },
    mcp: { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'tool_name', kind: 'read', params: {}, returns: [] },
    workspace: { adapter: 'workspace', sourceTypes: ['file'], entry: 'read_text' },
  }
  function editTool(tool) {
    addMode('manual'); originalToolId = tool?.id; originalToolRevision = view.revision
    $('tool-id').value = tool?.id || ''; $('tool-id').readOnly = !!tool
    $('adapter-template').value = tool?.adapter || 'http'
    $('tool-definition').value = JSON.stringify(tool?.definition || templates.http, null, 2)
    $('remove-tool').hidden = !tool
    $('manual-title').textContent = tool ? 'Edit Tool definition' : 'Add a declared Tool'
  }
  async function discover() {
    const mode = $('mode').value
    const body = { name: $('name').value, mode, originalName, isNew: originalName === undefined }
    if (mode === 'registry') body.preparationId = preparationId
    else if (mode === 'filesystem') body.directory = $('directory').value
    else if (mode === 'stdio') Object.assign(body, { command: $('command').value, args: JSON.parse($('args').value || '[]'), cwd: $('cwd').value,
      clearSecrets: $('clear-secrets').checked, ...($('env').value.trim() ? { env: JSON.parse($('env').value) } : {}) })
    else Object.assign(body, { url: $('url').value, token: $('token').value, clearSecrets: $('clear-secrets').checked })
    const result = await api('/mcp-services/probe', body)
    probeId = result.probeId; $('tools').replaceChildren()
    for (const tool of result.tools) {
      const row = node('tr'), check = node('input'), description = node('td'), selection = result.selected.find(item => item.name === tool.name)
      check.type = 'checkbox'; check.disabled = !!tool.unsupported; check.checked = !!selection; check.setAttribute('aria-label', 'Select ' + tool.name)
      const first = node('td'); first.append(check)
      description.append(node('b', tool.name), node('p', tool.description))
      const schema = node('details'); schema.append(node('summary', 'Input schema'), node('pre', JSON.stringify(tool.inputSchema, null, 2))); description.append(schema)
      if (tool.unsupported) description.append(node('p', tool.unsupported))
      const kind = node('select'); kind.setAttribute('aria-label', 'Operation for ' + tool.name)
      for (const value of ['', 'read', 'write', 'run']) { const option = node('option', value || 'Choose…'); option.value = value; kind.append(option) }
      kind.value = selection?.kind || ''; kind.disabled = !!tool.unsupported
      const last = node('td'); last.append(kind); row.dataset.tool = tool.name; row.append(first, description, last); $('tools').append(row)
    }
    $('discovery').hidden = false; $('handoff').hidden = true
    $('truncated').textContent = result.truncated ? 'The discovery limit was reached. Only listed tools can be selected.' : ''
    $('discovery').scrollIntoView({ behavior: 'smooth', block: 'start' }); say('Discovery complete. Review selected tools and operation types. No tool was executed.')
  }
  registry = attachRegistryBrowser({ $, node, api, action, isBlocked: blocked, autoLoad: false,
    sourceName: () => $('registry-source-name').value,
    onPrepared: async (result, name) => {
      const editing = $('registry-source-name').readOnly
      addMode('mcp'); resetService('registry'); preparationId = result.preparationId; originalName = editing ? name : undefined
      $('name').value = name; $('name').readOnly = editing
      $('registry-configured').textContent = result.registry.name + ' · ' + result.registry.version
      $('reconfigure-registry').hidden = true; await discover()
    } })
  document.querySelectorAll('[data-panel]').forEach(button => button.onclick = () => {
    panel(button.dataset.panel)
    if (button.dataset.panel === 'add') { $('registry-source-name').readOnly = false; $('registry-source-name').value = ''; addMode('directory') }
  })
  document.querySelectorAll('[data-add]').forEach(button => button.onclick = () => {
    const mode = button.dataset.add
    addMode(mode)
    if (mode === 'manual') editTool()
    if (mode === 'mcp') resetService()
    if (mode === 'directory') { $('registry-source-name').readOnly = false; $('registry-source-name').value = '' }
  })
  document.querySelectorAll('[data-control]').forEach(button => button.onclick = () => action('Updating Runtime process…', async () => {
    const result = await api('/control', { role: button.dataset.control, operation: button.dataset.operation }); await refresh(); say(result.teaching || button.dataset.control + ': ' + result.state)
  }))
  $('tool-search').oninput = renderTools; $('tool-origin').onchange = renderTools
  $('refresh').onclick = () => action('Refreshing configuration…', async () => { await refresh(); say('Configuration refreshed.') })
  $('adapter-template').onchange = () => { $('tool-definition').value = JSON.stringify(templates[$('adapter-template').value], null, 2) }
  $('manual-form').onsubmit = event => { event.preventDefault(); action('Saving the Tool definition…', async () => {
    const result = await api('/worker-tools/save', { id: $('tool-id').value, originalId: originalToolId, definition: JSON.parse($('tool-definition').value), revision: originalToolRevision })
    await refresh(); panel('inventory'); say(result.teaching)
  }) }
  $('remove-tool').onclick = () => action('Removing the local Tool definition…', async () => {
    const result = await api('/worker-tools/remove', { id: originalToolId, revision: originalToolRevision }); await refresh(); panel('inventory'); say(result.teaching)
  })
  $('workspace-save').onclick = () => action('Saving built-in workspace mode…', async () => {
    const result = await api('/worker-tools/workspace', { mode: $('workspace-mode').value, revision: view.revision }); await refresh(); say(result.teaching)
  })
  $('template-use').onclick = () => { addMode('mcp'); resetService('filesystem'); $('service-title').textContent = 'Filesystem template' }
  $('mode').onchange = () => { $('env').value = ''; $('token').value = ''; fields() }
  $('config').oninput = () => { probeId = ''; $('discovery').hidden = true }
  $('config').onsubmit = event => { event.preventDefault(); action('Configuring and discovering tools…', async () => {
    if ($('mode').value === 'filesystem') await api('/mcp-services/install', { catalogId: 'filesystem' })
    await discover()
  }) }
  $('save').onclick = () => action('Saving selected tools…', async () => {
    const tools = [...$('tools').children].filter(row => row.querySelector('input').checked).map(row => ({ name: row.dataset.tool, kind: row.querySelector('select').value }))
    const result = await api('/mcp-services/apply', { probeId, tools }); probeId = ''; preparationId = ''
    await refresh(); editService(result.service); say(result.teaching)
  })
  $('download').onclick = () => {
    if (!downloadService) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(downloadService.definition, null, 2) + '\n'], { type: 'application/json' }))
    const anchor = node('a'); anchor.href = url; anchor.download = downloadService.name + '-source.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  panel('inventory'); refresh().catch(error => say(error.message, true))
}
