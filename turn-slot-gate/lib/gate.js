/**
 * dsh-turn-slot-gate —— 闸门状态机（不依赖 cordis，可单独测试）
 *
 * 职责范围：记住「本回合有没有写类工具调用」「本回合最后一段交付文本」
 * 「这个回合已经被拦过几次」，并在回合收尾时给一个决定。
 *
 * 它**不做**的事：不读会话日志（`Session.eventAt` / `snapshotEvents` 已废弃）、
 * 不判断文本内容的真假、不留痕、不碰 steer 的调用方式——那些留在 `wire.js`
 * 与 `index.js` 里，由宿主上下文完成。这样状态机可以只喂合成事件来测。
 */

import { buildNudge, extractAssistantText, hasCompleteSlots, parseSlots } from './slots.js';

/**
 * 默认被视为「改动了东西」的工具。
 *
 * 刻意不含 `bash`：从工具名和参数无法可靠区分 `cat` 和 `rm`，把 bash 算进来
 * 会让「只读了一下」也触发闸门。宁可漏拦，不可误拦——这是规格 #32 定下的
 * 取舍方向。
 */
export const DEFAULT_WRITE_TOOLS = Object.freeze(['write', 'edit', 'apply_patch']);

/**
 * @typedef {object} TurnState
 * @property {number} turn 回合号
 * @property {boolean} hadWrite 本回合是否出现过写类工具调用
 * @property {string} lastText 本回合最后一段非空 assistant 文本
 * @property {number} strikes 本回合已经被拦过的次数
 */

/**
 * @typedef {object} Decision
 * @property {'allow' | 'steer'} action 放行还是拦回
 * @property {string} [text] 拦回时要注入的提醒
 * @property {string[]} [gapKeys] 缺失/为空的栏位 key（拦回与超限放行都带）
 * @property {number} [strikes] 超限放行时已经拦过的次数
 * @property {string} [reason] 放行原因，用于测试与留痕
 */

export class TurnGate {
  /**
   * @param {{ writeTools?: string[], maxRetries?: number }} [options]
   */
  constructor(options = {}) {
    const writeTools = Array.isArray(options.writeTools) && options.writeTools.length > 0
      ? options.writeTools
      : DEFAULT_WRITE_TOOLS;
    this.writeTools = new Set(writeTools);
    this.maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0 ? options.maxRetries : 1;
    /** @type {Map<string, TurnState>} sessionId → 该会话当前回合的状态 */
    this.bySession = new Map();
  }

  /**
   * 取（必要时新建）某会话当前回合的状态。
   * @param {string} sessionId 会话 id
   * @param {number} turn 回合号
   * @returns {TurnState} 该回合的状态
   */
  #stateFor(sessionId, turn) {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined && existing.turn === turn) return existing;
    const fresh = { turn, hadWrite: false, lastText: '', strikes: 0 };
    this.bySession.set(sessionId, fresh);
    return fresh;
  }

  /**
   * 消费一条会话事件。只关心四类：回合开始、工具调用、assistant 文本、回合结束。
   * @param {string} sessionId 会话 id
   * @param {{ type: string, data?: any }} event 会话事件
   * @returns {void}
   */
  observe(sessionId, event) {
    const type = event?.type;
    const data = event?.data;

    if (type === 'turn/start') {
      const turn = typeof data?.turn === 'number' ? data.turn : 0;
      this.bySession.set(sessionId, { turn, hadWrite: false, lastText: '', strikes: 0 });
      return;
    }

    if (type === 'tool/call') {
      const turn = typeof data?.turn === 'number' ? data.turn : 0;
      const state = this.#stateFor(sessionId, turn);
      if (typeof data?.name === 'string' && this.writeTools.has(data.name)) state.hadWrite = true;
      return;
    }

    if (type === 'assistant/message') {
      const turn = typeof data?.turn === 'number' ? data.turn : 0;
      const state = this.#stateFor(sessionId, turn);
      const text = extractAssistantText(data?.message);
      if (text.trim().length > 0) state.lastText = text;
      return;
    }

    if (type === 'turn/end') {
      // 回合真的结束了才丢状态；turn-stopping 在 turn/end 之前触发。
      this.bySession.delete(sessionId);
    }
  }

  /**
   * 回合收尾时给出决定。
   *
   * 顺序有意如此：先看有没有改动（没改动就不管），再看槽位全不全（全就放行），
   * 最后看还剩不剩重试额度。额度耗尽时放行——闸门永远不允许把回合卡死在这里，
   * 而留痕由调用方根据 `reason === 'exhausted'` 与带回的字段去做。
   *
   * @param {string} sessionId 会话 id
   * @param {number} turn 回合号
   * @returns {Decision} 放行或拦回
   */
  decide(sessionId, turn) {
    const state = this.bySession.get(sessionId);
    if (state === undefined || state.turn !== turn) {
      return { action: 'allow', reason: 'no-state' };
    }

    if (!state.hadWrite) {
      return { action: 'allow', reason: 'no-write' };
    }

    if (hasCompleteSlots(state.lastText)) {
      return { action: 'allow', reason: 'compliant' };
    }

    const gaps = parseSlots(state.lastText);
    const gapKeys = [...gaps.missing, ...gaps.empty];

    if (state.strikes >= this.maxRetries) {
      return { action: 'allow', reason: 'exhausted', gapKeys, strikes: state.strikes };
    }

    state.strikes += 1;
    return {
      action: 'steer',
      text: buildNudge(gaps),
      gapKeys,
      reason: 'gaps',
    };
  }

  /**
   * 丢弃某会话的状态（会话结束时调用，避免 Map 泄漏）。
   * @param {string} sessionId 会话 id
   * @returns {void}
   */
  forget(sessionId) {
    this.bySession.delete(sessionId);
  }
}
