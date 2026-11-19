/**
 * 三栏槽位识别的合成测试 —— 只测外部可观察的结果（识别得出/识别不出），
 * 不测内部实现细节。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildNudge,
  describeSlotKeys,
  extractAssistantText,
  hasCompleteSlots,
  parseSlots,
} from '../lib/slots.js';

const COMPLETE = [
  '## 改了什么',
  '把 README 第 3 行的运行说明改成 `python3 calc.py`。',
  '',
  '## 已阅未改',
  '无',
  '',
  '## 判断无问题',
  '第 10 行的 `ValueErrror` 拼写错误，判断为不影响运行说明的准确性，未改。',
].join('\n');

test('三栏齐全且都非空 → 判为合规', () => {
  assert.equal(hasCompleteSlots(COMPLETE), true);
});

test('三栏齐全 → parseSlots 报出三栏、无缺失无空白', () => {
  const { present, empty, missing } = parseSlots(COMPLETE);
  assert.deepEqual(present, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.deepEqual(empty, []);
  assert.deepEqual(missing, []);
});

test('只有一栏 → 另外两栏记为缺失', () => {
  const text = ['## 改了什么', '动手改了。'].join('\n');
  const { missing, empty } = parseSlots(text);
  assert.deepEqual(missing, ['seenUnchanged', 'judgedFine']);
  assert.deepEqual(empty, []);
  assert.equal(hasCompleteSlots(text), false);
});

test('标签在、内容空 → 记为空白而不是缺失', () => {
  const text = ['## 改了什么', '## 已阅未改', '## 判断无问题'].join('\n');
  const { empty, missing } = parseSlots(text);
  assert.deepEqual(missing, []);
  assert.deepEqual(empty, ['changed', 'seenUnchanged', 'judgedFine']);
});

test('内容写在标签同一行也能识别', () => {
  const text = [
    '改了什么：只动了 README。',
    '已阅未改：无',
    '判断无问题：calc.py 没问题',
  ].join('\n');
  assert.equal(hasCompleteSlots(text), true);
});

test('markdown 修饰不影响标签识别', () => {
  const text = [
    '**改了什么**：动了 README。',
    '- 已阅未改：无',
    '> 判断无问题：没问题',
  ].join('\n');
  assert.equal(hasCompleteSlots(text), true);
});

test('完全没提三栏的普通交付说明 → 三栏全缺', () => {
  const text = '我把 README 的运行说明改成了 python3 calc.py，实测输出 ok。';
  const { missing } = parseSlots(text);
  assert.deepEqual(missing, ['changed', 'seenUnchanged', 'judgedFine']);
  assert.equal(hasCompleteSlots(text), false);
});

test('非字符串输入不抛异常，按全缺处理', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(hasCompleteSlots(value), false);
  }
});

test('extractAssistantText 只取文本块，忽略工具块', () => {
  const message = {
    content: [
      { type: 'text', text: '第一段' },
      { type: 'tool-call', name: 'read' },
      { type: 'text', text: '第二段' },
    ],
  };
  assert.equal(extractAssistantText(message), '第一段\n第二段');
});

test('extractAssistantText 对畸形消息返回空串', () => {
  assert.equal(extractAssistantText(undefined), '');
  assert.equal(extractAssistantText({}), '');
  assert.equal(extractAssistantText({ content: 'nope' }), '');
});

test('describeSlotKeys 把 key 转成中文栏名并保持三栏顺序', () => {
  assert.equal(describeSlotKeys(['judgedFine', 'changed']), '改了什么、判断无问题');
  assert.equal(describeSlotKeys([]), '');
});

test('提醒文案指明缺了哪一栏，并点出第三栏的意义', () => {
  const nudge = buildNudge({ missing: ['judgedFine'], empty: [] });
  assert.match(nudge, /判断无问题/);
  assert.doesNotMatch(nudge, /已阅未改」只有标签/);
  assert.match(nudge, /第三栏是重点/);
});

test('提醒文案区分「缺失」与「只有标签」', () => {
  const nudge = buildNudge({ missing: ['seenUnchanged'], empty: ['judgedFine'] });
  assert.match(nudge, /缺了「已阅未改」/);
  assert.match(nudge, /「判断无问题」只有标签没有内容/);
});
