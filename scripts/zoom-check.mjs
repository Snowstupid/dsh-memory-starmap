/**
 * 真浏览器里验证滚轮缩放：起一个 headless Chrome，用 CDP 派发 mouseWheel，
 * 前后各截一张图，比较环形带子的屏幕包围盒宽度。
 *
 *   node scripts/zoom-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TARGET = process.env.MOBIUS_URL || 'http://127.0.0.1:8787/app?dist=2.6&yaw=0.4';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9333',
  '--window-size=1600,900',
  URL_TARGET,
], { stdio: 'ignore' });

async function targets() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9333/json');
      const list = await r.json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('CDP 没起来');
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((r) => ws.addEventListener('open', r, { once: true }));

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id: myId, method, params }));
});

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
};

await sleep(2500);
const before = await shot('zoom-before.png');

// 滚轮往里推（deltaY 为负 = 放大）
for (let i = 0; i < 5; i++) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 800, y: 450, deltaX: 0, deltaY: -240, modifiers: 0,
  });
  await sleep(120);
}
await sleep(1200);
const after = await shot('zoom-after.png');

ws.close();
chrome.kill();

console.log('before:', before);
console.log('after :', after);
