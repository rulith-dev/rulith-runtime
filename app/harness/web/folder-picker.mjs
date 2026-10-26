// The operating system's folder chooser for 「📂 打开文件夹…」, opened by the app host (design §3.2 打开文件夹): a page
// cannot open a native dialog itself. The chooser is dsh's own directory-picker service (`directoryPicker`, composed
// by the web profile's `directory-picker` row): on Windows the modern IFileOpenDialog in a child process, on macOS
// `osascript … choose folder`, on Linux zenity or KDialog. dsh mounts that native backend only when the person can see
// this computer's display (a loopback-only page, no SSH launch, a display session); otherwise it mounts its "browse"
// backend, and the page falls back to typing the folder's full path. The chosen folder then goes through the same project
// opening as a typed one (open-project.mjs), which refuses a network folder as before; nothing is granted here.
//
// 中文说明：浏览器自己打不开系统的选择文件夹窗口，由宿主进程用 dsh 的 directoryPicker 服务打开（Windows 用
// IFileOpenDialog，macOS 用 osascript，Linux 用 zenity／KDialog）。dsh 只在人看得见这台电脑屏幕时才挂原生实现，
// 否则页面退回手动输入路径。选中的文件夹照常走"打开项目"（网络文件夹照旧拒绝），这里不授予任何权限。

import { say } from './ui-texts.mjs';

/** What the page says when no chooser can be opened here (in the page's language). */
export const pickUnavailable = () => say('picker.unavailable');

/**
 * @param {object} options
 * @param {() => any} options.service - dsh's `directoryPicker` service, or undefined when it is not composed.
 * @param {(line: string) => void} [options.log] - where a failed chooser is reported (no path, no secret).
 */
export function folderPicker({ service = () => undefined, log = (line) => console.error(line) } = {}) {
  let open = false;
  const native = () => {
    try {
      const capability = service()?.capability?.();
      return capability?.kind === 'native' && typeof capability.pick === 'function' ? capability : null;
    } catch { return null; }
  };
  return {
    /** Whether a chooser can be opened on this computer now: `{ available }`. */
    available: () => ({ available: native() !== null }),
    /**
     * Open one chooser and wait for the person: `{ state: 'chosen', path }`, `{ state: 'cancelled' }` (also when the page
     * went away, which closes the chooser), or `{ state: 'unavailable', teaching }`. One chooser at a time.
     */
    pick: async ({ signal } = {}) => {
      const chooser = native();
      if (!chooser) return { state: 'unavailable', teaching: pickUnavailable() };
      if (open) throw Object.assign(new Error(say('picker.open')), { errorCode: 'picker_open' });
      open = true;
      try {
        const chosen = await chooser.pick(signal ?? new AbortController().signal);
        return typeof chosen === 'string' && chosen.trim() ? { state: 'chosen', path: chosen } : { state: 'cancelled' };
      } catch (error) {
        if (signal?.aborted) return { state: 'cancelled' };
        log(`[rulith folder] the folder chooser could not be opened: ${String(error?.message ?? error).slice(0, 200)}`);
        return { state: 'unavailable', teaching: pickUnavailable() };
      } finally { open = false; }
    },
  };
}
