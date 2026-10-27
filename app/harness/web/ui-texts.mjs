// The host's words that reach the person (D-1025b, 2026-10-25): the sentences the app's routes answer with, the folder
// names and isolation status of Settings → Advanced → Diagnosis, the Agent's own working folder in the sidebar, and the
// refusal of a conversation's turn shown in the conversation. One table per language: English is the default and the
// normative text (PSC 0.2.32; docs/ui-texts-english.md lists it with the page's own table in client.js), Chinese a
// rendering for a page whose browser language is Chinese. The page names its language on every request
// (`x-rulith-locale`); the host answers in it, and remembers it for the words it says outside a request (a turn
// refused before anything is sent). Nothing here is shown to the model.
//
// 中文说明：宿主说给人看的话（路由的回答、诊断里的文件夹名与隔离状态、侧栏里智能体自己的工作目录、对话里被拒绝的一轮），
// 每种语言一张表，英文为默认与规范文字，中文在页面语言为中文时使用。页面每个请求都带上自己的语言，宿主照它回答，
// 并记住它，用于请求之外说的话。这里没有模型能看到的文字。

import { AsyncLocalStorage } from 'node:async_hooks';

export const HOST_TEXTS = {
  en: {
    'session.invalid': "This conversation's id is not valid.",
    'manager.incomplete': 'Rulith on this computer did not complete this request ({status}).',
    'conversation.agentNotSetUp': "This conversation's Agent is not set up on this computer yet: choose “Set up on this computer” for it on the left first.",
    'conversation.sharedBoard': "This app is set to keep one record for all conversations (conversationBoards off), so a conversation's exploration mode and review can be changed only in Console.",
    'tree.workspace': 'Workspace',
    'assign.incomplete': 'The request names no conversation or no Agent.',
    'assign.notSetUp': 'This Agent is not set up on this computer yet.',
    'assign.otherAgent': 'This conversation already belongs to another Agent: start a new conversation.',
    'sign.incomplete': "The signing request is incomplete: it lacks the task, the confirmed criteria or this confirmation's request id.",
    'sign.unconfirmed': 'The signature was sent; its result is not confirmed yet.',
    'sign.notThisRequest': 'The answer received does not confirm this signature.',
    'route.pageOnly': 'Only Rulith requests sent by this page are accepted.',
    'route.sessionUnconfirmed': "Rulith could not confirm this page's session.",
    'route.sessionNeeded': "This needs this page's Rulith session.",
    'route.sessionRefused': "This page's Rulith session did not pass the check.",
    'route.unknown': 'There is no such Rulith route.',
    'folder.network': 'This is a network folder (a shared folder or a mapped network drive). Commands on this computer cannot run in it; choose a folder on a local disk.',
    'folder.empty': 'Enter a folder path.',
    'folder.fullWindows': 'Enter the full path, such as D:\\work\\project.',
    'folder.fullPosix': 'Enter the full path, such as /home/you/project.',
    'folder.missing': 'This computer has no such folder: {path}',
    'open.notSignedIn': 'This computer is not signed in to Rulith: sign in at the bottom left first.',
    'open.notInAccount': 'This Agent is not in the signed-in account.',
    'open.notSetUp': 'This Agent is not set up on this computer: choose “Set up on this computer” on the left first.',
    'open.runtimeOld': 'The Rulith Runtime on this computer is too old to open projects: update the Rulith app, then try again.',
    'open.noRequestId': 'This opening has no valid request id; confirm it again.',
    'open.noVersion': 'This opening has no confirmed content version; confirm it again.',
    'open.protectedFolder': 'This folder contains, or is inside, a folder where Rulith keeps its own data (credentials or work files), so it cannot be opened as a project. Choose a folder that holds no Rulith data.',
    'open.unprotectable': 'Rulith could not make this folder writable for isolated model commands: {reason}. Nothing was opened. Choose a folder on an NTFS drive that your account owns.',
    'setup.unknownRequest': 'No setup request was named to look at.',
    'setup.notFinished': "This Agent's setup on this computer did not finish.",
    'setup.inProgress': "This Agent's setup on this computer is still running; try again later.",
    'picker.unavailable': "This computer cannot open the system's folder chooser: type the folder's full path instead.",
    'picker.open': 'The folder chooser is already open: choose a folder or cancel in that window first.',
    'model.unreadable': "Rulith's model settings cannot be read.",
    'model.agentElsewhere': 'This conversation belongs to Agent “{name}”, which is not set up on this computer under the account signed in now (after switching accounts, for example). Nothing was sent: this conversation uses only its own Agent\'s model in its own account. Sign in to that account, or set this Agent up on this computer, then send again.',
    'model.notSet': "The signed-in account has not set a model for this conversation's Agent yet: set one under Model in Settings; it applies from the next turn.",
    'model.notSignedIn': 'This computer is not signed in to Rulith yet: sign in under Account in Settings first.',
    'model.accountChanged': 'The signed-in account just changed: open the model settings again, then save.',
    'model.chooseAgent': 'Choose an Agent of the account signed in now.',
    'model.agentNotSetUp': 'Set this Agent up on this computer first, then give it a model of its own.',
    'model.chooseSource': "Choose whether to use the account's model or this Agent's own.",
    'model.defaultsElsewhere': "This app reads the account's model settings from another Rulith folder (modelHome); change them there.",
    'isolation.unavailable': "Not available on this platform yet: model commands run with your account's access.",
    'isolation.linuxOn': "On: model commands run under bubblewrap, with Rulith's own folders hidden.",
    'isolation.noBwrap': 'Bubblewrap (bwrap) is not installed: model commands are refused until it is.',
    'isolation.refusingOne': 'Model commands are refused: {roots} is not read-protected. Restart Rulith to protect it again.',
    'isolation.refusingMany': 'Model commands are refused: {roots} are not read-protected. Restart Rulith to protect them again.',
    'isolation.windowsOn': "On: model commands run at low integrity and cannot read Rulith's own folders.",
    'isolation.offFor': '{status} Turned off for {agents} (RULITH_ADAPTER_SANDBOX=off; not recommended).',
    'isolation.pendingFor': '{status} For {agents} it applies after the Worker restarts, once the commands it is running finish.',
    'isolation.incomplete': 'The request does not say which Agent, or whether its model commands run without isolation.',
    'isolation.unconfirmed': 'Running model commands without isolation needs your confirmation. Nothing was changed.',
    'review.incomplete': 'The request does not say which Agent, or what to set for its review.',
    'review.notHere': 'This Agent is not set up on this computer, so this computer cannot review for it: choose “Set up on this computer” for it first. Nothing was changed.',
    'review.deadline': 'The review deadline is a whole number of seconds from 60 to 300.',
    'folders.files': 'Rulith files',
    'folders.manager': 'Local manager',
    'folders.conversations': 'Conversations (DeepSeek Harness)',
    'folders.logs': 'Logs',
    'folders.kit': 'General kit settings',
    'folders.work': 'Model command work area',
  },
  zh: {
    'session.invalid': '会话标识无效。',
    'manager.incomplete': '本机 Rulith 没有完成这个请求（{status}）。',
    'conversation.agentNotSetUp': '这个会话的智能体还没有在这台电脑上设置好：先在左侧为它「在本机设置」。',
    'conversation.sharedBoard': '这个应用设置成所有会话共用一份记录（conversationBoards 关闭），会话的档位和审查只能在 Console 里改。',
    'tree.workspace': '工作台',
    'assign.incomplete': '请求里缺少会话或智能体。',
    'assign.notSetUp': '这个智能体还没有在这台电脑上设置好。',
    'assign.otherAgent': '这个会话已经属于另一个智能体：请开一个新会话。',
    'sign.incomplete': '签字请求不完整：缺少任务、确认过的标准或这次确认的请求号。',
    'sign.unconfirmed': '签字已经发出，结果还没有确认。',
    'sign.notThisRequest': '收到的回答不能确认这次签字。',
    'route.pageOnly': '只接受本页发出的 Rulith 请求。',
    'route.sessionUnconfirmed': 'Rulith 确认不了本页的会话凭据。',
    'route.sessionNeeded': '这需要本页的 Rulith 会话凭据。',
    'route.sessionRefused': '本页的 Rulith 会话凭据没有通过检查。',
    'route.unknown': '没有这个 Rulith 接口。',
    'folder.network': '这是网络上的文件夹（共享文件夹或映射的网络盘）。在这台电脑上运行命令时不能把它当作工作目录，请选本机磁盘上的文件夹。',
    'folder.empty': '请填写一个文件夹路径。',
    'folder.fullWindows': '请填写完整路径，例如 D:\\work\\project。',
    'folder.fullPosix': '请填写完整路径，例如 /home/you/project。',
    'folder.missing': '这台电脑上没有这个文件夹：{path}',
    'open.notSignedIn': '这台电脑没有登录 Rulith：先在左下角登录。',
    'open.notInAccount': '这个智能体不在当前登录的账户里。',
    'open.notSetUp': '这个智能体还没有在这台电脑上设置：先在左侧点「在本机设置」。',
    'open.runtimeOld': '这台电脑上的 Rulith Runtime 版本太旧，还不能打开项目：请更新 Rulith 应用后再试。',
    'open.noRequestId': '这次打开缺少有效的请求号，请重新确认。',
    'open.noVersion': '这次打开缺少确认过的内容版本，请重新确认。',
    'open.protectedFolder': '这个文件夹包含或位于 Rulith 存放自己数据（凭据或工作文件）的目录里，不能作为项目打开。请选一个不含 Rulith 数据的文件夹。',
    'open.unprotectable': 'Rulith 没能让这个文件夹对隔离的模型命令可写：{reason}。什么都没有打开。请选一个你的账户拥有的 NTFS 磁盘上的文件夹。',
    'setup.unknownRequest': '缺少要查看的设置请求。',
    'setup.notFinished': '这个智能体在这台电脑上的设置没有完成。',
    'setup.inProgress': '这个智能体在这台电脑上的设置还在进行，稍后再试。',
    'picker.unavailable': '这台电脑上打不开系统的选择文件夹窗口：请手动输入文件夹的完整路径。',
    'picker.open': '选择文件夹的窗口已经开着：先在那个窗口里选好或取消。',
    'model.unreadable': '读不到 Rulith 的模型设置。',
    'model.agentElsewhere': '这个会话属于智能体「{name}」，它没有以现在登录的账户在这台电脑上设置（例如换了账户之后）。什么都没有发出：这个会话只用它自己的智能体在它自己账户里的模型。请登录那个账户，或在这台电脑上设置这个智能体，再发一次。',
    'model.notSet': '现在登录的账户还没有为这个会话的智能体设置模型：在设置的「模型」里设置，从下一轮起生效。',
    'model.notSignedIn': '这台电脑还没有登录 Rulith：先在设置的「账户」里登录。',
    'model.accountChanged': '登录的账户刚才变了：请重新打开模型设置再保存。',
    'model.chooseAgent': '请选一个现在登录的账户里的智能体。',
    'model.agentNotSetUp': '先在这台电脑上设置好这个智能体，再给它单独设模型。',
    'model.chooseSource': '请选择用账户的模型，还是这个智能体自己的模型。',
    'model.defaultsElsewhere': '这个应用读的是另一个 Rulith 目录里的账户模型设置（modelHome），请到那里修改。',
    'isolation.unavailable': '这个平台上还没有：模型命令以你账户的权限运行。',
    'isolation.linuxOn': '已开启：模型命令在 bubblewrap 里运行，看不到 Rulith 自己的文件夹。',
    'isolation.noBwrap': '没有安装 Bubblewrap（bwrap）：装好之前，模型命令一律拒绝。',
    'isolation.refusingOne': '模型命令一律拒绝：{roots} 没有读保护。重启 Rulith 会重新保护它。',
    'isolation.refusingMany': '模型命令一律拒绝：{roots} 没有读保护。重启 Rulith 会重新保护它们。',
    'isolation.windowsOn': '已开启：模型命令以低完整性级别运行，读不到 Rulith 自己的文件夹。',
    'isolation.offFor': '{status}已为 {agents} 关闭（RULITH_ADAPTER_SANDBOX=off，不建议）。',
    'isolation.pendingFor': '{status}对 {agents} 要等它在这台电脑上重新开启后才生效（手头的命令结束后）。',
    'isolation.incomplete': '请求里没有说是哪个智能体，或它的模型命令是否不隔离运行。',
    'isolation.unconfirmed': '不隔离运行模型命令需要你的确认。什么都没有改。',
    'review.incomplete': '请求里没有说是哪个智能体，或要怎样设置它的审查。',
    'review.notHere': '这个智能体还没有在这台电脑上设置，这台电脑不能为它审查：先为它「在本机设置」。什么都没有改。',
    'review.deadline': '审查期限是 60 到 300 之间的整数秒。',
    'folders.files': 'Rulith 文件',
    'folders.manager': '本机管理器',
    'folders.conversations': '会话（DeepSeek Harness）',
    'folders.logs': '日志',
    'folders.kit': '通用工具包设置',
    'folders.work': '模型命令工作区',
  },
};

