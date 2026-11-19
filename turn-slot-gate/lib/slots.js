/**
 * 三栏槽位的识别逻辑 —— 纯函数，不依赖 cordis，可脱离宿主单独测试。
 *
 * 契约（与 docs/agents/task-intake.md 的三栏定义保持一致）：
 *   1. 改了什么      本回合实际改动的对象
 *   2. 已阅未改      读到了、但判断不该动的对象
 *   3. 判断无问题    读到了、判断过、结论是不构成问题的对象
 *
 * 本模块只验**结构**：三栏在不在、内容空不空。它不判断内容是真的还是编的
 * —— 那需要语义理解，插件做不了，也不假装能做。规格 #32 已把这条写成已知
 * 失效边界。
 */

/** 三栏的固定标签，顺序即交付时的推荐顺序。 */
export const SLOT_LABELS = Object.freeze([
  Object.freeze({ key: 'changed', label: '改了什么' }),
  Object.freeze({ key: 'seenUnchanged', label: '已阅未改' }),
  Object.freeze({ key: 'judgedFine', label: '判断无问题' }),
]);

/** 允许把整栏写空的栏位 —— 其余栏位不允许只有标签没有内容。 */
export const EXPLICITLY_EMPTY_OK = Object.freeze(['changed', 'seenUnchanged', 'judgedFine']);

/**
 * 把可能带 markdown 修饰的一行剥成裸文本：
 * `## 改了什么`、`**改了什么**：`、`- 改了什么` 都要能认出标签。
 * @param {string} line 原始行
 * @returns {string} 去掉行首标记、行尾空白后的文本
 */
function stripMarkers(line) {
  return line.replace(/^[\s#>*-]+/, '').replace(/\s+$/, '');
}

/**
 * 从一行里取出某个标签之后的内容（同一行内）。
 * @param {string} line 原始行
 * @param {string} label 标签文本
 * @returns {string | undefined} 该行以这个标签开头时返回标签后的剩余内容，否则 undefined
 */
function contentAfterLabel(line, label) {
  const cleaned = stripMarkers(line);
  if (!cleaned.startsWith(label)) return undefined;
  return cleaned.slice(label.length).replace(/^[\s：:、，,]+/, '').replace(/\s+$/, '');
}

/**
 * 解析一段交付说明，找出哪些栏位出现、哪些缺失、哪些出现了但内容为空。
 * @param {string} text 交付说明全文（通常是最后一条 assistant 消息的文本）
 * @returns {{ present: string[], empty: string[], missing: string[] }}
 */
export function parseSlots(text) {
  const lines = typeof text === 'string' ? text.split(/\r?\n/) : [];

  /** @type {Map<string, string[]>} 栏位 key → 该栏的内容行 */
  const sections = new Map();
  /** @type {string | null} 当前正在累积的栏位 key */
  let current = null;

  for (const line of lines) {
    let matched = null;
    for (const { key, label } of SLOT_LABELS) {
      const rest = contentAfterLabel(line, label);
      if (rest !== undefined) {
        matched = { key, rest };
        break;
      }
    }
    if (matched !== null) {
      // 同栏重复出现时保留第一处，后面的按上一栏的正文处理更危险，直接并入。
      if (!sections.has(matched.key)) {
        sections.set(matched.key, matched.rest.length > 0 ? [matched.rest] : []);
        current = matched.key;
      } else {
        sections.get(matched.key).push(matched.rest);
        current = matched.key;
      }
      continue;
    }
    if (current !== null) sections.get(current).push(line);
  }

  const present = [];
  const empty = [];
  const missing = [];

  for (const { key } of SLOT_LABELS) {
    if (!sections.has(key)) {
      missing.push(key);
      continue;
    }
    present.push(key);
    const body = sections.get(key).join('\n').trim();
    if (body.length === 0) empty.push(key);
  }

  return { present, empty, missing };
}

/**
 * 这条交付说明是否已经具备完整的三栏结构。
 * @param {string} text 交付说明全文
 * @returns {boolean} 三栏齐全且都非空时 true
 */
export function hasCompleteSlots(text) {
  const { empty, missing } = parseSlots(text);
  return empty.length === 0 && missing.length === 0;
}

/**
 * 把缺失的栏位 key 转成给人看的中文栏名，用于提醒文案。
 * @param {string[]} keys 栏位 key 列表
 * @returns {string} 形如「已阅未改、判断无问题」
 */
export function describeSlotKeys(keys) {
  const labels = SLOT_LABELS.filter((slot) => keys.includes(slot.key)).map((slot) => slot.label);
  return labels.join('、');
}

/**
 * 从 assistant 消息里取出全部可见文本。
 * @param {{ content?: Array<{ type: string, text?: string }> }} message assistant 消息
 * @returns {string} 拼接后的文本，无文本块时为空串
 */
export function extractAssistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const parts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * 生成拦回时注入的提醒文案。
 * @param {{ missing: string[], empty: string[] }} gaps 缺失与为空的栏位
 * @returns {string} 给人看的中文提醒
 */
export function buildNudge(gaps) {
  const problems = [];
  if (gaps.missing.length > 0) {
    problems.push(`缺了「${describeSlotKeys(gaps.missing)}」`);
  }
  if (gaps.empty.length > 0) {
    problems.push(`「${describeSlotKeys(gaps.empty)}」只有标签没有内容`);
  }
  const described = problems.length > 0 ? problems.join('，并且') : '三栏不完整';

  return [
    `交付说明的「已阅未改」三栏槽位不完整：${described}。`,
    '',
    '请在交付说明里补齐这三栏，每栏用一行标签开头，内容写在标签后面或下一行：',
    '  · 改了什么 —— 本回合实际改动了什么',
    '  · 已阅未改 —— 读到了、但判断不该动的东西（没有就写「无」）',
    '  · 判断无问题 —— 读到了、判断过、结论是不构成问题的东西，要写清楚为什么判断没问题',
    '',
    '第三栏是重点：它区分「看见了、判断没问题」和「根本没看见」。真的没有可写就写「无」，不要为了填满而编。',
  ].join('\n');
}
