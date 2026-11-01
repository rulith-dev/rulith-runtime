// The page's sign-in address never reaches inheritable output (batch C, D-1031a; security review 2026-10-31 P1-2).
// dsh prints its page address with the process's launch token (`?token=`): whoever has that address mints the page's
// session cookie, and with it the /rulith/api routes that sign acceptance criteria, open projects and change settings.
// The launcher used to hand dsh its own stdout, so a redirected launcher output (a log file next to a project) held a
// working token that a model command could read. Now the launcher reads dsh's output: it prints the address without the
// token, hides any other token value, and lets dsh open the browser with the full address as before. When no browser is
// opened (--no-open, or a start over SSH), the full address goes to a file in Rulith's own folder, readable by this
// account only, and only that file's path is printed.
//
// 中文说明：页面地址里带着本进程的启动令牌（?token=），拿到它就能换到本页的会话 cookie，进而签字、打开项目、改设置。以前
// 启动器把自己的标准输出直接给 dsh，输出一旦被重定向到项目旁边的文件，模型命令就能读到可用的令牌。现在启动器自己读 dsh
// 的输出：打印不带令牌的地址，其他行里的令牌值也遮住；浏览器仍由 dsh 用完整地址打开。没有打开浏览器时（--no-open，或经
// SSH 启动），完整地址写进 Rulith 自己目录里只有本账户可读的文件，只打印这个文件的路径。
import fs from 'node:fs';
import path from 'node:path';
import { ownerOnly } from './app-home.mjs';

/** The file in Rulith's folder (the app home, or a settings file's dsh home) that holds the full address. */
export const PAGE_ADDRESS_FILE = 'page-address.txt';
const TOKEN = /([?&]token=)[^&\s#]+/g;

/** A line of output with every `token=` query value hidden. Pure. */
export const withoutToken = (line) => String(line).replace(TOKEN, '$1<hidden>');

/** The page's address without its token: what may be printed. Pure. */
export function cleanAddress(url) {
  const address = new URL(url);
  address.searchParams.delete('token');
  return address.href;
}

/**
 * Write the full address to `<folder>/page-address.txt`, readable by this account only (a new file each time: on Windows
 * its inherited access is replaced by this user alone, elsewhere 0600). Returns the file's path.
 */
export function writePageAddress(folder, url) {
  const file = path.join(folder, PAGE_ADDRESS_FILE), next = `${file}.${process.pid}.tmp`;
  // Limited first, filled, then renamed into place (the rename keeps its access list): the file is never seen empty,
  // and never readable by anyone else.
  fs.rmSync(next, { force: true });
  fs.writeFileSync(next, '', { flag: 'wx', mode: 0o600 });
  try {
    ownerOnly(next);
    fs.writeFileSync(next, `${url}\n`);
    fs.renameSync(next, file);
  } finally { fs.rmSync(next, { force: true }); }
  return file;
}

/** Split a stream into lines, one call per line (a last line without a newline included). */
function eachLine(stream, line, end = () => {}) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      line(buffer.slice(0, at).replace(/\r$/, ''));
      buffer = buffer.slice(at + 1);
    }
  });
  stream.on('end', () => { if (buffer) line(buffer.replace(/\r$/, '')); buffer = ''; end(); });
}

/**
 * Relay dsh's standard output and error. dsh announces the page as `dsh web: <address with token>` and, when it opens the
 * browser, says so on the next line; the address is printed without its token, with "opened in your browser" when dsh
 * opened it. Without that line (`noOpen`, or nothing within `settleMs`) the full address is written to `folder` and the
 * file's path is printed. Every other line is printed with any token hidden.
 * @param out - dsh's stdout; @param err - dsh's stderr (optional).
 * @param print - prints one line for the person (stdout); @param printError - one line on stderr.
 * @returns `{ written() }`: the address file this process wrote, or '' (the launcher removes it when it exits).
 */
export function relayDshOutput(out, err, { folder, noOpen = false, print = (line) => console.log(line),
  printError = (line) => console.error(line), settleMs = 1500, writeAddress = writePageAddress } = {}) {
  let pending = null, written = '';
  const settle = (opened) => {
    if (!pending) return;
    const { url, timer } = pending;
    pending = null; clearTimeout(timer);
    const clean = cleanAddress(url);
    if (opened) { print(`Rulith: ${clean} (opened in your browser)`); return; }
    try { written = writeAddress(folder, url); }
    catch (error) {
      print(`Rulith: ${clean} is running, but its sign-in address could not be saved (${error.code ?? 'error'}). Start rulith without --no-open to open it in your browser.`);
      return;
    }
    print(`Rulith: ${clean} is running. To open it, use the address saved in ${written}; it signs a browser in, so keep it to yourself.`);
  };
  eachLine(out, (text) => {
    const announced = /^dsh web: (https?:\/\/\S+)/.exec(text);
    if (announced && /[?&]token=/.test(announced[1])) {
      settle(false);
      pending = { url: announced[1], timer: setTimeout(() => settle(false), settleMs) };
      if (noOpen) settle(false);
      return;
    }
    if (/^dsh web: opening the default browser/.test(text)) { settle(true); return; }
    // dsh logs both lines at once: anything else in between means no browser is being opened.
    settle(false);
    print(withoutToken(text));
  }, () => settle(false));
  if (err) eachLine(err, (text) => printError(withoutToken(text)));
  return { written: () => written };
}
