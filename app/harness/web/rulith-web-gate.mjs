// Rulith's three tools and registered read-only web tools; delegation is disabled.
import fs from 'node:fs';
import { ADDENDUM as HEADLESS_ADDENDUM } from '../rulith-gate.mjs';
import { installSubagentAdmission } from '../subagents.mjs';
import { forDeployment, installWebFetchGuard } from '../web-tools.mjs';

export const name = 'rulith-web-gate';
export const inject = ['tools', 'agents', 'systemPrompt'];
export const ADDENDUM = HEADLESS_ADDENDUM;

export function installGate(ctx, persona) {
  // Without a search key web_search is not registered, so the addendum offers only web_fetch (forDeployment).
  ctx.systemPrompt.section({ name: 'rulith:persona', order: 0, text: `${persona}\n\n${forDeployment(ADDENDUM)}`, interpolate: false, complete: true });
  installWebFetchGuard(ctx);
  installSubagentAdmission(ctx);
}

export function apply(ctx, config = {}) {
  if (!config.persona) throw new Error('approved persona required');
  const persona = fs.readFileSync(config.persona, 'utf8');
  // complete: no other prompt section may add unapproved model text.
  installGate(ctx, persona);
}
