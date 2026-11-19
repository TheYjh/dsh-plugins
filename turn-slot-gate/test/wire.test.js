/**
 * 接线层的合成测试 —— 用假 ctx 与假 agent 断言对外可观察行为：
 * steer 有没有被调用、调用了几次、内容说了什么、留痕里有没有回合号与缺失栏名。
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

/** 一个假 agent：记录每次 steer 的调用。`interactive` 只用于区分主代理与子代理。 */
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

/** 接线一个闸门，返回 { ctx, agent, notes, cleanup }。 */
function setup(config = {}) {
  const ctx = fakeCtx();
  const agent = fakeAgent();
  const notes = [];
  const cleanup = wire(ctx, {
    enabled: config.enabled ?? true,
    writeTools: config.writeTools ?? ['write', 'edit', 'apply_patch'],
    maxRetries: config.maxRetries ?? 1,
    record: (note) => notes.push(note),
    steer: (target, text) => {
      target.steer({ role: 'user', content: [{ type: 'text', text }] });
    },
  });
  return { ctx, agent, notes, cleanup };
}

/** 取最后一次 steer 的文本。 */
function lastSteerText(agent) {
  const message = agent.steers.at(-1);
  return message?.content?.[0]?.text ?? '';
}

/** 跑一个完整回合：开始 → 工具调用 → 交付文本 → 收尾。 */
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
  const { ctx, agent } = setup({ maxRetries: 1 });

  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  // 模型补了一步仍然没填 —— 再次收尾
  await ctx.emit('session/event', agent.session, ev.text(1, '还是没填。'));
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1, '第二次收尾不应再 steer');
});

test('第二次补齐后不再 steer（闸门关掉）', async () => {
  const { ctx, agent } = setup({ maxRetries: 1 });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 1);

  await ctx.emit('session/event', agent.session, ev.text(1, COMPLIANT));
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('只读回合（read/grep/glob）→ 不 steer', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { tools: ['read', 'grep', 'glob'], text: '只看了看。' });
  assert.equal(agent.steers.length, 0);
});

test('只跑 bash 的回合 → 不 steer（bash 不算写类）', async () => {
  const { ctx, agent } = setup();
  await runTurn(ctx, agent, { tools: ['bash'], text: '跑了几个命令。' });
  assert.equal(agent.steers.length, 0);
});

test('enabled=false → 一个监听器都不注册，既不读会话也不 steer', async () => {
  const { ctx, agent, notes } = setup({ enabled: false });

  // 关键断言：没有注册任何 handler，所以「不读会话日志」是结构性的，
  // 不是靠某个 if 分支提前 return。
  assert.equal(ctx.handlers.size, 0);

  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(agent.steers.length, 0);
  assert.equal(notes.length, 0);
});

test('超限放行 → 留痕带回合号、缺失栏名与已拦次数', async () => {
  const { ctx, agent, notes } = setup({ maxRetries: 0 });
  await runTurn(ctx, agent, { text: '改好了。' });

  assert.equal(agent.steers.length, 0);
  assert.equal(notes.length, 1);
  const [note] = notes;
  assert.equal(note.kind, 'exhausted');
  assert.equal(note.turn, 1);
  assert.deepEqual(note.missing, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.equal(note.strikes, 0);
  assert.equal(note.session, agent.session);
});

test('拦过一次再超限 → 留痕记下已经拦过 1 次', async () => {
  const { ctx, agent, notes } = setup({ maxRetries: 1 });
  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(notes.length, 0, '第一次是 steer，不该有超限留痕');

  await ctx.emit('session/event', agent.session, ev.text(1, '还是没填。'));
  await ctx.emit('agent/turn-stopping', { agent, turn: 1 });

  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'exhausted');
  assert.equal(notes[0].turn, 1);
  assert.equal(notes[0].strikes, 1);
});

test('子代理回合与主代理行为一致（独立会话、同样被拦、同样留痕）', async () => {
  const { ctx, notes } = setup({ maxRetries: 1 });
  const parent = fakeAgent('sess-parent');
  const child = fakeAgent('sess-child');

  // 两者跑完全相同的回合序列，只是会话不同。
  await runTurn(ctx, parent, { text: '改好了。' });
  await runTurn(ctx, child, { text: '改好了。' });

  assert.equal(parent.steers.length, 1, '主代理被拦');
  assert.equal(child.steers.length, 1, '子代理同样被拦');
  assert.equal(lastSteerText(parent), lastSteerText(child), '注入的提醒内容一致');

  // 各自补一步仍不合规 → 各自超限放行、各自留痕，互不串。
  for (const agent of [parent, child]) {
    await ctx.emit('session/event', agent.session, ev.text(1, '还是没填。'));
    await ctx.emit('agent/turn-stopping', { agent, turn: 1 });
  }

  assert.equal(notes.filter((n) => n.kind === 'exhausted').length, 2);
  const sessions = notes.filter((n) => n.kind === 'exhausted').map((n) => n.session.id);
  assert.deepEqual(sessions.sort(), ['sess-child', 'sess-parent']);
  for (const note of notes.filter((n) => n.kind === 'exhausted')) {
    assert.equal(note.turn, 1);
    assert.equal(note.missing.length, 3);
  }
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
  const notes = [];
  wire(ctx, {
    enabled: true,
    writeTools: ['write'],
    maxRetries: 1,
    record: (note) => notes.push(note),
    steer: () => {
      throw new Error('boom');
    },
  });

  await runTurn(ctx, agent, { text: '改好了。' });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'error');
  assert.match(notes[0].message, /注入提醒失败/);
});

test('record 自己抛异常 → 不影响回合，也不二次抛', async () => {
  const ctx = fakeCtx();
  const agent = fakeAgent();
  wire(ctx, {
    enabled: true,
    writeTools: ['write'],
    maxRetries: 0,
    record: () => {
      throw new Error('record boom');
    },
    steer: (target, text) => target.steer({ content: [{ type: 'text', text }] }),
  });

  await assert.doesNotReject(async () => {
    await runTurn(ctx, agent, { text: '改好了。' });
  });
});

test('record 返回 rejected promise → 不影响回合', async () => {
  const ctx = fakeCtx();
  const agent = fakeAgent();
  wire(ctx, {
    enabled: true,
    writeTools: ['write'],
    maxRetries: 0,
    record: async () => {
      throw new Error('async record boom');
    },
    steer: (target, text) => target.steer({ content: [{ type: 'text', text }] }),
  });

  await assert.doesNotReject(async () => {
    await runTurn(ctx, agent, { text: '改好了。' });
  });
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
