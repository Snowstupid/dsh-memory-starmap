/**
 * 交互验证：用 CDP 真发鼠标事件，检查
 *   1) 纵向拖拽能不能转过 ±90°（旧版本被夹在 -0.15 ~ 1.45）
 *   2) 松手后还有没有惯性
 *   3) 滚轮缩放是否生效
 *
 *   node scripts/interact-check.mjs
 */
import { spawn } from 'node:child_process';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8787/app';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=9666', '--user-data-dir=D:/DSHWORK/mobius-memory/.chrome-act',
  '--window-size=1600,900', URL_TARGET,
], { stdio: 'ignore' });

async function target() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:9666/json')).json();
      const p = list.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* 等 */ }
    await sleep(250);
  }
  throw new Error('CDP 起不来');
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = ++id;
  pending.set(myId, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJS = async (expr) => {
  const { result } = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  return result.value;
};

await send('Runtime.enable');
await sleep(3000);

const cam0 = await evalJS('({ pitch: __MOBIUS__.target.pitch, yaw: __MOBIUS__.target.yaw, dist: __MOBIUS__.target.dist })');
console.log('初始', JSON.stringify(cam0));

const mouse = (type, x, y, extra = {}) =>
  send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' ? 'none' : 'left', buttons: 1, clickCount: 1, ...extra });

// 竖直往下拖 700px（相当于把视角翻过去）
await mouse('mousePressed', 800, 300);
for (let i = 1; i <= 20; i++) {
  await mouse('mouseMoved', 800, 300 + i * 35);
  await sleep(16);
}
await mouse('mouseReleased', 800, 880);
await sleep(100);

const cam1 = await evalJS('({ pitch: __MOBIUS__.target.pitch, yaw: __MOBIUS__.target.yaw })');
console.log('拖完', JSON.stringify(cam1));

await sleep(600);
const cam2 = await evalJS('({ pitch: __MOBIUS__.target.pitch, yaw: __MOBIUS__.target.yaw })');
console.log('松手 600ms 后（惯性）', JSON.stringify(cam2));

// 滚轮缩放
const before = await evalJS('__MOBIUS__.target.dist');
for (let i = 0; i < 4; i++) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 800, y: 450, deltaX: 0, deltaY: -200, modifiers: 0 });
  await sleep(100);
}
const after = await evalJS('__MOBIUS__.target.dist');
console.log('缩放 dist', before.toFixed(2), '→', after.toFixed(2));

const pitchOK = Math.abs(cam1.pitch - cam0.pitch) > 1.5;
const inertiaOK = Math.abs(cam2.pitch - cam1.pitch) > 0.002;
const zoomOK = after < before - 0.2;
console.log(`${pitchOK ? 'ok  ' : 'FAIL'} 纵向可转过 ±1.5 弧度（旧版夹在 1.45）`);
console.log(`${inertiaOK ? 'ok  ' : 'FAIL'} 松手后仍有惯性`);
console.log(`${zoomOK ? 'ok  ' : 'FAIL'} 滚轮缩放生效`);

ws.close();
chrome.kill();
process.exit(pitchOK && inertiaOK && zoomOK ? 0 : 1);
