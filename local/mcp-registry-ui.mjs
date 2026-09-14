// SPDX-License-Identifier: Apache-2.0
/** Embedded by the Local page; all directory text is rendered through textContent. */
export function attachRegistryBrowser({ $, node, api, action, onPrepared, isBlocked, sourceName, autoLoad = true }) {
  let query = '', cursor = '', selected = null, searching = false, servers = []
  const statistics = new Map(), downloadRequests = new Map()
  const prepare = $('registry-prepare')
  const updateButtons = () => {
    $('registry-search-button').disabled = searching
    $('registry-more').disabled = searching
    const option = selected?.options.find(option => option.id === $('registry-option').value)
    prepare.disabled = isBlocked() || !option || !!option.unsupported || selected.status !== 'active'
  }
  const externalLink = (label, url) => {
    const anchor = node('a', label); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noreferrer'; return anchor
  }
  const dateLabel = value => value ? value.slice(0, 10) + ' UTC' : 'Not provided'
  function showDownloads(container, packageName) {
    container.replaceChildren()
    if (!packageName) { container.append(node('div', 'npm downloads: not applicable to this setup option.')); return }
    const stats = statistics.get(packageName)
    container.append(node('div', 'npm package: ' + packageName))
    if (!stats) { container.append(node('div', 'Loading package downloads…')); return }
    if (stats.status !== 'available') { container.append(node('div', 'Package downloads unavailable. This does not mean zero usage.')); return }
    container.append(node('b', stats.downloads.toLocaleString('en-US') + ' package downloads'),
      node('div', stats.start + ' – ' + stats.end + ' · all versions'),
      node('div', 'Fetched ' + stats.fetchedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')),
      externalLink('npm data ↗', stats.source))
  }
  async function loadDownloads(packageNames) {
    await Promise.all([...new Set(packageNames.filter(Boolean))].map(packageName => {
      const old = downloadRequests.get(packageName)
      if (old && Date.now() - old.at < 300_000) return old.promise
      const promise = api('/mcp-services/downloads?' + new URLSearchParams({ package: packageName }))
        .catch(() => ({ status: 'unavailable' })).then(result => { statistics.set(packageName, result) })
      downloadRequests.set(packageName, { promise, at: Date.now() }); return promise
    }))
    renderCards()
    const option = selected?.options.find(option => option.id === $('registry-option').value)
    if (selected) showDownloads($('registry-downloads'), option?.npmPackage)
  }
  function renderCards() {
    const visible = servers.filter(server => !$('registry-supported').checked || server.setup.supported)
    const sort = $('registry-sort').value
    const metric = server => sort === 'downloads' ? statistics.get(server.downloadPackage)?.downloads ?? -1 : server.updatedAt ? Date.parse(server.updatedAt) : -1
    if (sort !== 'directory') visible.sort((a, b) => metric(b) - metric(a))
    $('registry-results').replaceChildren()
    for (const server of visible) {
      const card = node('div'); card.className = 'directory-card'; card.dataset.server = server.name
      card.append(node('b', server.title), node('div', server.name), node('p', server.description),
        node('div', 'Version ' + server.version + ' · Registry status: ' + server.status),
        node('div', 'Declared formats: ' + (server.formats.join(' / ') || 'Not provided')),
        node('div', 'Registry updated: ' + dateLabel(server.updatedAt)))
      const methods = [server.setup.local ? 'Local npm installation' : '', server.setup.remote ? 'Hosted HTTP connection' : ''].filter(Boolean)
      card.append(node('p', server.setup.supported ? methods.join(' / ') : server.status !== 'active' ? 'Setup unavailable: directory status is ' + server.status : 'Manual setup required'))
      if (!server.setup.supported && server.setup.reason) card.append(node('div', server.setup.reason))
      const downloads = node('div'); downloads.className = 'package-downloads'; showDownloads(downloads, server.downloadPackage); card.append(downloads)
      if (server.downloadPackage) card.append(node('div', 'Counts refer to the first supported npm option shown above.'))
      const button = node('button', 'Details and setup'); button.onclick = () => detail(server); card.append(button)
      $('registry-results').append(card)
    }
    $('registry-scope').textContent = 'Showing ' + visible.length + ' of ' + servers.length + ' loaded services. Filters and sorting apply only to loaded results, not the entire directory.'
      + (cursor ? ' Load more to expand the results.' : '')
  }
  function inputs() {
    const option = selected.options.find(option => option.id === $('registry-option').value)
    $('registry-inputs').replaceChildren()
    $('registry-limits').textContent = option?.unsupported || (option?.remote
      ? 'Static header credentials are supported. Services requiring an interactive OAuth sign-in need manual setup.'
      : 'Installs this exact version locally with npm lifecycle scripts disabled. Discovery will start its program on your computer.')
    prepare.textContent = option?.remote ? 'Connect and discover tools' : 'Install and discover tools'
    showDownloads($('registry-downloads'), option?.npmPackage)
    if (option?.npmPackage) void loadDownloads([option.npmPackage])
    if (!option || option.unsupported) { updateButtons(); return }
    for (const field of option.fields) {
      const label = node('label', field.label + (field.required ? ' *' : ' (optional)'))
      let input
      if (field.repeated) input = node('textarea')
      else if (field.choices && !field.secret) {
        input = node('select'); input.append(node('option', ''))
        for (const value of field.choices) { const option = node('option', value); option.value = value; input.append(option) }
      } else { input = node('input'); input.type = field.secret ? 'password' : 'text' }
      input.dataset.registryField = field.id
      input.dataset.repeated = String(field.repeated)
      input.autocomplete = 'off'
      input.required = field.required
      input.value = field.repeated ? '[]' : field.default ?? ''
      label.append(input)
      if (field.description) label.append(node('small', field.description))
      if (field.repeated) label.append(node('small', 'Enter a JSON array of strings.'))
      $('registry-inputs').append(label)
    }
    updateButtons()
  }
  async function detail(server) {
    await action('Loading directory details…', async () => {
      selected = await api('/mcp-services/detail?' + new URLSearchParams({ name: server.name, version: server.version }))
      $('registry-detail').hidden = false
      $('registry-title').textContent = selected.title
      $('registry-identity').textContent = selected.name + ' · ' + selected.version + ' · ' + selected.status
      $('registry-description').textContent = selected.description
      $('registry-dates').textContent = 'Version published: ' + dateLabel(selected.publishedAt) + ' · Registry updated: ' + dateLabel(selected.updatedAt) + '. These are directory timestamps, not repository activity.'
      $('registry-links').replaceChildren()
      if (selected.repository) $('registry-links').append(externalLink('Source repository ↗', selected.repository))
      if (selected.website) $('registry-links').append(externalLink('Publisher website ↗', selected.website))
      $('registry-option').replaceChildren()
      for (const item of selected.options) { const option = node('option', item.label + (item.unsupported ? ' — manual setup' : '')); option.value = item.id; $('registry-option').append(option) }
      const supported = selected.options.find(option => !option.unsupported)
      if (supported) $('registry-option').value = supported.id
      inputs()
      $('result').textContent = 'Details loaded. Review the version, installation option and required configuration.'
      $('registry-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
    updateButtons()
  }
  async function search(more = false) {
    if (searching) return
    searching = true; updateButtons()
    if (!more) { query = $('registry-query').value.trim(); cursor = ''; servers = []; renderCards(); $('registry-detail').hidden = true; selected = null }
    $('registry-status').textContent = 'Searching the official MCP Registry…'
    try {
      const result = await api('/mcp-services/search?' + new URLSearchParams({ q: query, cursor }))
      for (const server of result.servers) if (!servers.some(existing => existing.name === server.name && existing.version === server.version)) servers.push(server)
      cursor = result.nextCursor
      renderCards(); void loadDownloads(result.servers.map(server => server.downloadPackage))
      $('registry-status').textContent = servers.length ? 'Results from the official MCP Registry. Search matches server names.' : 'No matching services. Try a server name such as filesystem, memory or time.'
    } catch (error) { $('registry-status').textContent = error.message }
    finally { searching = false; $('registry-more').hidden = !cursor; updateButtons() }
  }
  $('registry-search').onsubmit = event => { event.preventDefault(); search() }
  $('registry-supported').onchange = renderCards
  $('registry-sort').onchange = renderCards
  $('registry-more').onclick = () => search(true)
  $('registry-option').onchange = inputs
  $('registry-setup').onsubmit = event => {
    event.preventDefault()
    action('Preparing the reviewed directory configuration…', async () => {
      const values = Object.fromEntries([...$('registry-inputs').querySelectorAll('[data-registry-field]')].map(input => [input.dataset.registryField, input.dataset.repeated === 'true' ? JSON.parse(input.value || '[]') : input.value]))
      const name = sourceName?.()
      const result = await api('/mcp-services/prepare', { serverName: selected.name, version: selected.version,
        reviewToken: selected.reviewToken, optionId: $('registry-option').value, values })
      $('registry-inputs').replaceChildren()
      $('registry-detail').hidden = true
      await onPrepared(result, name)
    }).finally(updateButtons)
  }
  if (autoLoad) search()
  return { updateButtons, detail, search }
}
