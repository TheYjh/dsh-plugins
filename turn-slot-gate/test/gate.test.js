/**
 * 闸门状态机的合成测试 —— 只喂会话事件、只断言对外决定（放行 / 拦回），
 * 不断言内部计数字段。
 *
 * 必测分支（票 #33 / #34 的验收）：缺槽位要拦、齐全要放行、拦过一次还不合规
 * 要放行（防死循环）、只读回合不拦、超限放行带回回合号与缺失栏名。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TurnGate, DEFAULT_WRITE_TOOLS } from '../lib/gate.js';

const SESSION = 'sess-1';

/** 造一条 assistant/message 事件。 */
function assistant(turn, text) {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  };
}

/** 造一条 tool/call 事件。 */
function toolCall(turn, name) {
  return { type: 'tool/call', data: { turn, step: 1, callId: 'c1', name, arguments: '{}' } };
}

const COMPLIANT = [
  '## 改了什么',
  '把 README 第 3 行改成 `python3 calc.py`。',
  '## 已阅未改',
  '无',
  '## 判断无问题',
  '第 10 行的 ValueErrror 拼写错误，判断为不影响运行说明，未改。',
].join('\n');

/** 跑一轮完整回合：开始 → 工具调用 → 交付文本 → 收尾判定。 */
function runTurn(gate, { turn = 1, tools = ['write'], text = '', session = SESSION } = {}) {
  gate.observe(session, { type: 'turn/start', data: { turn } });
  for (const name of tools) gate.observe(session, toolCall(turn, name));
  if (text.length > 0) gate.observe(session, assistant(turn, text));
  return gate.decide(session, turn);
}

test('默认写类工具不含 bash', () => {
  assert.deepEqual([...DEFAULT_WRITE_TOOLS], ['write', 'edit', 'apply_patch']);
  assert.equal(DEFAULT_WRITE_TOOLS.includes('bash'), false);
});

test('有写类调用 + 交付缺槽位 → 拦回，提醒指明缺哪一栏', () => {
  const gate = new TurnGate();
  const decision = runTurn(gate, { text: '我把 README 改好了，实测输出 ok。' });
  assert.equal(decision.action, 'steer');
  assert.deepEqual(decision.gapKeys, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.match(decision.text, /改了什么/);
  assert.match(decision.text, /判断无问题/);
});

test('有写类调用 + 三栏齐全 → 放行', () => {
  const gate = new TurnGate();
  const decision = runTurn(gate, { text: COMPLIANT });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'compliant');
});

test('重试一次仍不合规 → 放行，不再拦，并带回回合号与缺失栏名', () => {
  const gate = new TurnGate({ maxRetries: 1 });

  const first = runTurn(gate, { text: '改好了。' });
  assert.equal(first.action, 'steer');

  // 模型补了一步，还是没填 —— 第二次收尾应放行
  gate.observe(SESSION, assistant(1, '还是没填。'));
  const second = gate.decide(SESSION, 1);
  assert.equal(second.action, 'allow');
  assert.equal(second.reason, 'exhausted');
  assert.deepEqual(second.gapKeys, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.equal(second.strikes, 1);
});

test('maxRetries=0 → 一次都不拦，直接放行并带回栏名', () => {
  const gate = new TurnGate({ maxRetries: 0 });
  const decision = runTurn(gate, { text: '改好了。' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'exhausted');
  assert.equal(decision.strikes, 0);
  assert.equal(decision.gapKeys.length, 3);
});

test('只读工具（read/grep/glob）→ 放行，不看文本', () => {
  const gate = new TurnGate();
  const decision = runTurn(gate, { tools: ['read', 'grep', 'glob'], text: '我只看了看，没改。' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'no-write');
});

test('只跑 bash（哪怕它写了文件）→ 放行：bash 不计入写类判定', () => {
  const gate = new TurnGate();
  const decision = runTurn(gate, { tools: ['bash'], text: '跑了几个命令。' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'no-write');
});

test('只读 + 三栏齐全也不拦（本来就不该管）', () => {
  const gate = new TurnGate();
  const decision = runTurn(gate, { tools: [], text: COMPLIANT });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'no-write');
});

test('补上三栏后第二次收尾放行', () => {
  const gate = new TurnGate();
  assert.equal(runTurn(gate, { text: '改好了。' }).action, 'steer');
  gate.observe(SESSION, assistant(1, COMPLIANT));
  const second = gate.decide(SESSION, 1);
  assert.equal(second.action, 'allow');
  assert.equal(second.reason, 'compliant');
});

test('新回合重置：上一回合被拦过不影响新回合额度', () => {
  const gate = new TurnGate({ maxRetries: 1 });
  assert.equal(runTurn(gate, { turn: 1, text: '改好了。' }).action, 'steer');
  assert.equal(runTurn(gate, { turn: 2, text: '又改好了。' }).action, 'steer');
});

test('写类工具可配置：自定义名单后 write 不再触发', () => {
  const gate = new TurnGate({ writeTools: ['apply_patch'] });
  const decision = runTurn(gate, { tools: ['write'], text: '改好了。' });
  assert.equal(decision.action, 'allow');
  assert.equal(decision.reason, 'no-write');
});

test('回合结束后状态被丢弃', () => {
  const gate = new TurnGate();
  runTurn(gate, { text: COMPLIANT });
  gate.observe(SESSION, { type: 'turn/end', data: { turn: 1 } });
  assert.equal(gate.decide(SESSION, 1).reason, 'no-state');
});

test('未知会话收尾不抛异常，按无状态放行', () => {
  const gate = new TurnGate();
  assert.equal(gate.decide('never-seen', 1).action, 'allow');
});

test('最后一段文本才作数：先不合规后合规 → 放行', () => {
  const gate = new TurnGate();
  gate.observe(SESSION, { type: 'turn/start', data: { turn: 1 } });
  gate.observe(SESSION, toolCall(1, 'edit'));
  gate.observe(SESSION, assistant(1, '中间过程说明。'));
  gate.observe(SESSION, assistant(1, COMPLIANT));
  assert.equal(gate.decide(SESSION, 1).action, 'allow');
});
