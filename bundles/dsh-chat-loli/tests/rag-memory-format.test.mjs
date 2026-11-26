import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailySummaryCache, formatRagSearchResult, formatSummary } from '../lib/rag-memory.js';

test('formats memories without ids, dream tags, status lines, or section headings', () => {
  const store = {
    items: [
      { id: 'mem_4', pinned: false, tags: ['群友身份', '雷石东', '梦境整理'], text: '群友雷石东的群昵称为“群向日葵”。' },
      { id: 'mem_5', pinned: false, tags: ['群友身份', '叶子233', '偏好习惯', '梦境整理'], text: '群友🍥叶子233⚓的群昵称为“Leaf2.3-flash-38T-A1.6B”，曾提到自己有新西兰家宽机。' },
      { id: 'mem_8', pinned: false, tags: ['本地文件', '系统路径', '梦境整理'], text: '生图结果保存在 /vol1/dsh-image-gen/。' },
      { id: 'mem_9', pinned: false, tags: ['主人互动', 'Bemly_', '梦境整理'], text: 'Bemly_ 曾让小鱼生图。' },
      { id: 'mem_10', pinned: false, tags: ['Bemly_', 'magpie', '工具与插件', '梦境整理'], text: '群友 Bemly_ 编写并发布了 magpie-unsafe-archive。' },
      { id: 'mem_13', pinned: false, tags: ['群友', '中转站', '梦境整理'], text: '群友🍥叶子233⚓提到自己的中转站接入了上游自部署的 DeepSeek 服务。' },
      { id: 'mem_14', pinned: false, tags: ['群友', '称呼', '梦境整理'], text: '亚托莉是群内的另一个 AI 角色，在被小鱼纠正性别后改口称呼小鱼为“小肥鱼姐姐”。' },
      { id: 'mem_15', pinned: false, tags: ['群内账号', '运维', '梦境整理'], text: '群内账号“转发鱼”负责转发设备 MEminiFnOS 的网络带宽占用告警信息。' },
    ],
  };
  assert.equal(formatSummary(store), [
    '[群u:雷石东]昵称为“群向日葵”。',
    '[群u:叶子233][偏好习惯]昵称为“Leaf2.3-flash-38T-A1.6B”，曾提到自己有新西兰家宽机。',
    '[本地文件][系统路径]生图结果保存在 /vol1/dsh-image-gen/。',
    '[群u:Bemly_][主人互动]曾让小鱼生图。',
    '[群u:Bemly_][magpie][工具与插件]编写并发布了 magpie-unsafe-archive。',
    '[群u:🍥叶子233⚓][中转站]提到自己的中转站接入了上游自部署的 DeepSeek 服务。',
    '[群u:亚托莉][称呼]群内的另一个 AI 角色，在被小鱼纠正性别后改口称呼小鱼为“小肥鱼姐姐”。',
    '[群u:转发鱼][运维]负责转发设备 MEminiFnOS 的网络带宽占用告警信息。',
  ].join('\n'));
});

test('includes the stored time in rendered RAG search hits', () => {
  assert.equal(formatRagSearchResult({
    mode: 'vector',
    hits: [{
      id: 'mem_16',
      layer: 'long',
      score: 0.9132,
      text: 'Nyaser 被指定为小鱼的妈妈。',
      tags: ['Nyaser'],
      pinned: false,
      files: [],
      createdAt: '2026-11-25T16:27:58.881Z',
    }],
  }), 'RAG 检索命中 1 条（模式：vector）：\n- (0.913) [长期] mem_16 [Nyaser] 时间=2026-11-25T16:27:58.881Z: Nyaser 被指定为小鱼的妈妈。');
});

test('keeps pinned and recent limits without adding headings', () => {
  const store = {
    items: [
      { id: 'a', pinned: true, tags: [], text: '固定一' },
      { id: 'b', pinned: true, tags: [], text: '固定二' },
      { id: 'c', pinned: false, tags: [], text: '最近一' },
      { id: 'd', pinned: false, tags: [], text: '最近二' },
    ],
  };
  assert.equal(formatSummary(store, { maxPinned: 1, maxRecent: 1 }), '固定二\n最近二');
});

test('recomputes the dynamic summary at most once per local day', () => {
  let day = '2026-11-25';
  let calls = 0;
  const cached = createDailySummaryCache(() => {
    calls += 1;
    return `summary-${calls}`;
  }, () => day);
  assert.equal(cached(), 'summary-1');
  assert.equal(cached(), 'summary-1');
  assert.equal(calls, 1);
  day = '2026-11-26';
  assert.equal(cached(), 'summary-2');
  assert.equal(calls, 2);
});
