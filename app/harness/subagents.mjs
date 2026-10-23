// Keep historical child identity readable, but refuse delegation at Agent creation (including cold resume).
import { TOOLS } from './rulith-mcp.mjs';
import { offeredWebTools } from './web-tools.mjs';
import { createHash } from 'node:crypto';

export const DELEGATION_TOOLS = Object.freeze(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent']);
export const depthOf = (agent) => Math.max(agent?.session?.header?.delegationDepth ?? 0, agent?.options?.subagentDepth ?? 0,
  agent?.session?.header?.origin === 'subagent' ? 1 : 0);
// parentSession alone is seed lineage (a user fork), not delegation. Depth is durable on cold resume.
export function conversationKey(agent) {
  const session = agent?.session;
  const id = depthOf(agent) ? session?.header?.parentSession : session?.id;
  if (typeof id !== 'string') throw new Error('Rulith conversation session id refused');
  // Reserve h: so a literal session id cannot alias a digest key.
  if (!id || id.length > 196 || /[^\x21-\x7e]/.test(id) || id.startsWith('h:'))
    return `dsh:h:${createHash('sha256').update(id).digest('hex')}`;
  return `dsh:${id}`;
}
export const handOf = (agent) => depthOf(agent) ? agent.session.id : 'main';
/** Delegation is absent from every app-owned allowlist. */
export const toolsOf = (_agent, web = []) => [...TOOLS, ...web];

export function installSubagentAdmission(ctx, configure) {
  ctx.on('agent/created', ({ agent }) => {
    const depth = depthOf(agent);
    if (depth) throw new Error('Rulith sub-agents are disabled.');
    agent.ctx.tools.restrict({ allow: toolsOf(agent, offeredWebTools(agent.ctx.tools)) });
    configure?.(agent, depth);
  });
}
