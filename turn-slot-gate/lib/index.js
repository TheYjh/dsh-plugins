/**
 * dsh-turn-slot-gate —— 回合收尾闸门
 *
 * 问题：模型在收尾时组织的是「我做了什么、结果如何」，天然不含「我看见了
 * 什么但没做」。全局规则里连写四轮自然语言要求都没能让它出现在交付说明里
 * （见 DSHBox #31 的十项矩阵回归），所以改成结构性拦截：本回合改过东西、
 * 交付说明却没有三栏槽位，就把回合拦回来补一次。
 *
 * 机制：挂 `agent/turn-stopping`。宿主在那个边界上会 await 所有监听器，然后
 * 重新读一次收件箱——监听器里 `agent.steer(...)` 注入的消息会让它再走一步，
 * 不注入就收尾。这是结构性强制，不是建议。
 *
 * 拆法：宿主包（`@deepseek-ai/dsh-llm`）只在第一次需要注入时动态 import，并
 * 缓存 promise，因此 `lib/wire.js` / `lib/gate.js` / `lib/slots.js` 都能脱开
 * 宿主单独测试。参照 `profile-doctor` 的拆法。
 *
 * 边界：
 *   - 只验结构（三栏在不在、空不空），不验内容真假。
 *   - 重试有上限，上限内没补齐就放行并留痕；闸门不允许卡死回合。
 *   - `bash` 不算写类工具：无法从工具名和参数可靠区分 `cat` 和 `rm`。
 */

import { DEFAULT_WRITE_TOOLS } from './gate.js';
import { wire } from './wire.js';

export { TurnGate, DEFAULT_WRITE_TOOLS } from './gate.js';
export {
  SLOT_LABELS,
  buildNudge,
  describeSlotKeys,
  extractAssistantText,
  hasCompleteSlots,
  parseSlots,
} from './slots.js';
export { wire } from './wire.js';

export const name = 'dsh-turn-slot-gate';

/**
 * 刻意不 inject：这里订阅的三个事件都不需要任何服务。宿主缺服务时插件仍应
 * 能装上并保持沉默，而不是加载失败。
 */
export const inject = [];

const DEFAULTS = {
  /** 总开关。关掉后完全不读会话、不判工具。 */
  enabled: true,
  /** 写类工具名单；留空用默认三项（write / edit / apply_patch）。 */
  writeTools: [],
  /** 一个回合最多拦几次。0 表示不拦，只放行并留痕。 */
  maxRetries: 1,
};

/**
 * @param {unknown} raw 配置树里这一层的原始值
 * @returns {{ enabled: boolean, writeTools: string[], maxRetries: number }} 规整后的配置
 */
export function normalizeConfig(raw) {
  const merged = { ...DEFAULTS, writeTools: [...DEFAULT_WRITE_TOOLS] };
  if (raw !== null && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') merged.enabled = raw.enabled;
    if (Number.isInteger(raw.maxRetries) && raw.maxRetries >= 0) merged.maxRetries = raw.maxRetries;
    if (Array.isArray(raw.writeTools) && raw.writeTools.every((n) => typeof n === 'string')) {
      merged.writeTools = raw.writeTools.length > 0 ? [...raw.writeTools] : [...DEFAULT_WRITE_TOOLS];
    }
  }
  return merged;
}

/** 往宿主日志写一行；任何异常都不许冒泡进回合链。 */
function report(message) {
  try {
    process.stderr.write(`${name}: ${message}\n`);
  } catch {
    /* 忽略 */
  }
}

/**
 * 懒加载宿主消息工厂。第一次调用时发起 import 并缓存 promise，后续复用；
 * 失败则退回裸消息对象（不阻断提醒，只是可能缺少稳定 id）。
 *
 * @returns {() => Promise<(text: string) => unknown>} 取消息工厂的异步函数
 */
function createMessageFactory() {
  let factory = null;
  let pending = null;

  const fallback = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

  return async () => {
    if (factory !== null) return factory;
    pending ??= import('@deepseek-ai/dsh-llm')
      .then((mod) => {
        if (typeof mod.createUserMessage !== 'function') {
          report('宿主未导出 createUserMessage，退回裸消息对象；提醒可能不带稳定 id。');
          return fallback;
        }
        return (text) =>
          mod.createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'turn-slot-gate' },
          });
      })
      .catch((error) => {
        report(
          `未能加载 @deepseek-ai/dsh-llm（${error instanceof Error ? error.message : String(error)}），` +
            '退回裸消息对象；提醒可能不带稳定 id。',
        );
        return fallback;
      });
    factory = await pending;
    return factory;
  };
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {unknown} rawConfig 配置
 * @returns {() => void} 卸载钩子
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return () => {};

  const getFactory = createMessageFactory();

  return wire(ctx, {
    enabled: config.enabled,
    writeTools: config.writeTools,
    maxRetries: config.maxRetries,
    record: report,
    async steer(agent, text) {
      const make = await getFactory();
      agent.steer(make(text));
    },
  });
}
