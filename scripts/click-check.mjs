/**
 * 验证：点一颗记忆星 → 高亮 + 局部放大。
 * 用 CDP 真发鼠标点击，前后各截一张。
 *
 *   node scripts/click-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8787/app';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9799',
  '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-click',
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9799/json')).json();
    page = list.find((t) => t.type === 'page');
    if (page) break;
  } catch { /* 等 */ }
  await sleep(250);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJS = async (expr) => {
  const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`docs/${name}.png`, Buffer.from(data, 'base64'));
  console.log('saved docs/' + name + '.png');
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: URL_TARGET });
await sleep(4200);

const spot = await evalJS('JSON.stringify(__MOBIUS__.spot())');
console.log('目标星', spot);
const { x, y } = JSON.parse(spot);

const before = await evalJS('JSON.stringify({dist: __MOBIUS__.cam.dist.toFixed(2)})');
await shot('click-before');

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 1 });
await sleep(1400);

const after = await evalJS('JSON.stringify({dist: __MOBIUS__.cam.dist.toFixed(2)})');
await shot('click-after');

console.log('相机距离', before, '→', after);

const d0 = JSON.parse(before).dist, d1 = JSON.parse(after).dist;
console.log(d1 < d0 - 1 ? 'ok   点击后拉近了' : 'FAIL 距离没变');
ws.close();
chrome.kill();
