/**
 * 接线层的合成测试 —— 用假 ctx 与假 agent 断言对外可观察行为：
 * steer 有没有被调用、调用了几次、内容说了什么。
 *
 * 刻意不断言插件内部状态（计数器字段之类），那些是实现细节。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { wire } from '../lib/wire.js';

/** 一个最小的假宿主上下文：记录注册了哪些事件、能手动触发。 */
function fakeCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    async emit(name, ...args) {
      const list = handlers.get(name) ?? [];
      for (const handler of list) await handler(...args);
    },
  };
}

/** 一个假 agent：记录每次 steer 的调用。 */
function fakeAgent(sessionId = 'sess-1') {
  const steers = [];
  return {
    steers,
    session: { id: sessionId },
    steer(message) {
      steers.push(message);
    },
  };
}

/** 造插件需要消费的事件。 */
const ev = {
  turnStart: (turn) => ({ type: 'turn/start', data: { turn } }),
  write: (turn, name = 'write') => ({
    type: 'tool/call',
    data: { turn, step: 1, callId: 'c1', name, arguments: '{}' },
  }),
  text: (turn, text) => ({
    type: 'assistant/message',
    data: { turn, step: 1, message: { content: [{ type: 'text', text }] } },
  }),
};

const COMPLIANT = [
  '## 改了什么',
  '把 README 第 3 行改成 `python3 calc.py`。',
  '## 已阅未改',
  '无',
  '## 判断无问题',
  '第 10 行的 ValueErrror 拼写错误，判断为不影响运行说明，未改。',
].join('\n');

/** 接线一个闸门，返回 { ctx, agent, cleanup } 。 */
function setup(config = {}) {
  const ctx = fakeCtx();
  const agent = fakeAgent();
  const lines = [];
  const cleanup = wire(ctx, {
    enabled: config.enabled ?? true,
    writeTools: config.writeTools ?? ['write', 'edit', 'apply_patch'],
    maxRetries: config.maxRetries ?? 1,
    record: (line) => lines.push(line),
    steer: (target, text) => {
      target.steer({ role: 'user', content: [{ type: 'text', text }] });
    },
  });
  return { ctx, agent, lines, cleanup };
}

/** 取最后一次 steer 的文本。 */
function lastSteerText(agent) {
  const message = agent.steers.at(-1);
  return message?.content?.[0]?.text ?? '';
}

/** 跑一个完整回合：开始 → 写调用 → 交付文本 → 收尾。 */
async function runTurn(ctx, agent, { turn = 1, tools = ['write'], text = '' } = {}) {
  await ctx.emit('session/event', agent.session, ev.turnStart(turn));
  for (const name of tools) await ctx.emit('session/event', agent.session, ev.write(turn, name));
  if (text.length > 0) await ctx.emit('session/event', agent.session, ev.text(turn, text));
  await ctx.emit('agent/turn-stopping', { agent, turn });
}

test('有写类调用 + 交付缺槽位 → steer 被调用一次，内容指明缺哪一栏', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { text: '我把 README 改好了，实测输出 ok。' });

  assert.equal(agent.steers.length, 1);
  const text = lastSteerText(agent);
  assert.match(text, /改了什么/);
  assert.match(text, /已阅未改/);
  assert.match(text, /判断无问题/);
  assert.match(text, /第三栏是重点/);
});

test('有写类调用 + 三栏齐全 → steer 不被调用', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { text: COMPLIANT });
  assert.equal(agent.steers.length, 0);
});

test('重试一次仍不合规 → 放行，steer 只被调用过一次', async () => {
  const { ctx, agent, lines } = setup({ maxRetries: 1 });

  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  // 模型补了一步仍然没填 —— 再次收尾
  await ctx.emit('session/event', agent.session, ev.text(1, '还是没填。'));
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1, '第二次收尾不应再 steer');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /放行/);
});

test('第二次补齐后不再 steer（闸门关掉）', async () => {
  const { ctx, agent } = setup({ maxRetries: 1 });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  await ctx.emit('session/event', agent.session, ev.text(1, COMPLIANT));
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('没有写类调用 → 不 steer，哪怕交付说明一个字没有', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { tools: ['read', 'bash'], text: '只看了看。' });
  assert.equal(agent.steers.length, 0);
});

test('enabled=false → 完全不注册判定，steer 永不调用', async () => {
  const { ctx, agent } = setup({ enabled: false });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 0);
});

test('maxRetries=0 → 不 steer，只留痕', async () => {
  const { ctx, agent, lines } = setup({ maxRetries: 0 });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 0);
  assert.equal(lines.length, 1);
});

test('agent 没有 steer 方法 → 不抛异常', async () => {
  const { ctx } = setup();
  const muteAgent = { session: { id: 'sess-x' } };
  await ctx.emit('session/event', muteAgent.session, ev.turnStart(1));
  await ctx.emit('session/event', muteAgent.session, ev.write(1));
  await ctx.emit('session/event', muteAgent.session, ev.text(1, '改好了。'));
  await assert.doesNotReject(async () => {
    await ctx.emit('agent/turn-stopping', { agent: muteAgent, turn: 1 });
  });
});

test('session 没有 id → 直接跳过，不抛异常', async () => {
  const { ctx } = setup();
  await assert.doesNotReject(async () => {
    await ctx.emit('agent/turn-stopping', { agent: { session: {} }, turn: 1 });
    await ctx.emit('session/event', {}, ev.turnStart(1));
  });
});

test('steer 抛异常 → 被吞掉并留痕，回合照常收尾', async () => {
  const ctx = fakeCtx();
  const agent = fakeAgent();
  const lines = [];
  wire(ctx, {
    enabled: true,
    writeTools: ['write'],
    maxRetries: 1,
    record: (line) => lines.push(line),
    steer: () => {
      throw new Error('boom');
    },
  });

  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /注入提醒失败/);
});

test('会话销毁后状态被清掉，再收尾不误伤', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  await ctx.emit('session/disposed', agent.session);
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('两个会话互不干扰：A 被拦不影响 B 放行', async () => {
  const { ctx } = setup();
  const a = fakeAgent('sess-a');
  const b = fakeAgent('sess-b');

  await runTurn(ctx, a, { text: '改好了。' });
  await runTurn(ctx, b, { text: COMPLIANT });

  assert.equal(a.steers.length, 1);
  assert.equal(b.steers.length, 0);
});

test('cleanup 清空状态后，同一回合再收尾不会重复拦', async () => {
  // maxRetries 给足，确保「不再 steer」只可能来自状态被清空，而不是额度耗尽。
  const { ctx, agent, cleanup } = setup({ maxRetries: 5 });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  cleanup();
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1, 'cleanup 后状态已清空，收尾应按无状态放行');
});
