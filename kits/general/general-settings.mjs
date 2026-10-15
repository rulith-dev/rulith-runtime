import path from 'node:path';
import { readJson, refuse } from './lib.mjs';

export function generalSettings(home) {
  const s = readJson(path.join(home, 'settings.json'), {});
  if (!s || typeof s !== 'object' || Array.isArray(s)) refuse('settings refused');
  const number = (name, fallback, max) => {
    const value = s[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) refuse('settings refused');
    return value;
  };
  const webSearch = s.webSearch;
  if (webSearch !== undefined && (!webSearch || Array.isArray(webSearch)
    || Object.keys(webSearch).some(k => !['provider', 'keyEnv'].includes(k))
    || webSearch.provider !== 'deepseek' || typeof webSearch.keyEnv !== 'string'
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(webSearch.keyEnv) || /^RULITH_/i.test(webSearch.keyEnv))) refuse('settings refused');
  return {
    imageMaxBytes: number('imageMaxBytes', 5 * 1024 * 1024, 20 * 1024 * 1024),
    webMaxBytes: number('webMaxBytes', 1024 * 1024, 8 * 1024 * 1024),
    webTimeoutSeconds: number('webTimeoutSeconds', 20, 120), webSearch,
  };
}
