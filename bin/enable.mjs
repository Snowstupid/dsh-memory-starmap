#!/usr/bin/env node
/**
 * 把本插件挂进某个 profile 的 dsh.profile.bundles。
 *
 * 为什么需要它：`dsh plugin add` 只是把参数转发给 pnpm，不碰 bundles；
 * 而没进 bundles 的包，DSH 启动时根本不会加载（/mobius/* 全部 404）。
 * GUI 的插件管理器装包时会自己做这一步（reconcile），CLI 装不会。
 *
 * 用法（装完再跑一次）：
 *   dsh plugin --profile desktop add dsh-memory-starmap
 *   node node_modules/dsh-memory-starmap/bin/enable.mjs desktop
 *
 * 参数：profile 名，默认 web。可用 DSH_HOME 覆盖 ~/.dsh。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-memory-starmap';

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const profile = process.argv[2] || process.env.DSH_PROFILE || 'web';
const manifestPath = path.join(home, 'profiles', profile, 'package.json');

if (!fs.existsSync(manifestPath)) {
  console.error(`找不到 profile：${manifestPath}`);
  console.error('先确认 profile 名（Web 端一般 web，桌面端 desktop），或用 DSH_HOME 指定 DSH 目录。');
  process.exit(1);
}

const raw = fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '');
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (e) {
  console.error(`profile 的 package.json 不是合法 JSON：${String(e.message || e)}`);
  process.exit(1);
}

// 包里必须真的声明了 bundle，否则挂上去也只会空转
const here = path.dirname(fileURLToPath(import.meta.url));
const selfPkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
if (selfPkg.dsh?.bundle?.patch === undefined) {
  console.error('这个包没有声明 dsh.bundle.patch，挂进 bundles 也没有意义。');
  process.exit(1);
}

manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];

if (bundles.includes(PKG)) {
  console.log(`${profile}: bundles 里已经有 ${PKG}，不用重复加。`);
  process.exit(0);
}

bundles.push(PKG);
manifest.dsh.profile.bundles = bundles;

const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(manifestPath, backup);
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${profile}: 已把 ${PKG} 加进 dsh.profile.bundles`);
console.log(`  备份：${backup}`);
console.log('  下一步：重启 DSH，侧栏才会出现「记忆星图」。');
