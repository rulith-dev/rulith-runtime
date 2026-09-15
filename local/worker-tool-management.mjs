// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { configuredWorkerTools, workerToolDescriptor, builtinWorkspaceTools, builtinSourceTools } from '../worker/rulith-worker.mjs'
import { automaticActionProblem } from './mcp-services.mjs'

const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const atomicJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = file + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(temporary, file) }
  finally { rmSync(temporary, { force: true }) }
}

/** 统一清单不创造第二套执行权限：只编辑部署输入，实际广告、锁定和执行仍由原 Worker/Core 路径决定。 */
export function createWorkerToolManagement({ mcpServices, workerContext, setWorkspaceMode }) {
  const load = () => {
    const { environment, directory } = workerContext()
    const inputs = mcpServices.projectWorkerInputs(environment, directory)
    const workspaceMode = String(environment.RULITH_WORKSPACE_TOOLS ?? 'read').trim()
    const tools = configuredWorkerTools(inputs.manifest, workspaceMode)
    const services = mcpServices.overview().services
    const revision = revisionOf({ manifest: inputs.originalManifest, managed: services, workspaceMode,
      file: inputs.originalTools, vaultFile: inputs.originalVault })
    return { ...inputs, workspaceMode, tools, services, revision }
  }
  const checked = revision => {
    const state = load()
    if (!revision || revision !== state.revision) throw new Error('Worker tool configuration changed. Refresh and review it before saving.')
    return state
  }
  const validateManifest = (state, manifest, mode = state.workspaceMode) => {
    const merged = structuredClone(manifest)
    for (const service of state.services) for (const [id, definition] of Object.entries(service.tools)) {
      if (Object.hasOwn(merged.tools, id)) throw new Error('This Tool belongs to an MCP service. Configure its tool selection instead.')
      merged.tools[id] = definition
    }
    configuredWorkerTools(merged, mode)
  }
  return {
    overview() {
      const state = load()
      const managed = new Map(state.services.flatMap(service => Object.keys(service.tools).map(id => [id, service.name])))
      const builtins = { ...builtinWorkspaceTools('read-write'), ...builtinSourceTools() }
      const rows = Object.entries(state.tools).map(([id, definition]) => ({ ...workerToolDescriptor(id, definition),
        adapter: definition.adapter, origin: managed.has(id) ? 'mcp' : Object.hasOwn(state.originalManifest.tools, id) ? 'manifest' : 'builtin',
        service: managed.get(id), configured: true,
        ...(Object.hasOwn(state.originalManifest.tools, id) ? { definition: state.originalManifest.tools[id] } : {}) }))
      // 关闭的内置工具仍可找到，但必须明确它们不会出现在本次配置的 Worker 广告中。
      for (const [id, definition] of Object.entries(builtins)) if (!Object.hasOwn(state.tools, id)) rows.push({
        ...workerToolDescriptor(id, definition), adapter: definition.adapter, origin: 'builtin', configured: false })
      return { tools: rows.map(tool => ({ ...tool, automaticActionProblem: automaticActionProblem(tool.kind, tool.params) })), revision: state.revision, workspaceMode: state.workspaceMode,
        manifestFile: state.originalTools, vaultFile: state.originalVault,
        sources: Object.entries(state.vault).map(([name, source]) => ({ name, type: typeof source?.type === 'string' ? source.type : 'configured locally' })),
        services: state.services, presets: mcpServices.overview().catalog }
    },
    save({ id, originalId, definition, revision }) {
      const state = checked(revision), manifest = structuredClone(state.originalManifest)
      if (originalId !== undefined ? originalId !== id || !Object.hasOwn(manifest.tools, id) : Object.hasOwn(manifest.tools, id)) {
        throw new Error('Keep the existing Tool ID when editing, or choose an unused ID when adding a Tool.')
      }
      // Object.fromEntries avoids treating special object keys as assignment instructions.
      manifest.tools = Object.fromEntries([...Object.entries(manifest.tools).filter(([key]) => key !== id), [id, definition]])
      validateManifest(state, manifest)
      atomicJson(state.originalTools, manifest)
      return { teaching: 'Tool definition saved locally. Start Worker to load it, then review and lock its contract in Console.' }
    },
    remove({ id, revision }) {
      const state = checked(revision), manifest = structuredClone(state.originalManifest)
      if (!Object.hasOwn(manifest.tools, id)) throw new Error('Only manifest tools can be removed here. Configure built-ins or the owning MCP service instead.')
      delete manifest.tools[id]
      validateManifest(state, manifest)
      atomicJson(state.originalTools, manifest)
      return { teaching: 'Tool removed from the local manifest. Cloud grants and historical receipts remain managed in Console.' }
    },
    workspace({ mode, revision }) {
      if (!['off', 'read', 'read-write'].includes(mode)) throw new Error('Choose off, read, or read-write for workspace tools.')
      const state = checked(revision)
      validateManifest(state, state.originalManifest, mode)
      setWorkspaceMode(mode)
      return { teaching: 'Workspace tool mode saved. Start Worker to load it; this does not grant the Agent permission.' }
    },
  }
}
