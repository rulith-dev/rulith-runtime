// SPDX-License-Identifier: Apache-2.0
/** Embedded by the Local page; all directory text is rendered through textContent. */
export function attachRegistryBrowser({ $, node, api, action, onPrepared, isBlocked, sourceName, autoLoad = true }) {
  let query = '', cursor = '', selected = null, searching = false
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
  function inputs() {
    const option = selected.options.find(option => option.id === $('registry-option').value)
    $('registry-inputs').replaceChildren()
    $('registry-limits').textContent = option?.unsupported || (option?.remote
      ? 'Static header credentials are supported. Services requiring an interactive OAuth sign-in need manual setup.'
      : 'Installs this exact version locally with npm lifecycle scripts disabled. Discovery will start its program on your computer.')
    prepare.textContent = option?.remote ? 'Connect and discover tools' : 'Install and discover tools'
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
      $('registry-links').replaceChildren()
      if (selected.repository) $('registry-links').append(externalLink('Source repository ↗', selected.repository))
      if (selected.website) $('registry-links').append(externalLink('Publisher website ↗', selected.website))
      $('registry-option').replaceChildren()
      for (const item of selected.options) { const option = node('option', item.label + (item.unsupported ? ' — manual setup' : '')); option.value = item.id; $('registry-option').append(option) }
      const supported = selected.options.find(option => !option.unsupported)
      if (supported) $('registry-option').value = supported.id
      inputs()
      $('registry-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
    updateButtons()
  }
  async function search(more = false) {
    if (searching) return
    searching = true; updateButtons()
    if (!more) { query = $('registry-query').value.trim(); cursor = ''; $('registry-results').replaceChildren(); $('registry-detail').hidden = true; selected = null }
    $('registry-status').textContent = 'Searching the official MCP Registry…'
    try {
      const result = await api('/mcp-services/search?' + new URLSearchParams({ q: query, cursor }))
      for (const server of result.servers) {
        const card = node('div'); card.className = 'directory-card'
        card.append(node('b', server.title), node('div', server.name), node('p', server.description), node('small', server.formats.join(' · ') + ' · ' + server.status))
        const button = node('button', 'Details and setup'); button.onclick = () => detail(server); card.append(button)
        $('registry-results').append(card)
      }
      cursor = result.nextCursor
      $('registry-status').textContent = $('registry-results').children.length ? 'Results from the official MCP Registry. Search matches server names.' : 'No matching services. Try a server name such as filesystem, memory or time.'
    } catch (error) { $('registry-status').textContent = error.message }
    finally { searching = false; $('registry-more').hidden = !cursor; updateButtons() }
  }
  $('registry-search').onsubmit = event => { event.preventDefault(); search() }
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
