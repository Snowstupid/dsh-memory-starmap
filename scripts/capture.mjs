import { spawn } from 'node:child_process';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = process.argv[2] || 'http://127.0.0.1:8787/app';
const shots = (process.argv[3] || '3500').split(',').map(Number);
const prefix = process.argv[4] || 'shot';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=9788',
  '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-cap',
  '--window-size=1600,900', 'about:blank',
], { stdio: 'ignore' });

let page;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch('http://127.0.0.1:9788/json')).json();
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

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url });

let last = 0;
for (const ms of shots) {
  await sleep(Math.max(0, ms - last));
  last = ms;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const file = `docs/${prefix}-${ms}.png`;
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('saved', file);
}

ws.close();
chrome.kill();
