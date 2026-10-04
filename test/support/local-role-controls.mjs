// SPDX-License-Identifier: Apache-2.0
// Explicitly start owned fixtures whose subject needs an already-confirmed role identity.
// Production workbench startup is exercised separately in runtime-011-lifecycle.test.mjs.
export async function startFixtureRoles(host, roles = host.roles) {
  for (const role of roles) {
    if (host.status()[role]) continue
    await host.startRole(role)
  }
}

// Ownership/security fixtures need running stand-ins without invoking a model turn.
// These calls stay in process; the corresponding browser endpoints were removed in 0.11.
export async function controlFixtureInstance(instances, id, { role, operation } = {}) {
  if (!['agent', 'worker'].includes(role) || !['start', 'stop'].includes(operation)) {
    throw new Error('Choose an Agent or Worker and a start or stop operation.')
  }
  if (operation === 'start' && !instances.hosts.has(id)) await instances.open(id)
  const host = instances.hosts.get(id)?.host
  if (!host) return { instanceId: id, role, state: 'stopped', stopped: true, results: [] }
  if (!host.roles.includes(role)) throw new Error(`This Agent does not run a local ${role}.`)
  const answer = operation === 'start' ? await host.startRole(role) : await host.stopRole(role)
  const result = { role, status: answer.status, state: answer.body.state || (answer.body.ok ? 'ready' : 'failed'),
    ok: answer.body.ok === true, teaching: answer.body.teaching || '' }
  if (answer.status === 409 && result.state === 'refused') throw new Error(result.teaching)
  return { instanceId: id, role, ...answer.body, results: [result],
    stopped: operation === 'stop' && result.state === 'stopped', started: operation === 'start' && result.ok }
}

export async function startFixtureInstance(instances, id) {
  await instances.open(id)
  const host = instances.hosts.get(id).host, results = []
  for (const role of host.roles) {
    // Opening an enabled profile already starts its Worker. Reuse that owned child,
    // but wait for its readiness receipt before calling the fixture started.
    if (host.status()[role]) {
      const deadline = Date.now() + 8000
      while (!host.status().ready[role]) {
        if (!host.status()[role] || Date.now() > deadline) throw new Error(`The ${role} fixture did not become ready.`)
        await new Promise(done => setTimeout(done, 20))
      }
      results.push({ role, status: 200, state: 'ready', ok: true, teaching: '' })
      continue
    }
    const answer = await controlFixtureInstance(instances, id, { role, operation: 'start' })
    results.push(...answer.results)
  }
  return { instanceId: id, results, started: results.every(row => row.ok) }
}
