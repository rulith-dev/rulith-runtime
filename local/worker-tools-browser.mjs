// SPDX-License-Identifier: Apache-2.0
/**
 * Browser controller for the single Worker tool inventory. No Cloud credentials or authority state.
 *
 * One controller serves both pages that list tools (`worker-tools-ui.mjs`): one Agent's own, which
 * talks to that Agent's host, and the environment's, which talks to the manager. `options` says
 * which: `scope`, the name of the header that carries this page's key, and `routes`, the path each
 * request maps to when it is not the one named here. The page passes it as JSON, because this
 * function is inlined into the page and can see nothing outside itself.
 */
export function startWorkerToolsPage(attachRegistryBrowser, options = {}) {
  const $ = id => document.getElementById(id)
  const environment = options.scope === 'environment'
  const key = new URLSearchParams(location.search).get('k') || ''
  const node = (tag, text) => { const result = document.createElement(tag); if (text !== undefined) result.textContent = text; return result }
  let view = { tools: [], services: [], presets: [] }, status = {}, busy = false, registry, loadedDirectory = false
  let originalName, originalToolId, originalToolRevision, preparationId = '', probeId = '', downloadService
  let pendingChange, changeFocus
  const blocked = () => busy || pendingChange !== undefined
  $('back').href = '/?k=' + encodeURIComponent(key)
  function say(message, error = false) { $('result').textContent = message; $('result').classList.toggle('error', error) }
  async function api(path, body) {
    // The path this page was written against, sent to the route that does the same thing for this scope.
    const at = path.indexOf('?'), base = at < 0 ? path : path.slice(0, at)
    const target = (options.routes?.[base] ?? base) + (at < 0 ? '' : path.slice(at))
    const response = await fetch(target, { method: body === undefined ? 'GET' : 'POST', headers: { [options.header || 'x-rulith-local']: key, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok || result.ok === false) throw new Error(result.teaching || 'Local request failed.')
    return result
  }
  /** After a change that takes tools away or changes them: who has it, and when they lose it. */
  function reach(result) {
    const names = result.affected || []
    return names.length ? ' Affected after running work finishes: ' + names.join(', ') + '.' : ''
  }
  function buttons() {
    // Keep an in-flight discovery attached to the form that initiated it.
    $('add').inert = blocked(); $('inventory').inert = blocked()
    document.querySelectorAll('[data-panel]').forEach(button => { button.disabled = blocked() })
    document.querySelectorAll('[data-mutation]').forEach(button => { button.disabled = blocked() })
    if (!environment) {
      $('worker-setting').checked = status.workerSetting?.enabled === true
      $('worker-setting').disabled = busy
      $('runtime-note').textContent = 'Changes reload the Worker automatically after running executions drain. Tool and resource permissions stay in Console.'
    }
    registry?.updateButtons()
  }
  async function action(message, run) {
    if (busy) return
    busy = true; buttons(); say(message)
    try { await run() } catch (error) { say(error.message, true) } finally { busy = false; buttons() }
  }
  // One review inside the page also works in the workbench's sandboxed frame. Merely opening,
  // typing, installing or discovering never changes a saved tool or service.
  function reviewChange(title, details, run) {
    if (blocked()) return
    changeFocus = document.activeElement
    $('change-title').textContent = title
    $('change-details').textContent = details
    $('change-impact').textContent = environment
      ? 'This change reaches every Agent in this environment after running work finishes. Changed tools need to be locked again in Console.'
      : 'This change reaches this Agent after running work finishes. Changed tools need to be locked again in Console.'
    pendingChange = run; $('change-review').hidden = false; buttons(); $('change-confirm').focus()
  }
  function closeReview() {
    pendingChange = undefined; $('change-review').hidden = true; buttons(); changeFocus?.focus()
  }
  $('change-cancel').onclick = closeReview
  $('change-confirm').onclick = () => {
    if (!pendingChange) return
    const run = pendingChange; closeReview()
    return action('Saving the confirmed change…', run)
  }
  $('change-review').onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeReview() }
    if (event.key === 'Tab') {
      event.preventDefault()
      ;(document.activeElement === $('change-confirm') ? $('change-cancel') : $('change-confirm')).focus()
    }
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
    $('secret-status').textContent = service.mode === 'registry' ? 'Launch configuration stays in this environment.' : service.secretConfigured ? 'Credentials are configured locally. Blank fields preserve them only for the same launch target.' : ''
    $('reconfigure-registry').hidden = !service.registry
    $('reconfigure-registry').onclick = () => {
      addMode('directory'); $('registry-source-name').value = service.name; $('registry-source-name').readOnly = true
      registry.detail({ name: service.registry.name, version: service.registry.version })
    }
    handoff(service)
  }
  // An Agent that uses its environment's tools changes them in the workbench, not here: the host
  // refuses these edits, so they are not offered. Its built-in settings are its own and stay.
  const shared = () => !environment && view.library !== undefined
  function renderTools() {
    const query = $('tool-search').value.toLowerCase(), filter = $('tool-origin').value
    $('tool-rows').replaceChildren()
    // Built-in tools are each Agent's own file-tool setting, not part of what the environment shares.
    const listed = view.tools.filter(tool => !(environment && tool.origin === 'builtin'))
    for (const tool of listed.filter(tool => (!filter || tool.origin === filter) && (tool.id + ' ' + tool.adapter + ' ' + (tool.service || '')).toLowerCase().includes(query))) {
      const row = node('tr'), identity = node('td'), contract = node('details')
      identity.append(node('b', tool.id), node('div', tool.service ? 'MCP service: ' + tool.service : tool.origin === 'builtin' ? 'Built into Worker' : 'Tool manifest'))
      contract.append(node('summary', 'View contract'), node('pre', JSON.stringify({ digest: tool.digest, sourceTypes: tool.sourceTypes, params: tool.params, returns: tool.returns }, null, 2)))
      identity.append(contract)
      if (tool.automaticActionProblem) { const warning = node('p', tool.automaticActionProblem); warning.setAttribute('role', 'alert'); identity.append(warning) }
      const controls = node('td'), edit = node('button', tool.origin === 'manifest' ? 'Edit definition' : tool.origin === 'mcp' ? 'Configure service' : 'Built-in settings')
      edit.onclick = () => {
        if (tool.origin === 'manifest') editTool(tool)
        else if (tool.origin === 'mcp') editService(view.services.find(service => service.name === tool.service))
        else { $('builtin-settings').open = true; $('builtin-settings').scrollIntoView({ block: 'center', behavior: 'smooth' }) }
      }
      if (!(shared() && tool.origin !== 'builtin')) controls.append(edit)
      row.append(identity, node('td', tool.adapter + ' · ' + tool.kind),
        node('td', environment ? 'Every Agent here' : tool.configured ? 'Configured for Worker' : 'Disabled locally'), controls)
      $('tool-rows').append(row)
    }
    $('tool-count').textContent = environment ? listed.length + ' tools'
      : view.tools.filter(tool => tool.configured).length + ' configured tools · ' + view.tools.filter(tool => !tool.configured).length + ' disabled built-ins'
  }
  async function refresh() {
    if (environment) {
      view = await api('/worker-tools/state')
      $('used-by').textContent = view.usedBy?.length ? 'Used by: ' + view.usedBy.join(', ') + '.' : 'No Agent here uses this environment’s tools yet.'
      $('keys').replaceChildren()
      for (const entry of view.keys || []) { const row = node('div'); row.className = 'service'; row.append(node('b', entry.name), node('span', ' · ' + entry.type)); $('keys').append(row) }
      if (!(view.keys || []).length) $('keys').textContent = 'No keys yet.'
    } else {
      const [tools, runtime] = await Promise.all([api('/worker-tools/state'), api('/status')])
      view = tools; status = runtime
      $('runtime').textContent = 'Worker: ' + (status.workerSetting?.state || 'offline') + (status.workerSetting?.failure ? ' · ' + status.workerSetting.failure : '')
      $('workspace-mode').value = view.workspaceMode
      const library = view.library !== undefined
      $('library-banner').hidden = !library
      $('library-banner').textContent = library ? 'This Agent uses this environment’s tools. Add or change them under “This environment’s tools” in the Rulith workbench.' + (view.library.notice ? ' ' + view.library.notice : '') : ''
      document.querySelectorAll('[data-panel=add]').forEach(button => { button.hidden = library })
      if (library && !$('add').hidden) panel('inventory')
    }
    $('manifest-path').textContent = view.manifestFile; $('vault-path').textContent = view.vaultFile
    $('services').replaceChildren()
    for (const service of view.services) {
      const card = node('div'); card.className = 'service'
      card.append(node('b', service.name), node('span', ' · ' + Object.keys(service.tools).length + ' selected tools '))
      if (environment && service.directory) card.append(node('small', 'Folder ' + service.directory + ' is shared by every Agent in this environment.'))
      const edit = node('button', 'Configure service'); edit.onclick = () => editService(service)
      const remove = node('button', 'Remove local service'); remove.dataset.mutation = ''
      remove.onclick = () => {
        const revision = view.revision
        reviewChange('Remove ' + service.name + '?', 'Remove this service and its tools.', async () => {
        const result = await api('/mcp-services/remove', { name: service.name, ...(environment ? { revision, confirmed: true } : {}) }); await refresh(); say(result.teaching + reach(result))
      })
      }
      if (!shared()) card.append(edit, remove)
      $('services').append(card)
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
    mcp: { adapter: 'mcp', sourceTypes: ['mcp'], entry: 'tool_name', kind: 'read', params: {}, returns: [] },
    workspace: { adapter: 'workspace', sourceTypes: ['file'], entry: 'read_text' },
  }
  if (!environment) templates.run = { adapter: 'run', sourceTypes: [], entry: 'adapters/tool.mjs', kind: 'run', params: {}, returns: [] }
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
      if (tool.groundedWriteProblem) description.append(node('p', tool.groundedWriteProblem))
      else if (Object.values(tool.params || {}).includes('json?')) description.append(node('p', 'For grounded write/run Actions, optional JSON inputs must be omitted or supplied as trusted scalar values. Objects, arrays and null cannot be grounded.'))
      const kind = node('select'); kind.setAttribute('aria-label', 'Operation for ' + tool.name)
      for (const value of ['', 'read', 'write', 'run']) { const option = node('option', value || 'Choose…'); option.value = value;
        option.disabled = !!tool.groundedWriteProblem && ['write', 'run'].includes(value); kind.append(option) }
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
  $('tool-search').oninput = renderTools; $('tool-origin').onchange = renderTools
  $('adapter-template').onchange = () => { $('tool-definition').value = JSON.stringify(templates[$('adapter-template').value], null, 2) }
  $('manual-form').onsubmit = event => { event.preventDefault();
    let definition
    try { definition = JSON.parse($('tool-definition').value) } catch { say('Enter a valid JSON tool definition before reviewing it.', true); return }
    const body = { id: $('tool-id').value, originalId: originalToolId, definition, revision: originalToolRevision }
    reviewChange('Save ' + body.id + '?', JSON.stringify(definition, null, 2), async () => {
      const result = await api('/worker-tools/save', { ...body, ...(environment ? { confirmed: true } : {}) })
      await refresh(); panel('inventory'); say(result.teaching + reach(result))
    })
  }
  $('remove-tool').onclick = () => {
    const body = { id: originalToolId, revision: originalToolRevision }
    reviewChange('Remove ' + body.id + '?', 'Remove this tool definition.', async () => {
      const result = await api('/worker-tools/remove', { ...body, ...(environment ? { confirmed: true } : {}) }); await refresh(); panel('inventory'); say(result.teaching + reach(result))
    })
  }
  if (!environment) {
    // These belong to the Agent whose page this is: its own Worker, and its own file-tool mode.
    $('worker-setting').onchange = () => action('Saving local tools setting…', async () => {
      const result = await api('/worker-setting', { enabled: $('worker-setting').checked }); await refresh(); say(result.teaching)
    })
    $('refresh').onclick = () => action('Refreshing configuration…', async () => { await refresh(); say('Configuration refreshed.') })
    $('workspace-save').onclick = () => action('Saving built-in workspace mode…', async () => {
      const result = await api('/worker-tools/workspace', { mode: $('workspace-mode').value, revision: view.revision }); await refresh(); say(result.teaching)
    })
  }
  $('template-use').onclick = () => { addMode('mcp'); resetService('filesystem'); $('service-title').textContent = 'Filesystem template' }
  $('mode').onchange = () => { $('env').value = ''; $('token').value = ''; fields() }
  $('config').oninput = () => { probeId = ''; $('discovery').hidden = true }
  $('config').onsubmit = event => { event.preventDefault(); action('Configuring and discovering tools…', async () => {
    if ($('mode').value === 'filesystem') await api('/mcp-services/install', { catalogId: 'filesystem' })
    await discover()
  }) }
  $('save').onclick = () => {
    const tools = [...$('tools').children].filter(row => row.querySelector('input').checked).map(row => ({ name: row.dataset.tool, kind: row.querySelector('select').value }))
    const body = { probeId, tools }
    const mode = $('mode').value
    const launch = { name: $('name').value, mode,
      ...(mode === 'stdio' ? { command: $('command').value, args: $('args').value, cwd: $('cwd').value }
        : mode === 'filesystem' ? { directory: $('directory').value }
          : mode === 'registry' ? { installation: $('registry-configured').textContent }
            : { url: $('url').value }) }
    reviewChange('Save ' + launch.name + '?', JSON.stringify({ ...launch, tools }, null, 2), async () => {
      const result = await api('/mcp-services/apply', { ...body, ...(environment ? { confirmed: true } : {}) }); probeId = ''; preparationId = ''
      await refresh(); editService(result.service); say(result.teaching + reach(result))
    })
  }
  $('download').onclick = () => {
    if (!downloadService) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(downloadService.definition, null, 2) + '\n'], { type: 'application/json' }))
    const anchor = node('a'); anchor.href = url; anchor.download = downloadService.name + '-source.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  panel('inventory'); refresh().catch(error => say(error.message, true))
}
