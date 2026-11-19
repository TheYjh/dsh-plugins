/**
 * dsh-turn-slot-gate —— 宿主接线层（不直接 import 宿主包，可脱离宿主测试）
 *
 * 这一层把「事件订阅 + 收尾判定 + 注入提醒 + 留痕」串起来，但所有宿主能力
 * 都通过参数传进来：
 *   - `ctx`：只要有 `on(name, handler)` 的最小接口；
 *   - `steer(agent, text)`：把提醒注入回回合（真实实现见 `lib/index.js`，
 *     它负责把文本包成一条合法 user 消息）；
 *   - `record(note)`：留痕（真实实现见 `lib/index.js`，它把 note 写成会话日志里
 *     的一条 plugin record）。
 *
 * 这样测试可以喂假 ctx 和假 agent，直接断言「steer 有没有被调用、内容是什么」
 * 与「留痕里有没有回合号和缺失栏名」—— 也就是规格要求的对外可观察行为，
 * 而不是插件内部的计数器。
 *
 * `agent/turn-stopping` 是被 `await` 的（宿主在边界上串行等待所有监听器，
 * 然后重新读收件箱），所以监听器可以是 async，注入前需要 await 也没问题。
 */

import { TurnGate } from './gate.js';

/**
 * @typedef {object} RecordNote
 * @property {'exhausted' | 'error'} kind 留痕种类
 * @property {any} [session] 出事的会话（可能为 undefined）
 * @property {number} [turn] 出事的回合号
 * @property {string[]} [missing] 缺失/为空的栏位 key
 * @property {number} [strikes] 已经拦过的次数
 * @property {string} message 给人看的一句话
 */

/**
 * @typedef {object} WireOptions
 * @property {boolean} enabled 总开关
 * @property {string[]} writeTools 写类工具名单
 * @property {number} maxRetries 单回合最多拦几次
 * @property {(agent: any, text: string) => void | Promise<void>} steer 注入提醒
 * @property {(note: RecordNote) => void} [record] 留痕（超限放行、异常）
 */

/**
 * 把闸门接到宿主上下文上。
 *
 * `enabled` 为 false 时**直接返回空清理函数**：不注册任何监听器，因此既不读
 * 会话事件、也不判工具、更不会留痕。这是票 #34 要求的「关掉后监听器直接返回」。
 *
 * @param {{ on: (name: string, handler: (...args: any[]) => any) => any }} ctx 宿主上下文
 * @param {WireOptions} options 接线参数
 * @returns {() => void} 卸载钩子
 */
export function wire(ctx, options) {
  if (!options.enabled) return () => {};

  const gate = new TurnGate({
    writeTools: options.writeTools,
    maxRetries: options.maxRetries,
  });

  /** 留痕是尽力而为：它自身的失败绝不该变成新的故障源（同步与异步都兜住）。 */
  const record = (note) => {
    try {
      const pending = options.record?.(note);
      if (pending !== null && typeof pending?.then === 'function') {
        pending.then(undefined, () => {});
      }
    } catch {
      // 静默。
    }
  };

  /** 任一环节出错都只留痕并放行，绝不把异常抛进回合链。 */
  const noteError = (what, error, session) => {
    const message = error instanceof Error ? error.message : String(error);
    record({ kind: 'error', session, message: `${what}失败，放行：${message}` });
  };

  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (typeof id !== 'string') return;
    try {
      gate.observe(id, event);
    } catch (error) {
      noteError('观察会话事件', error, session);
    }
  });

  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id === 'string') gate.forget(id);
  });

  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const session = agent?.session;
    const id = session?.id;
    if (typeof id !== 'string') return;

    let decision;
    try {
      decision = gate.decide(id, turn);
    } catch (error) {
      noteError('收尾判定', error, session);
      return;
    }

    if (decision.action === 'steer') {
      if (typeof agent.steer !== 'function') return;
      try {
        await options.steer(agent, decision.text);
      } catch (error) {
        noteError('注入提醒', error, session);
      }
      return;
    }

    // 超限放行：写一条未合规记录（回合号 + 缺失栏名）。这是这条规则唯一的
    // 事后可观测证据，所以字段要结构化，而不是只留一句人话。
    if (decision.reason === 'exhausted') {
      record({
        kind: 'exhausted',
        session,
        turn,
        missing: decision.gapKeys ?? [],
        strikes: decision.strikes ?? 0,
        message: `回合 ${turn} 已拦过 ${decision.strikes ?? 0} 次仍缺槽位，放行。`,
      });
    }
  });

  return () => {
    gate.bySession.clear();
  };
}
