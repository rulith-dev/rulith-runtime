// Admission is on dsh's Agent creation boundary, before either driver can run a child.
// It also covers cold resume; the scope effect releases a reservation on rollback or disposal.
import { TOOLS } from './rulith-mcp.mjs';
import { offeredWebTools } from './web-tools.mjs';
import { createHash } from 'node:crypto';

export const DELEGATION_TOOLS = Object.freeze(['subagent', 'subagent_fork', 'send_message', 'interrupt_agent']);
export const MAX_CHILDREN = 4;
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
/** Every hand has Rulith's three and the registered read-only web tools (D-1015c); only the main agent delegates. */
export const toolsOf = (agent, web = []) => depthOf(agent) ? [...TOOLS, ...web] : [...TOOLS, ...DELEGATION_TOOLS, ...web];

export function installSubagentAdmission(ctx, configure) {
  const children = new Set();
  ctx.on('agent/created', ({ agent }) => {
    const depth = depthOf(agent);
    if (depth > 1) throw new Error('Rulith delegation is limited to depth 1.');
    if (depth && !children.has(agent)) {
      if (children.size >= MAX_CHILDREN) throw new Error('Rulith allows at most 4 active children.');
      children.add(agent);
      agent.ctx.effect(() => () => children.delete(agent));
    }
    agent.ctx.tools.restrict({ allow: toolsOf(agent, offeredWebTools(agent.ctx.tools)) });
    configure?.(agent, depth);
  });
  return children;
}
