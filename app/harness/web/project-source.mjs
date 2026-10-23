// A conversation's workspace is its project. This is harness context, not Board state or a grant of access.
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SOURCE = 'rulith-project';
const normalized = (directory, platform) => {
  if (typeof directory !== 'string' || !directory) return null;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const value = directory.replace(/\\/g, '/');
  if (!paths.isAbsolute(value)) return null;
  const canonical = paths.normalize(value).replace(/\\/g, '/');
  const root = paths.parse(canonical).root.replace(/\\/g, '/');
  const trimmed = canonical.length > root.length ? canonical.replace(/\/+$/, '') : canonical;
  return platform === 'win32' ? trimmed.toLowerCase() : trimmed;
};

/** Most specific approved file Source containing this workspace; prefix siblings are not descendants. */
export function resolveProject(workspace, sources, platform = process.platform) {
  const cwd = normalized(workspace, platform);
  if (!cwd) return null;
  let match = null, depth = -1;
  for (const source of sources) {
    if (source?.type !== 'file' || typeof source.name !== 'string' || !source.name) continue;
    const directory = normalized(source.location, platform);
    if (!directory || !(cwd === directory || cwd.startsWith(directory.endsWith('/') ? directory : directory + '/'))) continue;
    if (directory.length > depth) { match = { name: source.name, directory: source.location }; depth = directory.length; }
  }
  return match;
}

export function projectLine(workspace, project) {
  return project
    ? `This conversation's project is Source "${project.name}" (${project.directory}). Use source "${project.name}" for project files unless the user names another approved project.`
    : `This workspace (${workspace}) is not an approved Rulith project; project file Actions cannot reach it until the owner opens it as a project in Deep Rulith (Agents with the official engineering capability) or adds it in Console (other Agents).`;
}

/** Reuse the Worker's existing read channel; neither credentials nor arbitrary response fields leave this reader. */
export async function readSourceBindings(env, fetchImpl = fetch) {
  if (!env.RULITH_WORK_URL || !env.RULITH_CONNECTION || !env.RULITH_CONNECTION_KEY) throw new Error('Worker Source read is not configured');
  const response = await fetchImpl(`${env.RULITH_WORK_URL}/sources`, { signal: AbortSignal.timeout(10_000), redirect: 'error',
    headers: { 'x-rulith-connection': env.RULITH_CONNECTION, 'x-rulith-connection-key': env.RULITH_CONNECTION_KEY } });
  if (!response.ok) throw new Error(`Worker Source read answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.sources)) throw new Error('Worker Source list is unreadable');
  return body.sources.filter((source) => typeof source?.name === 'string')
    .map((source) => ({ name: source.name, type: String(source.type ?? ''), location: String(source.access ?? '') }));
}

/** Keep one identified context message on the model surface, including across turns, resume and Source changes.
 * Originals stay in the person's log. Only our own context is replaced, through dsh's existing surface mechanism.
 */
export function reconcileProjectContext(session, line) {
  let retained = false;
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq);
    if (event?.type !== 'user/message' || event.data?.source?.kind !== SOURCE) continue;
    const text = retained || !line ? '' : line;
    if (text) retained = true;
    if (event.data.content.length === 1 && event.data.content[0]?.type === 'text' && event.data.content[0].text === text) continue;
    session.append('user/message', { ...event.data, content: [{ type: 'text', text }],
      source: { kind: SOURCE, form: 'snapshot', sections: text ? [{ name: 'rulith:project', text }] : [] } }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq],
    });
  }
  return retained;
}

/** Per-step admission uses the conversation's cwd, never the host process's cwd. Read failures carry no model text. */
export function installProjectContext(ctx, sourcesForConversation) {
  ctx.on('agent/pre-step', async ({ agent, step }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !agent?.session) return decision;
    const session = agent.session;
    const workspace = session.header?.cwd;
    let line = '';
    try {
      if (!workspace) throw new Error('conversation workspace is unavailable');
      const sources = await sourcesForConversation(agent);
      line = projectLine(workspace, resolveProject(workspace, sources));
    } catch {
      // Fetch errors can contain addresses or credentials. The visible diagnosis deliberately contains neither.
      console.error('[rulith project] Sources cannot be read or the conversation workspace is unavailable; project context omitted');
    }
    if (reconcileProjectContext(session, line) || !line || (!decision.messages.length && step <= 1)) return decision;
    return { ...decision, messages: [...decision.messages, { id: randomUUID(), role: 'user',
      content: [{ type: 'text', text: line }], source: { kind: SOURCE, form: 'snapshot', sections: [{ name: 'rulith:project', text: line }] } }] };
  });
}