export const LOCALES = Object.freeze(['en', 'zh']);
/** The language a page names (`x-rulith-locale`, or a browser language tag): Chinese for "zh…", else English. Pure. */
export const localeOf = (value) => (/^zh/i.test(String(value ?? '')) ? 'zh' : 'en');

// The language of a request, for everything said while it is handled (inRequestLanguage), and the language of the page
// that last passed the session gate with one, for words said outside a request (a turn refused before anything is sent).
// One person uses one app, so that is the person's language; English until a page names one.
const requestLocale = new AsyncLocalStorage();
let pageLocale = 'en';
/** Remember the language an admitted page names; a request that names none changes nothing. */
export function notePageLocale(value) {
  if (typeof value === 'string' && value.trim()) pageLocale = localeOf(value);
}
/** Run `work` with `locale` as the language of everything said while it runs (one request's handling). */
export const inRequestLanguage = (locale, work) => requestLocale.run(locale === 'zh' ? 'zh' : 'en', work);
/** The language words are said in now: the request's while one is handled, else the page's. */
export const currentLocale = () => requestLocale.getStore() ?? pageLocale;

/** One host text, its `{name}` parts filled in, in `locale` (the current one by default); English where a key is missing. */
export function say(key, values = {}, locale = currentLocale()) {
  const template = HOST_TEXTS[locale]?.[key] ?? HOST_TEXTS.en[key];
  if (template === undefined) throw new Error(`no host text ${key}`);
  return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

// Whether a sentence is one of the host's own (a rendering of a template above): the page shows those as they are,
// and puts its own sentence before any other reason (a manager's, the Gateway's, a raw error).
const ownPatterns = new Map();
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function isHostText(text, locale = currentLocale()) {
  if (typeof text !== 'string' || !text) return false;
  let patterns = ownPatterns.get(locale);
  if (!patterns) {
    patterns = Object.values(HOST_TEXTS[locale] ?? HOST_TEXTS.en)
      .map((template) => new RegExp('^' + template.split(/\{\w+\}/).map(escapeRegExp).join('[\\s\\S]*') + '$'));
    ownPatterns.set(locale, patterns);
  }
  return patterns.some((pattern) => pattern.test(text));
}
