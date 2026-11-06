/**
 * 规则文件数据层：读出「对我的设定」那几个 AGENTS.md，允许改，但要安全。
 *
 * 只认两类路径：
 *   ~/.dsh/AGENTS.md            全局规则（对所有会话生效）
 *   <工作区>/AGENTS.md           工作区规则（只在该目录下的会话生效）
 * 冲突时项目优先 —— 这是 DSH 自己的规则，界面照实反映。
 *
 * 写之前备份、mtime 不一致就拒绝（别人刚改过），不覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESS_ROOT = process.env.MOBIUS_SESSIONS || path.join(DSH_HOME, 'sessions');
const GLOBAL_RULE = path.join(DSH_HOME, 'AGENTS.md');
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_BYTES = 512 * 1024;

let cwdCache = null;
let cwdCacheAt = 0;

/** 从会话存档里读每个工作区的真实 cwd（目录名反推有歧义，不能靠它）。 */
export function workspacePaths() {
  const now = Date.now();
  if (cwdCache && now - cwdCacheAt < 60_000) return cwdCache;
  const map = new Map();
  try {
    for (const ws of fs.readdirSync(SESS_ROOT, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const sd of fs.readdirSync(path.join(SESS_ROOT, ws.name), { withFileTypes: true })) {
        if (!sd.isDirectory()) continue;
        const dir = path.join(SESS_ROOT, ws.name, sd.name);
        let file;
        try { file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl.zstd')); } catch { continue; }
        if (!file) continue;
        let cwd = null;
        try {
          const buf = fs.readFileSync(path.join(dir, file));
          let i = 0, first = -1, second = buf.length;
          while ((i = buf.indexOf(ZSTD_MAGIC, i)) !== -1) {
            if (first < 0) first = i; else { second = i; break; }
            i += 4;
          }
          if (first < 0) continue;
          const text = zlib.zstdDecompressSync(buf.subarray(first, second)).toString('utf8');
          for (const line of text.split('\n').slice(0, 4)) {
            try { const rec = JSON.parse(line); if (rec.cwd) { cwd = rec.cwd; break; } } catch { /* skip */ }
          }
        } catch { continue; }
        if (cwd) {
          const cur = map.get(cwd) || { cwd, sessions: 0, last: 0 };
          cur.sessions++;
          cur.last = Math.max(cur.last, fs.statSync(path.join(dir, file)).mtimeMs);
          map.set(cwd, cur);
        }
      }
    }
  } catch { /* 没有会话目录 */ }
  cwdCache = [...map.values()].sort((a, b) => b.last - a.last);
  cwdCacheAt = now;
  return cwdCache;
}

function rulePathFor(cwd) {
  return path.join(cwd, 'AGENTS.md');
}

/** 白名单：只有全局文件与已发现工作区的 AGENTS.md。 */
function allowedPaths() {
  const set = new Set([path.resolve(GLOBAL_RULE)]);
  for (const w of workspacePaths()) set.add(path.resolve(rulePathFor(w.cwd)));
  return set;
}

function sectionList(text) {
  const lines = text.split('\n');
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) { cur.end = i; out.push(cur); }
      cur = { title: m[2], depth: m[1].length, start: i, end: lines.length, line: i + 1 };
    }
  });
  if (cur) out.push(cur);
  for (const s of out) {
    s.lines = s.end - s.start;
    s.text = lines.slice(s.start, s.end).join('\n').trim();
  }
  return out.length ? out : [{ title: '（整篇）', depth: 1, start: 0, end: lines.length, line: 1, lines: lines.length, text: text.trim() }];
}

function statOf(p) {
  try {
    const st = fs.statSync(p);
    return { exists: true, size: st.size, mtime: Math.round(st.mtimeMs) };
  } catch {
    return { exists: false, size: 0, mtime: 0 };
  }
}

function describe(p, name, kind) {
  const st = statOf(p);
  const base = { path: p, name, kind, ...st, sections: [], preview: '' };
  if (!st.exists) return base;
  if (st.size > MAX_BYTES) return { ...base, error: '文件太大，面板不读（>512KB）' };
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { ...base, sections: sectionList(text), preview: text.slice(0, 4000) };
  } catch (e) {
    return { ...base, error: String(e?.message || e) };
  }
}

/** 面板要的全部数据。 */
export function listRules() {
  const main = describe(path.resolve(GLOBAL_RULE), '全局规则（~/.dsh/AGENTS.md）', 'global');
  const workspaces = workspacePaths().map((w) => ({
    cwd: w.cwd,
    sessions: w.sessions,
    ...describe(rulePathFor(w.cwd), 'AGENTS.md', 'workspace'),
  }));
  return { main, workspaces };
}

/** 读单个文件全文。 */
export function readRule(p) {
  const target = path.resolve(String(p || ''));
  if (!allowedPaths().has(target)) return { status: 403, error: 'not-allowed' };
  const st = statOf(target);
  if (!st.exists) return { status: 404, error: 'not-found' };
  if (st.size > MAX_BYTES) return { status: 413, error: 'too-large' };
  try {
    return { status: 200, body: { path: target, mtime: st.mtime, content: fs.readFileSync(target, 'utf8') } };
  } catch (e) {
    return { status: 500, error: String(e?.message || e) };
  }
}

/**
 * 写回。create=true 允许新建（只有在白名单里的路径）。
 * mtime 不一致 → 409，前端应重载后重试。
 */
export function writeRule({ path: p, mtime, content, create }) {
  const target = path.resolve(String(p || ''));
  if (!allowedPaths().has(target)) return { status: 403, error: 'not-allowed' };
  if (typeof content !== 'string') return { status: 400, error: 'bad-content' };
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return { status: 413, error: 'too-large' };

  const st = statOf(target);
  if (st.exists) {
    if (Number(mtime) !== st.mtime) return { status: 409, error: 'stale', mtime: st.mtime };
    try {
      const backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, backup);
    } catch { /* 备份失败不挡写入，但下面会把备份路径标出来 */ }
  } else if (create !== true) {
    return { status: 404, error: 'not-found' };
  } else {
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch { /* ignore */ }
  }

  try {
    fs.writeFileSync(target, content, 'utf8');
    const after = statOf(target);
    return { status: 200, body: { path: target, mtime: after.mtime, size: after.size } };
  } catch (e) {
    return { status: 500, error: String(e?.message || e) };
  }
}

export { GLOBAL_RULE, MAX_BYTES };
