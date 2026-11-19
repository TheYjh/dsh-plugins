/**
 * dsh-turn-slot-gate —— 宿主接线层（不直接 import 宿主包，可脱离宿主测试）
 *
 * 这一层把「事件订阅 + 收尾判定 + 注入提醒」串起来，但所有宿主能力都通过
 * 参数传进来：
 *   - `ctx`：只要有 `on(name, handler)` 的最小接口；
 *   - `steer(agent, text)`：把提醒注入回回合（真实实现见 `lib/index.js`，
 *     它负责把文本包成一条合法 user 消息）。
 *
 * 这样测试可以喂假 ctx 和假 agent，直接断言「steer 有没有被调用、内容是什么」
 * —— 也就是规格要求的对外可观察行为，而不是插件内部的计数器。
 *
 * `agent/turn-stopping` 是被 `await` 的（宿主在边界上串行等待所有监听器，
 * 然后重新读收件箱），所以监听器可以是 async，注入前需要 await 也没问题。
 */

import { TurnGate } from './gate.js';

/**
 * @typedef {object} WireOptions
 * @property {boolean} enabled 总开关
 * @property {string[]} writeTools 写类工具名单
 * @property {number} maxRetries 单回合最多拦几次
 * @property {(agent: any, text: string) => void | Promise<void>} steer 注入提醒
 * @property {(line: string) => void} [record] 留痕函数
 */

/**
 * 把闸门接到宿主上下文上。
 * @param {{ on: (name: string, handler: (...args: any[]) => any) => any }} ctx 宿主上下文
 * @param {WireOptions} options 接线参数
 * @returns {() => void} 卸载钩子
 */
export function wire(ctx, options) {
  if (!options.enabled) return () => {};

  const gate = new TurnGate({
    writeTools: options.writeTools,
    maxRetries: options.maxRetries,
    record: options.record,
  });

  /** 任一环节出错都只留痕并放行，绝不把异常抛进回合链。 */
  const note = (what, error) => {
    const message = error instanceof Error ? error.message : String(error);
    options.record?.(`${what}失败，放行：${message}`);
  };

  ctx.on('session/event', (session, event) => {
    const id = session?.id;
    if (typeof id !== 'string') return;
    try {
      gate.observe(id, event);
    } catch (error) {
      note('观察会话事件', error);
    }
  });

  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id === 'string') gate.forget(id);
  });
  ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
    const id = agent?.session?.id;
    if (typeof id !== 'string') return;

    let decision;
    try {
      decision = gate.decide(id, turn);
    } catch (error) {
      note('收尾判定', error);
      return;
    }

    if (decision.action !== 'steer') return;
    if (typeof agent.steer !== 'function') return;

    try {
      await options.steer(agent, decision.text);
    } catch (error) {
      note('注入提醒', error);
    }
  });

  return () => {
    gate.bySession.clear();
  };
}
