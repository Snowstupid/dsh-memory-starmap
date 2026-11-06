/**
 * 浏览器半边：在 DSH 侧栏挂一个「记忆星图」入口，点开进入主面板里的整页星图。
 *
 * 侧栏入口走 sidebar.panellist（list 座位），页面本体走 main（keyed 座位），
 * 两者共用一个 id，点图标就等于切到这块面板。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-starmap',
  factory: (require) => {
    var module = { exports: {} };
    var react = require('react');
    var jsx = require('react/jsx-runtime');
    var inject = ['slots'];

    var PANEL_ID = 'mobius';
    var APP = '/mobius/app';

    // 侧栏图标：莫比乌斯带，两条错位的环，中间一道扭转
    function StarmapIcon({ size }) {
      var s = size || 18;
      return jsx.jsxs('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
        children: [
          jsx.jsx('path', {
            d: 'M12 4c4.4 0 8 3.6 8 8s-3.6 8-8 8-8-3.6-8-8 3.6-8 8-8z',
            opacity: 0.9,
          }, 'ring'),
          jsx.jsx('path', {
            d: 'M6 8.2c2.2-1.9 5.5-2.2 8-.6 2.5 1.6 3.2 4.8 1.6 7.3-1.6 2.5-4.8 3.2-7.3 1.6',
            opacity: 0.55,
          }, 'twist'),
          jsx.jsx('circle', { cx: '12', cy: '12', r: '1.3', fill: 'currentColor', stroke: 'none' }, 'core'),
        ],
      });
    }

    function StarmapPanel() {
      return jsx.jsx('iframe', {
        src: APP,
        title: '记忆星图',
        allow: 'clipboard-write',
        style: {
          width: '100%',
          height: '100%',
          minHeight: '560px',
          border: '0',
          display: 'block',
          background: '#05070f',
        },
      });
    }

    function apply(ctx) {
      var slots = ctx && ctx.slots;
      if (!slots || typeof slots.inject !== 'function') {
        // 老宿主没有 slots：退回一个浮动按钮，至少还能进页面
        return mountFallback();
      }

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 40,
        label: () => '记忆星图',
      }, StarmapIcon));

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, StarmapPanel));

      return () => {};
    }

    function mountFallback() {
      if (document.getElementById('mobius-fallback')) return () => {};
      var host = document.createElement('div');
      host.id = 'mobius-fallback';
      var root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>:host{all:initial}'
        + '.b{position:fixed;right:26px;bottom:92px;height:36px;padding:0 14px;border-radius:12px;'
        + 'background:rgba(18,26,58,.94);border:1px solid rgba(150,175,255,.34);color:#cdd8ff;'
        + 'font:13px/36px system-ui,"Microsoft YaHei",sans-serif;letter-spacing:2px;cursor:pointer;'
        + 'z-index:2147483000;box-shadow:0 6px 20px rgba(0,0,0,.5)}'
        + '.b:hover{border-color:rgba(170,195,255,.6)}</style>'
        + '<div class="b">✦ 星图</div>';
      document.body.appendChild(host);
      root.querySelector('.b').addEventListener('click', () => {
        window.open(APP, '_blank', 'width=1440,height=900');
      });
      return () => host.remove();
    }

    var client_exports = {};
    Object.defineProperty(client_exports, '__esModule', { value: true });
    Object.defineProperty(client_exports, 'apply', { enumerable: true, get: function () { return apply; } });
    Object.defineProperty(client_exports, 'inject', { enumerable: true, get: function () { return inject; } });
    module.exports = client_exports;
    return module.exports;
  },
});
