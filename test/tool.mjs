/**
 * 模型侧验收：不装 DSH，用假 ctx 抓住工具与提示词段，跑四道验收题。
 *
 *   node test/tool.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mobius-tool-'));
process.env.DSH_HOME = tmpHome;
process.env.MOBIUS_TOOL = '1';

const store = await import('../lib/store.js');
const { applyModelSurface } = await import('../lib/model.js');

let tool = null;
let section = null;
const disposers = [];

const ctx = {
  get(name) {
    if (name === 'tools') {
      return {
        register(def) { tool = def; return () => { tool = null; }; },
      };
    }
    if (name === 'systemPrompt') {
      return {
        section(s) { section = s; return () => { section = null; }; },
      };
    }
    return undefined;
  },
  effect(fn) { disposers.push(fn()); },
};

applyModelSurface(ctx, {
  getIndex: store.getIndex,
  search: (index, query, topn) => store.search(index, query, topn, store.readOverrides()),
  hidden: () => new Set(store.readOverrides().hidden),
  log: (m) => console.log('  [log]', m),
});

let failed = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) { failed++; process.exitCode = 1; }
};

ok(tool && tool.name === 'mobius_recall', '注册了工具 mobius_recall');
ok(typeof section?.text === 'function', '注册了提示词段 mobius:index');

const promptText = typeof section?.text === 'function' ? section.text() : '';
ok(promptText.includes('mobius_recall') && promptText.includes('本地对话索引'), '提示词里写了索引与工具名', promptText.slice(0, 60) + '…');

const ask = async (query, opts = {}) => tool.execute({ query, ...opts });

// 一、应命中"为什么放弃严格莫比乌斯"
{
  const r = await ask('莫比乌斯 放弃 八字');
  ok(r.found === true, '① 命中"放弃严格莫比乌斯"', `used=${r.used}`);
  ok(/八字|莫比乌斯/.test(r.text), '① 内容里出现了八字/莫比乌斯');
  ok(/用户说的|助手当时说的/.test(r.text), '① 每条带了"是谁说的"');
  ok(/\d{4}-\d{2}-\d{2}/.test(r.text), '① 每条带了日期');
  ok(r.text.includes('可能已过时'), '① 头部有"可能已过时"的提示');
}

// 二、应命中"记忆星显示的是概要"
{
  const r = await ask('记忆星 概要');
  ok(r.found === true, '② 命中"记忆星显示概要"', `used=${r.used}`);
  ok(/概要/.test(r.text), '② 内容里出现了"概要"');
}

// 三、应命中"节点只有一颗"的 bug
{
  const r = await ask('投影 对象 复用 节点');
  ok(r.found === true, '③ 命中"节点叠成一颗"的 bug', `used=${r.used}`);
}

// 四、完全没聊过的话题：必须说没找到，不许编
// 用一个每次随机生成的串——写死任何词都会被索引收录，下一跑就"命中"了
{
  const probe = `zq${Math.random().toString(36).slice(2, 8)}x${Math.random().toString(36).slice(2, 8)}`;
  const r = await ask(probe);
  ok(r.found === false, '④ 没聊过的话题返回 found=false', probe);
  ok(/没有足够相关的记录/.test(r.text), '④ 明确说没查到，而不是硬塞', r.text.slice(0, 40));
}

// 空 query = 最近的兜底，必须标 fallback
{
  const r = await ask('');
  ok(r.fallback === true && r.ok === true, '空 query 走最近兜底并标 fallback');
  ok(r.text.includes('recent-fallback'), '兜底文本里标了来源模式');
}

// 预算必须压住
{
  const r = await ask('记忆 星图', { budget: 300 });
  ok(r.used <= 300 || r.used === 0, '预算 300 生效', `used=${r.used}`);
}

// 输出结构与声明的 schema 对得上
{
  const r = await ask('记忆');
  const keys = Object.keys(r).sort().join(',');
  ok(keys === 'dropped,fallback,found,ok,text,used', '返回字段与 output.schema 一致', keys);
}

for (const d of disposers) { try { d?.(); } catch { /* ignore */ } }
fs.rmSync(tmpHome, { recursive: true, force: true });
console.log(failed ? `有 ${failed} 项失败` : '全部通过');
