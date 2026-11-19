/**
 * 入口层的测试 —— 验证可注入的宿主能力：会话日志追加走注入的加载器，
 * 记录真的落进（真实的或假的）会话日志，且写失败时不让回合受影响。
 *
 * 这里用假会话对象，不依赖 DSH 运行时；真实 `dsh-session` 的端到端验证
 * 在开发时用一次性脚本做过（见 #34 的评论）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApply, normalizeConfig, RECORD_TYPE, DEFAULT_WRITE_TOOLS } from '../lib/index.js';

/** 最小假 ctx。 */
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
      for (const handler of handlers.get(name) ?? []) await handler(...args);
    },
  };
}

/** 假会话：把追加的记录收进数组，模拟会话日志。 */
function fakeSession(id = 'sess-1') {
  const records = [];
  return {
    id,
    records,
    append(type, data) {
      records.push({ type, data });
      return records.length - 1;
    },
  };
}

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

/** 跑一个「改了东西但没填三栏」的回合，走到超限放行。 */
async function runNonCompliantTurn(ctx, session, turn = 1) {
  await ctx.emit('session/event', session, ev.turnStart(turn));
  await ctx.emit('session/event', session, ev.write(turn));
  await ctx.emit('session/event', session, ev.text(turn, '改好了。'));
  await ctx.emit('agent/turn-stopping', { agent: { session, steer() {} }, turn });
  // 留痕是异步的（要 await 动态加载器），给它一个 tick。
  await new Promise((resolve) => setTimeout(resolve, 20));
}

test('超限放行的记录写进会话日志，含回合号与缺失栏名', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({
    loadAppendPluginRecord: async () => ({
      appendPluginRecord: (target, type, data) => target.append(type, data),
    }),
  });
  apply(ctx, { maxRetries: 0 });

  await runNonCompliantTurn(ctx, session, 9);

  assert.equal(session.records.length, 1);
  const [record] = session.records;
  assert.equal(record.type, RECORD_TYPE);
  assert.equal(record.data.turn, 9);
  assert.deepEqual(record.data.missing, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.equal(record.data.strikes, 0);
});

test('拦过一次后超限的记录记下 strikes=1', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({
    loadAppendPluginRecord: async () => ({
      appendPluginRecord: (target, type, data) => target.append(type, data),
    }),
  });
  apply(ctx, { maxRetries: 1 });

  await runNonCompliantTurn(ctx, session, 2);
  assert.equal(session.records.length, 0, '第一次是拦回，不该有记录');

  await ctx.emit('session/event', session, ev.text(2, '还是没填。'));
  await ctx.emit('agent/turn-stopping', { agent: { session, steer() {} }, turn: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(session.records.length, 1);
  assert.equal(session.records[0].data.strikes, 1);
});

test('拿不到 appendPluginRecord 时静默降级，不抛异常', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({ loadAppendPluginRecord: async () => null });
  apply(ctx, { maxRetries: 0 });

  await assert.doesNotReject(async () => {
    await runNonCompliantTurn(ctx, session, 3);
  });
  assert.equal(session.records.length, 0, '降级时不该假装写了记录');
});

test('加载器自己抛异常 → 静默降级，回合照常', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({
    loadAppendPluginRecord: async () => {
      throw new Error('cannot resolve dsh-session');
    },
  });
  apply(ctx, { maxRetries: 0 });

  await assert.doesNotReject(async () => {
    await runNonCompliantTurn(ctx, session, 4);
  });
  assert.equal(session.records.length, 0);
});

test('appendPluginRecord 抛异常 → 只留 stderr，不抛进回合', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({
    loadAppendPluginRecord: async () => ({
      appendPluginRecord: () => {
        throw new Error('session unentered');
      },
    }),
  });
  apply(ctx, { maxRetries: 0 });

  await assert.doesNotReject(async () => {
    await runNonCompliantTurn(ctx, session, 5);
  });
  assert.equal(session.records.length, 0);
});

test('enabled=false → 不注册监听器、不写任何记录', async () => {
  const ctx = fakeCtx();
  const session = fakeSession();
  const apply = createApply({
    loadAppendPluginRecord: async () => ({
      appendPluginRecord: (target, type, data) => target.append(type, data),
    }),
  });
  apply(ctx, { enabled: false });

  assert.equal(ctx.handlers.size, 0);
  await runNonCompliantTurn(ctx, session, 6);
  assert.equal(session.records.length, 0);
});

test('normalizeConfig 回落到默认值', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    enabled: true,
    writeTools: [...DEFAULT_WRITE_TOOLS],
    maxRetries: 1,
  });
  assert.deepEqual(normalizeConfig({ enabled: false, maxRetries: 3, writeTools: ['edit'] }), {
    enabled: false,
    writeTools: ['edit'],
    maxRetries: 3,
  });
  // 明显非法的值一律回落，不抛。
  assert.deepEqual(normalizeConfig({ enabled: 'yes', maxRetries: -1, writeTools: [1] }), {
    enabled: true,
    writeTools: [...DEFAULT_WRITE_TOOLS],
    maxRetries: 1,
  });
});
