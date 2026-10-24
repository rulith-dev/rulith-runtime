// The local client's Chinese texts that PSC 0.2.29 (D-1025a) fixes verbatim, written here independently of the client so
// that the tests compare the shipped strings with the contract, not with themselves. docs/model-visible-changes-batch5.md
// lists the same strings under "PSC 0.2.29 本机客户端文字（逐字）".

// Signing proposed criteria (the local client's rendering of Console Text A, in the vocabulary of design §2).
export const SIGNING = {
  title: '待你签字的验收标准',
  button: '签下这些标准',
  body: '你要把这些标准签为这个任务的验收。它们由智能体提出；签下之后，智能体不能再结束或修改它们，只有在当前状态下每一条都成立，这个任务才算完成。这是你以自己账户做出的决定。',
  accept: '签字',
  cancel: '先不签',
  signed: '已签字。',
  pending: '签字结果还没有确认，稍后会自动刷新。',
  unreadable: '暂时读不到待签字的标准',
  signing: '正在签字…',
  refusedPrefix: '没有签下任何标准：',
  unavailablePrefix: '这些标准现在不能签：',
  truncated: '这个任务的标准太多，这里只列出一部分；请在 Console 里签字。',
  moreInConsole: '还有等签字的任务没有列在这里：请在 Console 里查看。',
  replaced: '签字后会被替换',
  notCriterion: '不能作为验收标准',
  unknownReason: '原因未知，请稍后再试',
  stale: '上一次签字的结果还没有确认，那次签的是之前的标准。',
};
// Why nothing was signed, by the Kernel's refusal code.
export const SIGN_REASONS = {
  unknown_goal: '找不到这个任务',
  goal_ended: '这个任务已经结束',
  goal_paused: '这个任务已暂停',
  contract_fixed: '这个任务的验收标准由能力规定，不用签字',
  leaf_not_proposed: '这些标准已经变了，请看最新的再签',
  criterion_unsupported: '其中有一条不能作为验收标准',
  goal_pending_obligations: '这个任务还有没办完的事，稍后再签',
};

// The tier chip, its menu, the three tiers with their one sentence, and the widening confirmations (the local client's
// rendering of Console Text 9; Console keeps its English).
export const TIER = {
  label: '档位：',
  fresh: '默认',
  unreadable: '读不准',
  mixed: '（不一致）',
  menu: '这个会话的档位 · 收窄立即生效，放宽先确认',
  menuMixed: '这个会话的档位不一致：显示的是其中最严的一档，再选一次即统一',
  menuFresh: '这个会话还没有用过 Rulith：选一档就生效，默认取智能体的档位；放宽先确认',
  accepted: '已受理，还没有生效',
  betweenCalls: '已受理，还没有生效：会在这次调用结束后生效',
  later: '已受理，还没有生效，稍后再看一次',
  notSwitched: '没有切换',
  notAccepted: '这次切换没有被接受',
};
export const MODE_WORDS = { strict: '严格', derived: '推导', non_strict: '宽松' };
export const MODE_HINTS = {
  strict: '写入和运行要先有可信的依据',
  derived: '能从记下的事实推出理由，就可以写入和运行',
  non_strict: '模型给出的命令和参数直接执行；完成仍要你签字验收',
};
export const WIDEN_TEXT = {
  non_strict: {
    title: '切换到宽松档？', accept: '切换到宽松', cancel: '先不切换',
    body: '这个环境的工具在写入和运行时，会接受模型给出的输入，即使这次会话的依据里没有可信的事实支持它们。这样的每一次调用都会在记录里注明：它的输入没有可信的依据。需要你决定的调用不会在你决定之前运行；写入仍只在你授权的位置之内；你没有锁定的工具仍然不能用。你随时可以切换回来。',
  },
  derived: {
    title: '切换到推导档？', accept: '切换到推导', cancel: '先不切换',
    body: '只要模型能从它记在这次会话依据里的事实和规则，推出这次操作和它关键输入的理由，就可以在这个环境的工作区里写入和运行。那些事实不必是可信的证据。需要你决定的调用不会在你决定之前运行；写入仍只在本机的工作区之内。',
  },
};

// Why a tier or review switch was refused, by the code its route returns.
const SWITCH = {
  exploration_control_pending: '这个会话的档位还在收窄，什么都没有改；稍后再试。',
  control_pending: '上一次的设置还没有完成，什么都没有改；稍后再试。',
  agent_call_pending: '智能体手上还有一次调用没有结束或待核对，结束后才能改；什么都没有改。',
  observation_in_progress: '还有一次观察没有结果，有了结果再试；什么都没有改。',
  configuration_unconfirmed: '智能体的设置正在生效，稍后再试；什么都没有改。',
  conversation_ended: '这个会话已删除，不能再改。',
  board_unavailable: '读不到这个会话的记录，什么都没有改；稍后再试。',
  request_conflict: '这次请求和之前的一次冲突了，什么都没有改；请再选一次。',
  exploration_mode_unconfirmed: '读不到这个会话现在的档位，什么都没有改；稍后再试。',
  conversations_unavailable: '会话设置的结果没能确认，请再试一次。',
  device_revoked: '这台电脑的登录已经失效，请在左下角重新登录。',
  device_unauthenticated: '这台电脑的登录已经失效，请在左下角重新登录。',
  unauthenticated: '这台电脑的登录已经失效，请在左下角重新登录。',
  not_authorized: '这台电脑的登录没有被授权使用这个智能体。',
  agent_not_found: '这个智能体现在不可用。',
  not_signed_in: '这台电脑没有登录 Rulith：先在左下角登录。',
  manager_signing_out: '这台电脑正在退出 Rulith 登录，现在不能改。',
  manager_closing: '本机 Rulith 正在关闭，现在不能改。',
};
export const TIER_REFUSALS = { ...SWITCH,
  review_required_by_derived_mode: '先为这个会话打开事后审查，再切到推导档。',
  derived_mode_unavailable: '推导档需要这个智能体有审查员，并允许模型写规则：先在 Console 里为它指定审查员。',
};
export const REVIEW_REFUSALS = { ...SWITCH,
  derived_requires_review: '先把这个会话切出推导档，再关闭事后审查。',
};

/** Every string above, once each, for the document check. */
export const ALL = [...new Set([...Object.values(SIGNING), ...Object.values(SIGN_REASONS), ...Object.values(TIER), ...Object.values(MODE_WORDS),
  ...Object.values(MODE_HINTS), ...Object.values(WIDEN_TEXT).flatMap(Object.values), ...Object.values(TIER_REFUSALS), ...Object.values(REVIEW_REFUSALS)])];
