/*

 * WeFlow "Bot" renderer panel.

 *

 * Injected by resources/wfai/hook.js into the main window. Adds one row to the

 * existing sidebar and renders a full page overlay that talks to the sidecar's

 * localhost API (see hook.js).

 */

(function () {

  'use strict';

  const WFAI_BUILD = '2026-11-25T21:07:37';

  if (window.__WFAI_UI__) {

    if (window.__WFAI_UI__.build === WFAI_BUILD) {

      try { window.__WFAI_UI__.reopen(); } catch (_) {}

      return;

    }

    // 面板升级了：先把旧的一份彻底拆掉，再用新代码重建

    try { window.__WFAI_UI__.destroy && window.__WFAI_UI__.destroy(); } catch (_) {}

    try {

      document.querySelectorAll('#wfai-page, #wfai-nav-row, #wfai-style, #wfai-toast').forEach((n) => n.remove());

    } catch (_) {}

    delete window.__WFAI_UI__;

  }



  const BOOT = window.__WFAI__ || {};

  const API = `http://127.0.0.1:${BOOT.port}/`;

  const TOKEN = BOOT.token || '';

  const els = {};

  let uiState = null;

  let tab = 'overview';

  let msgFilter = 'all';

  let pollTimer = null;

  const DIRTY = new Set();          // 用户改过但还没保存的输入框 id

  const DIRTY_VALS = new Map();     // 对应的最新值（页面切走后 DOM 没了也要留底）

  try { window.__WFAI_DIRTY = DIRTY; window.__WFAI_DIRTY_VALS = DIRTY_VALS; } catch (_) {}

  let CATALOG = null;                                  // 联系人 + 群聊目录

  let dataPathsLoaded = false;   // 数据目录信息只拉一次，避免重绘死循环
  const WL = { query: '', kind: 'all', showAll: false };   // 名单选择器状态（showAll=展开全部）

  const WLF = { loaded: false, list: [], mode: 'whitelist', enabled: true };  // WeFlow 侧状态

  let ARCH = null;                                     // 单独归档规则状态



  // ------------------------------------------------------------------ helpers

  const h = (html) => {

    const t = document.createElement('template');

    t.innerHTML = html.trim();

    return t.content.firstElementChild;

  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtTime = (ts) => {

    if (!ts) return '--:--:--';

    const d = new Date(ts);

    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

  };

  const ago = (ts) => {

    if (!ts) return '从未';

    const s = Math.floor((Date.now() - ts) / 1000);

    if (s < 60) return `${s} 秒前`;

    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;

    return `${Math.floor(s / 3600)} 小时前`;

  };



  // 请求失败不能静默 —— 否则面板看起来就是"按钮全点不动"
  let apiFailToastAt = 0;
  function apiFailNotify(err) {
    const now = Date.now();
    if (now - apiFailToastAt < 8000) return;
    apiFailToastAt = now;
    try {
      toast('与 Bot 的连接断了，请重启 WeFlow（' + (err && err.message ? err.message : '网络错误') + '）', 'err');
    } catch (_) {}
  }

  async function api(path, body) {

    const opt = body

      ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-wfai': TOKEN }, body: JSON.stringify(body) }

      : { method: 'GET', headers: { 'x-wfai': TOKEN } };

    let r;
    try {
      r = await fetch(API + path, opt);
    } catch (netErr) {
      apiFailNotify(netErr);
      throw netErr;
    }

    if (!r.ok) {
      apiFailNotify(new Error('HTTP ' + r.status));
      throw new Error(`${path} → HTTP ${r.status}`);
    }

    return r.json();

  }



  function toast(msg, kind) {

    const box = els.toast;

    if (!box) return;

    const n = h(`<div class="wfai-toast ${kind || ''}">${esc(msg)}</div>`);

    box.appendChild(n);

    setTimeout(() => { n.classList.add('out'); setTimeout(() => n.remove(), 400); }, 3200);

  }



  // ------------------------------------------------------------------- styles

  const CSS = `

  .wfai-nav{position:relative}

  .wfai-nav .wfai-dot{position:absolute;right:14px;top:50%;transform:translateY(-50%);width:7px;height:7px;border-radius:50%;background:#5b5348;box-shadow:0 0 0 3px rgba(0,0,0,.18)}

  .wfai-nav .wfai-dot.on{background:#5ad19a}

  .wfai-nav .wfai-dot.err{background:#e2705f}

  .wfai-page{position:fixed;z-index:60;display:flex;flex-direction:column;background:var(--wfai-bg);color:var(--wfai-fg);font-size:13px;overflow:hidden}

  .wfai-page.hidden{display:none}

  :root{--wfai-bg:#1b1917;--wfai-card:#232019;--wfai-card2:#2a2620;--wfai-fg:#e9e2d6;--wfai-dim:#9b948a;--wfai-line:rgba(255,255,255,.09);--wfai-acc:#f6cf9b;--wfai-acc2:#ffd9a8;--wfai-ok:#5ad19a;--wfai-warn:#e8b45c;--wfai-err:#e2705f}

  .wfai-hd{display:flex;align-items:center;gap:12px;padding:16px 22px 10px}

  .wfai-hd h1{margin:0;font-size:18px;font-weight:650;letter-spacing:.2px}

  .wfai-hd .sub{color:var(--wfai-dim);font-size:12px}

  .wfai-spacer{flex:1}

  .wfai-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:1px solid var(--wfai-line);background:var(--wfai-card);font-size:12px;color:var(--wfai-dim)}

  .wfai-pill b{color:var(--wfai-fg);font-weight:600}

  .wfai-led{width:8px;height:8px;border-radius:50%;background:#5b5348}

  .wfai-led.on{background:var(--wfai-ok);box-shadow:0 0 8px rgba(90,209,154,.7)}

  .wfai-led.err{background:var(--wfai-err)}

  .wfai-led.warn{background:var(--wfai-warn)}

  .wfai-stats{display:grid;grid-template-columns:repeat(7,1fr);gap:10px;padding:4px 22px 12px}

  .wfai-stat{background:var(--wfai-card);border:1px solid var(--wfai-line);border-radius:10px;padding:10px 12px}

  .wfai-stat .k{color:var(--wfai-dim);font-size:11px}

  .wfai-stat .v{font-size:19px;font-weight:650;margin-top:2px}

  .wfai-tabs{display:flex;gap:6px;padding:0 22px;border-bottom:1px solid var(--wfai-line);align-items:center}
.wfai-savebar{margin-left:auto;display:flex;align-items:center;gap:8px;padding:4px 0}
.wfai-savebar .dirty{font-size:12px;color:#e8b04b;display:none}
.wfai-savebar.dirty .dirty{display:inline}
.wfai-savebar #wfai-save-top{padding:5px 14px;font-size:13px}
.wfai-savebar #wfai-save-top.has{box-shadow:0 0 0 2px rgba(232,176,75,.35)}

  .wfai-tab{padding:9px 14px;border-radius:8px 8px 0 0;color:var(--wfai-dim);cursor:pointer;border:1px solid transparent;border-bottom:none;user-select:none}

  .wfai-tab:hover{color:var(--wfai-fg)}

  .wfai-tab.act{color:#201a10;background:var(--wfai-acc);font-weight:650;border-color:var(--wfai-acc)}

  .wfai-body{flex:1;overflow:auto;padding:16px 22px 26px}

  .wfai-body::-webkit-scrollbar{width:10px}

  .wfai-body::-webkit-scrollbar-thumb{background:#3a342c;border-radius:8px}

  .wfai-card{background:var(--wfai-card);border:1px solid var(--wfai-line);border-radius:12px;padding:14px 16px;margin-bottom:12px}

  .wfai-card h3{margin:0 0 10px;font-size:13px;color:var(--wfai-acc);font-weight:650;letter-spacing:.3px}

  .wfai-row{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:8px 0}

  .wfai-row label{min-width:132px;color:var(--wfai-dim);font-size:12px}

  .wfai-in,.wfai-sel,.wfai-ta{background:#191611;border:1px solid var(--wfai-line);color:var(--wfai-fg);border-radius:8px;padding:7px 10px;font-size:12.5px;outline:none;font-family:inherit}

  .wfai-in:focus,.wfai-ta:focus{border-color:var(--wfai-acc)}

  .wfai-in{flex:1;min-width:180px}

  .wfai-in.n{flex:0 0 96px;min-width:96px}

  .wfai-ta{width:100%;min-height:78px;resize:vertical;line-height:1.55}

  .wfai-btn{border:1px solid var(--wfai-line);background:var(--wfai-card2);color:var(--wfai-fg);border-radius:8px;padding:7px 13px;font-size:12.5px;cursor:pointer;font-family:inherit}

  .wfai-btn:hover{border-color:var(--wfai-acc);color:var(--wfai-acc2)}

  .wfai-btn.pri{background:var(--wfai-acc);color:#221a0e;border-color:var(--wfai-acc);font-weight:650}

  .wfai-btn.pri:hover{background:var(--wfai-acc2);color:#221a0e}

  .wfai-btn.ghost{background:transparent}

  .wfai-sw{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}

  .wfai-sw i{width:38px;height:21px;border-radius:999px;background:#3b352c;position:relative;transition:.16s;display:inline-block}

  .wfai-sw i::after{content:'';position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:#cfc7ba;transition:.16s}

  .wfai-sw.on i{background:var(--wfai-acc)}

  .wfai-sw.on i::after{left:19px;background:#241c10}

  .wfai-sw.danger.on i{background:var(--wfai-err)}

  .wfai-msg{display:flex;gap:10px;padding:9px 12px;border-radius:9px;background:var(--wfai-card);border:1px solid var(--wfai-line);margin-bottom:7px;align-items:flex-start}

  .wfai-msg .t{color:var(--wfai-dim);font-size:11px;flex:0 0 62px;padding-top:2px}

  .wfai-msg .who{flex:0 0 118px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}

  .wfai-msg .txt{flex:1;white-space:pre-wrap;word-break:break-word;line-height:1.5}

  .wfai-tag{flex:0 0 auto;font-size:11px;padding:2px 7px;border-radius:6px;background:#302a22;color:var(--wfai-dim)}

  .wfai-tag.ok{background:rgba(90,209,154,.16);color:var(--wfai-ok)}

  .wfai-tag.dry{background:rgba(246,207,155,.16);color:var(--wfai-acc)}

  .wfai-tag.err{background:rgba(226,112,95,.16);color:var(--wfai-err)}

  .wfai-tag.off{background:rgba(255,255,255,.05)}

  .wfai-msg.out{background:rgba(246,207,155,.06);border-color:rgba(246,207,155,.18)}

  .wfai-log{font-family:ui-monospace,Consolas,monospace;font-size:11.5px;line-height:1.65;white-space:pre-wrap;word-break:break-word;background:#151310;border:1px solid var(--wfai-line);border-radius:10px;padding:12px;max-height:calc(100vh - 300px);overflow:auto;color:#c9c1b4}

  .wfai-log .error{color:#e2705f}

  .wfai-log .warn{color:#e8b45c}

  .wfai-empty{color:var(--wfai-dim);text-align:center;padding:36px 0;font-size:12.5px}

  .wfai-note{color:var(--wfai-dim);font-size:11.5px;line-height:1.6;margin-top:6px}

  .wfai-warnbar{display:flex;gap:9px;align-items:center;background:rgba(232,180,92,.12);border:1px solid rgba(232,180,92,.35);color:#f0d3a1;border-radius:9px;padding:9px 13px;margin-bottom:12px;font-size:12.5px}

  .wfai-warnbar.danger{background:rgba(226,112,95,.12);border-color:rgba(226,112,95,.35);color:#f3b8ae}

  #wfai-toast{position:fixed;right:24px;bottom:26px;z-index:99;display:flex;flex-direction:column;gap:8px;align-items:flex-end}

  .wfai-toast{background:#2b2519;border:1px solid var(--wfai-line);color:var(--wfai-fg);padding:9px 14px;border-radius:9px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.45);transition:.35s;max-width:420px}

  .wfai-toast.err{border-color:rgba(226,112,95,.5);color:#f3b8ae}

  .wfai-toast.out{opacity:0;transform:translateY(6px)}

  .wfai-pick{display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:7px;cursor:pointer;font-size:12.5px}

  .wfai-pick:hover{background:rgba(255,255,255,.05)}

  .wfai-pick input{accent-color:var(--wfai-acc);width:14px;height:14px;cursor:pointer}

  .wfai-pick .nm{flex:0 0 170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .wfai-pick .uid{flex:1;color:var(--wfai-dim);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

  .wfai-list{max-height:330px;overflow:auto;border:1px solid var(--wfai-line);border-radius:9px;padding:4px;background:#191611}

  .wfai-chip{font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--wfai-line);color:var(--wfai-dim);cursor:pointer;user-select:none}

  .wfai-chip.on{background:var(--wfai-acc);color:#221a0e;border-color:var(--wfai-acc);font-weight:650}

  .wfai-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px}

  @media (max-width:1200px){.wfai-2col{grid-template-columns:1fr}.wfai-stats{grid-template-columns:repeat(3,1fr)}}

  `;



  // ---------------------------------------------------------------- nav + page

  function navItem() {

    const a = h(`<a class="nav-item wfai-nav" href="javascript:void 0" title="Bot">

      <span class="nav-icon" aria-hidden="true">

        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">

          <rect x="3.5" y="7.5" width="17" height="12" rx="4"></rect>

          <path d="M12 7.5V4.2"></path><circle cx="12" cy="3.2" r="1.2"></circle>

          <circle cx="8.6" cy="13.4" r="1.25" fill="currentColor" stroke="none"></circle>

          <circle cx="15.4" cy="13.4" r="1.25" fill="currentColor" stroke="none"></circle>

          <path d="M9.4 16.6h5.2"></path>

        </svg>

      </span>

      <span class="nav-label">Bot</span>

      <span class="wfai-dot"></span>

    </a>`);

    a.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); open(); });

    return a;

  }



  function buildPage() {

    const page = h(`<section class="wfai-page hidden" id="wfai-page">

      <div class="wfai-hd">

        <h1>Bot</h1><span class="sub">微信 AI 助手 · 由 WeFlow 推送驱动</span>

        <div class="wfai-spacer"></div>

        <span class="wfai-pill"><span class="wfai-led" id="wfai-led-conn"></span><span id="wfai-txt-conn">未连接</span></span>

        <span class="wfai-pill">监听 <b id="wfai-txt-run">已停止</b></span>

        <button class="wfai-btn pri" id="wfai-btn-toggle">开始监听</button>

      </div>

      <div class="wfai-stats">

        <div class="wfai-stat"><div class="k">收到</div><div class="v" id="wfai-s-recv">0</div></div>

        <div class="wfai-stat"><div class="k">已生成回复</div><div class="v" id="wfai-s-replied">0</div></div>

        <div class="wfai-stat"><div class="k">已发送</div><div class="v" id="wfai-s-sent">0</div></div>

        <div class="wfai-stat"><div class="k">干跑拦截</div><div class="v" id="wfai-s-dry">0</div></div>

        <div class="wfai-stat"><div class="k">被过滤</div><div class="v" id="wfai-s-filtered">0</div></div>

        <div class="wfai-stat"><div class="k">规则触发</div><div class="v" id="wfai-s-trig">0</div></div>

        <div class="wfai-stat"><div class="k">错误</div><div class="v" id="wfai-s-errors">0</div></div>

      </div>

      <div class="wfai-tabs">

        <div class="wfai-tab act" data-tab="overview">概览</div>

        <div class="wfai-tab" data-tab="messages">消息</div>

        <div class="wfai-tab" data-tab="settings">设置</div>

        <div class="wfai-tab" data-tab="rules">规则</div>

        <div class="wfai-tab" data-tab="plugins">插件</div>

        <div class="wfai-tab" data-tab="logs">日志</div>

        <div class="wfai-savebar" id="wfai-savebar">
          <span class="dirty" id="wfai-dirty">● 有未保存的修改</span>
          <button class="wfai-btn pri" id="wfai-save-top">保存设置</button>
        </div>

      </div>

      <div class="wfai-body" id="wfai-body"></div>

    </section>`);

    return page;

  }



  // ------------------------------------------------------------------- render

  function renderOverview() {

    const s = uiState;

    const c = s.cfg;

    const conn = s.conn.connected;

    const warn = [];

    if (!c.auto_reply) warn.push(['自动回复处于关闭状态，只会记录消息、不会调用 AI。', '']);

    if (c.auto_reply && c.dry_run) warn.push(['当前是<b>干跑模式</b>：AI 回复只写日志，不会真的发到微信。', '']);

    if (c.auto_reply && !c.dry_run && c.send.enabled) warn.push(['已开启真实发送：AI 生成的回复会通过键盘自动化发到微信窗口，请确认当前微信会话正确。', 'danger']);

    if (!c.weflow.access_token) warn.push(['尚未填写 WeFlow access_token，推送流无法鉴权。可点下方「从 WeFlow 读取 Token」。', 'danger']);

    if (!c.ai.api_key && c.ai.type === 'openai') warn.push(['尚未填写 AI API Key。', 'danger']);



    return `

      ${warn.map(([t, k]) => `<div class="wfai-warnbar ${k}">${t}</div>`).join('')}

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>推送链路</h3>

          <div class="wfai-row"><label>WeFlow 地址</label><span>${esc(c.weflow.base_url)}</span></div>



          <div class="wfai-row"><label>连接状态</label><span class="wfai-led ${conn ? 'on' : (s.conn.lastError ? 'err' : 'warn')}" style="margin-right:6px"></span><span>${conn ? '已连接' : (s.conn.lastError ? '失败：' + esc(s.conn.lastError) : '未连接')}</span></div>

          <div class="wfai-row"><label>最近事件</label><span>${ago(s.conn.lastEventAt)}</span></div>

          <div class="wfai-row"><label>心跳</label><span>${ago(s.conn.lastPingAt)}</span></div>

          <div class="wfai-row"><label>重连次数</label><span>${s.conn.attempts}</span></div>

          <div class="wfai-row"><button class="wfai-btn" id="wfai-reconnect">重新连接</button>

            <button class="wfai-btn ghost" id="wfai-pull-token">从 WeFlow 读取 Token</button>

            <button class="wfai-btn ghost" id="wfai-sim">模拟一条消息</button></div>

        </div>

        <div class="wfai-card">

          <h3>AI 与发送</h3>

          <div class="wfai-row"><label>服务类型</label><span>${c.ai.type === 'ollama' ? 'Ollama 本地' : 'OpenAI 兼容'}</span></div>

          <div class="wfai-row"><label>模型</label><span>${esc(c.ai.type === 'ollama' ? c.ai.ollama_model : c.ai.model)}</span></div>

          <div class="wfai-row"><label>接口</label><span style="word-break:break-all">${esc(c.ai.type === 'ollama' ? c.ai.ollama_url : c.ai.base_url)}</span></div>

          <div class="wfai-row"><label>合并窗口</label><span>${c.buffer_seconds} 秒 · 历史 ${c.max_history} 条</span></div>

          <div class="wfai-row"><label>自动回复</label><span>${c.auto_reply ? '开' : '关'}</span><label style="min-width:0;margin-left:auto">干跑</label><span>${c.dry_run ? '开' : '关'}</span></div>

          <div class="wfai-row"><button class="wfai-btn" id="wfai-test-ai">测试 AI</button>

            <button class="wfai-btn ghost" id="wfai-open-cfg">打开配置目录</button></div>

        </div>

      </div>

      <div class="wfai-card">

        <h3>最近消息</h3>

        ${renderMessageList(s.messages.slice(0, 8), true)}

      </div>`;

  }



  const STATUS = {

    pending: ['待处理', 'off'], buffered: ['合并中', 'off'], answered: ['已回复', 'ok'],

    filtered: ['已过滤', 'off'], paused: ['未监听', 'off'], empty: ['空消息', 'off'],

    'ai-error': ['AI 失败', 'err'], 'ai-empty': ['AI 空回', 'err'],

    reply: ['回复', 'dry'], 'dry-run': ['干跑', 'dry'], sent: ['已发送', 'ok'], 'send-error': ['发送失败', 'err'],

    tool: ['调工具', 'dry'], agent: ['命令', 'ok'],

  };



  function renderMessageList(list, compact) {

    if (!list.length) return `<div class="wfai-empty">还没有消息。让朋友给你发一条微信试试（自己发的不算）。</div>`;

    return list.map((m) => {

      const st = STATUS[m.status] || [m.status, ''];

      return `<div class="wfai-msg ${m.outbound ? 'out' : ''}">

        <span class="t">${fmtTime(m.ts)}</span>

        <span class="who" title="${esc(m.contact)}">${esc(m.outbound ? '我 → ' + m.contact : m.contact)}</span>

        <span class="txt">${esc(m.text) || '<未支持的格式>'}</span>

        <span class="wfai-tag ${st[1]}">${st[0]}</span>

      </div>`;

    }).join('');

  }



  function renderMessages() {

    const s = uiState;

    const tabs = [['all', '全部'], ['reply', '回复/干跑'], ['err', '异常']];

    const list = s.messages.filter((m) => {

      if (msgFilter === 'reply') return m.outbound || ['answered', 'sent', 'dry-run'].includes(m.status);

      if (msgFilter === 'err') return /error/.test(m.status);

      return true;

    });

    return `

      <div class="wfai-row" style="margin-top:0">

        ${tabs.map(([k, l]) => `<button class="wfai-btn ${msgFilter === k ? 'pri' : 'ghost'}" data-msgfilter="${k}">${l}</button>`).join('')}

        <div class="wfai-spacer"></div>

        <span class="wfai-note">共 ${s.messages.length} 条</span>

        <button class="wfai-btn ghost" id="wfai-clear-msgs">清空</button>

      </div>

      ${renderMessageList(list)}`;

  }



  // ------------------------------------------------------ 名单选择器 / 同步

  async function loadCatalog(force) {

    if (CATALOG && !force) return CATALOG;

    try {

      const r = await api('api', { op: 'catalog' });

      CATALOG = r.result || { items: [] };

    } catch (e) {

      CATALOG = { items: [], total: 0, error: e.message };

    }

    if (tab === 'settings' || tab === 'rules') renderBodySafe();

    return CATALOG;

  }



  function currentFilterList() {

    const ta = els.page.querySelector('#cfg-filter-list');

    return (ta ? ta.value : '').split('\n').map((s) => s.trim()).filter(Boolean);

  }



  function wlVisible() {

    const sel = new Set((uiState.cfg.filter.list || []).map(String));

    let items = CATALOG ? CATALOG.items.slice() : [];

    if (WL.kind === 'friend') items = items.filter((x) => x.type !== 'group');

    if (WL.kind === 'group') items = items.filter((x) => x.type === 'group');

    if (WL.kind === 'picked') items = items.filter((x) => sel.has(x.username));

    const q = WL.query.trim().toLowerCase();

    if (q) items = items.filter((x) => String(x.name || '').toLowerCase().includes(q) || String(x.username || '').toLowerCase().includes(q));

    return { sel, items: items.slice(0, 500) };

  }



  function setFilterList(list) {

    const ta = els.page.querySelector('#cfg-filter-list');

    if (ta) ta.value = list.join('\n');

    const cnt = els.page.querySelector('#wl-count');

    if (cnt) cnt.textContent = list.length;

  }



  async function loadWeFlowFilter(force) {

    if (WLF.loaded && !force) return WLF;

    try {

      const bridge = window.electronAPI;

      if (!bridge || !bridge.config) throw new Error('electronAPI 不可用');

      const [list, mode, enabled] = await Promise.all([

        bridge.config.get('messagePushFilterList'),

        bridge.config.get('messagePushFilterMode'),

        bridge.config.get('messagePushEnabled'),

      ]);

      WLF.list = Array.isArray(list) ? list.map(String) : [];

      WLF.mode = mode === 'blacklist' ? 'blacklist' : 'whitelist';

      WLF.enabled = enabled === true;

      WLF.loaded = true;

    } catch (e) {

      WLF.loaded = false;

      toast('读取 WeFlow 名单失败：' + e.message, 'err');

    }

    return WLF;

  }



  // 新机器/新配置时，Bot 的 weflow.access_token 是空的 ——
  // 从 WeFlow 自己的配置服务里把明文 token 和端口取过来（同一个进程，能拿到解密后的值）
  let adoptedWeFlow = false;
  async function adoptWeFlowEndpoint() {
    if (adoptedWeFlow) return;
    try {
      const bridge = window.electronAPI;
      if (!bridge || !bridge.config) return;
      const cur = (uiState && uiState.cfg && uiState.cfg.weflow) || {};
      let changed = false;
      const patch = {};
      if (!cur.access_token) {
        let t = await bridge.config.get('httpApiToken');
        if (t && typeof t === 'string' && t.trim() && !t.startsWith('safe:')) {
          patch.access_token = t.trim();
          changed = true;
        } else {
          // WeFlow 自己也解不出来了（userData 被清空过、加密密钥丢了）→ 生成一个新的写回去
          const bytes = new Uint8Array(16);
          (window.crypto || crypto).getRandomValues(bytes);
          const fresh = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
          try { await bridge.config.set('httpApiToken', fresh); } catch (_) {}
          const back = await bridge.config.get('httpApiToken');
          if (back && typeof back === 'string' && back.length >= 16 && !back.startsWith('safe:')) {
            patch.access_token = back.trim();
            changed = true;
          }
        }
      }
      const port = await bridge.config.get('httpApiPort');
      const host = (await bridge.config.get('httpApiHost')) || '127.0.0.1';
      if (port && Number(port) > 0) {
        const want = 'http://' + String(host).trim() + ':' + Number(port);
        if (String(cur.base_url || '') !== want) { patch.base_url = want; changed = true; }
      }
      if (changed) {
        await act('save', { cfg: { weflow: patch } });
        adoptedWeFlow = true;
        try { const s2 = await api('state'); if (s2 && s2.cfg) uiState.cfg = s2.cfg; } catch (_) {}
        toast('已自动从 WeFlow 读取地址和 Token');
      } else {
        adoptedWeFlow = true;
      }
    } catch (_) {}
  }

  async function pushToWeFlow(list, mode, force) {

    if (uiState.cfg.filter.sync_weflow === false) return;

    try {

      const bridge = window.electronAPI;

      // 防误删保护：WeFlow 里本来很多，这次要推的却少得多 → 大概率是界面只勾了几个

      const cur = Array.isArray(WLF.list) ? WLF.list : [];

      if (!force && cur.length >= 10 && (list || []).length < cur.length * 0.6) {

        toast(`已阻止同步：WeFlow 里原有 ${cur.length} 条，这次只有 ${(list || []).length} 条。确实要精简请点「强制同步」。`, 'err');

        return;

      }

      if (!bridge || !bridge.config) throw new Error('electronAPI 不可用');

      await bridge.config.set('messagePushFilterList', list);

      await bridge.config.set('messagePushFilterMode', mode);

      WLF.list = list;

      WLF.mode = mode;

      WLF.loaded = true;

    } catch (e) {

      toast('同步到 WeFlow 失败：' + e.message, 'err');

    }

  }



  async function adoptFromWeFlow() {

    const w = await loadWeFlowFilter(true);

    if (!w.loaded) return;

    if (uiState.cfg.filter.sync_weflow === false) return;

    const mine = (uiState.cfg.filter.list || []).map(String);

    const same = mine.length === w.list.length && mine.every((x, i) => x === String(w.list[i]));

    if (same) return;

    await act('save', { cfg: { filter: { mode: w.mode, list: w.list } } });

    toast(`已按 WeFlow 的推送名单同步（${w.list.length} 条）`);

  }



  async function applyFilterChange(list, mode) {

    const m = mode || (uiState.cfg.filter.mode === 'off' ? 'whitelist' : uiState.cfg.filter.mode);

    await act('save', { cfg: { filter: { mode: m, list, sync_weflow: uiState.cfg.filter.sync_weflow !== false } } });

    setFilterList(list);

    await pushToWeFlow(list, m);

  }



  function renderFilterCard() {

    const c = uiState.cfg;

    const sel = new Set((c.filter.list || []).map(String));

    const syncing = c.filter.sync_weflow !== false;

    let items = CATALOG ? CATALOG.items : [];

    if (WL.kind === 'friend') items = items.filter((x) => x.type !== 'group');

    if (WL.kind === 'group') items = items.filter((x) => x.type === 'group');

    if (WL.kind === 'picked') items = items.filter((x) => sel.has(x.username));

    const q = WL.query.trim().toLowerCase();

    if (q) items = items.filter((x) => String(x.name || '').toLowerCase().includes(q) || String(x.username || '').toLowerCase().includes(q));

    // 名单动辄几百个，一次全渲染会拖慢整页（每个复选框都是一次布局）
    const wlLimit = WL.showAll ? 500 : 40;
    const shown = items.slice(0, wlLimit);

    const rows = shown.map((x) => `<label class="wfai-pick">

        <input type="checkbox" data-wl="${esc(x.username)}" ${sel.has(x.username) ? 'checked' : ''}>

        <span class="nm">${esc(x.name)}</span>

        <span class="wfai-tag ${x.type === 'group' ? 'dry' : 'off'}">${x.type === 'group' ? '群' : '联系'}</span>

        <span class="uid">${esc(x.username)}</span>

      </label>`).join('');



    return `<div class="wfai-card">

        <h3>联系人与范围</h3>

        <div class="wfai-row">

          <label>范围</label>

          <select class="wfai-sel" id="cfg-filter-mode" style="flex:1;min-width:120px">

            <option value="off" ${c.filter.mode === 'off' ? 'selected' : ''}>所有人（不筛）</option>

            <option value="whitelist" ${c.filter.mode === 'whitelist' ? 'selected' : ''}>只处理名单内</option>

            <option value="blacklist" ${c.filter.mode === 'blacklist' ? 'selected' : ''}>不处理名单内</option>

          </select>

          <span class="wfai-note" style="margin:0">已选 <b id="wl-count">${sel.size}</b> 项</span>

        </div>

        <div class="wfai-row" style="gap:8px;margin-top:2px">

          <input class="wfai-in" id="wl-q" placeholder="搜索名字或 wxid…" value="${esc(WL.query)}" style="flex:1">

          ${['all', 'friend', 'group', 'picked'].map((k) => `<span class="wfai-chip ${WL.kind === k ? 'on' : ''}" data-wlkind="${k}">${k === 'all' ? '全部' : k === 'friend' ? '联系人' : k === 'group' ? '群聊' : '已选'}</span>`).join('')}

        </div>

        <div class="wfai-list" id="wl-list">${rows || `<div class="wfai-empty">${CATALOG ? '没有匹配项' : '目录加载中…'}</div>`}</div>
        ${items.length > wlLimit ? `<div class="wfai-note">只显示前 ${wlLimit} 个（共 ${items.length} 个）${WL.showAll ? '' : ' · <a href="#" id="wl-more">显示更多</a>'}　用上面的搜索框可以快速找</div>` : ''}

        <div class="wfai-row">

          <button class="wfai-btn ghost" id="wl-all">勾选当前列表</button>

          <button class="wfai-btn ghost" id="wl-none">清空</button>

          <button class="wfai-btn ghost" id="wl-reload">重读目录</button>

          <div class="wfai-spacer"></div>

          <span class="wfai-sw ${syncing ? 'on' : ''}" data-syncwl><i></i>${syncing ? '与 WeFlow 双向同步' : '仅本地名单'}</span>

        </div>

        <div class="wfai-row" style="font-size:12px;color:var(--wfai-dim)">

          <span>WeFlow 侧：推送 <b>${WLF.loaded ? (WLF.enabled ? '开' : '关') : '?'}</b> · ${WLF.loaded ? (WLF.mode === 'blacklist' ? '黑名单' : '白名单') + ' ' + WLF.list.length + ' 条' : '未读取'}</span>

          <div class="wfai-spacer"></div>

          <button class="wfai-btn ghost" id="wl-read-wf">从 WeFlow 拉</button>

          <button class="wfai-btn ghost" id="wl-push-wf">推到 WeFlow</button>

        </div>

        <details style="margin-top:8px"><summary class="wfai-note" style="cursor:pointer">手动编辑名单</summary>

          <textarea class="wfai-ta" id="cfg-filter-list" style="min-height:80px;margin-top:6px">${esc((c.filter.list || []).join('\n'))}</textarea>

        </details>

        <div class="wfai-note">这就是 WeFlow「HTTP 推送 → 白名单」那套选择器；打开双向同步后两边是同一份。WeFlow 自己的推送不看这份名单（只挡撤回/自己发的），真正生效的是 Bot 这里。</div>

      </div>`;

  }



  // ------------------------------------------------------------ 插件安装

  async function installPlugin(source) {

    try {

      if (source === 'zip') {

        const pick = await api('api', { op: 'pickFile', title: '选择插件 zip', filters: [{ name: 'ZIP 插件包', extensions: ['zip'] }] });

        const p = pick.result && pick.result.path;

        if (!p) return;

        const r = await act('installPlugin', { source: 'zip', path: p });

        toast(`已安装插件 ${(r.result || {}).id}（${(r.result || {}).files} 个文件）`);

      } else if (source === 'dir') {

        const pick = await api('api', { op: 'pickDir', title: '选择插件文件夹（内含 plugin.json）' });

        const p = pick.result && pick.result.path;

        if (!p) return;

        const r = await act('installPlugin', { source: 'dir', path: p });

        toast(`已安装插件 ${(r.result || {}).id}`);

      } else if (source === 'url') {

        const url = prompt('粘贴 zip 地址（GitHub 仓库主页也行，会自动试 main/master）：', 'https://github.com/');

        if (!url || url === 'https://github.com/') return;

        toast('下载中，请稍候…');

        const r = await act('installPlugin', { source: 'url', url });

        toast(`已安装插件 ${(r.result || {}).id}（${(r.result || {}).files} 个文件）`);

      } else if (source === 'tmpl') {

        await act('newPluginTemplate');

        toast('已生成示例插件 demo-echo');

      }

      await act('scanPlugins');

    } catch (e) {

      toast(e.message, 'err');

    }

  }



  // ------------------------------------------------------ 单独归档规则

  async function loadArchiveRules(force) {

    if (ARCH && !force) return ARCH;

    try {

      const r = await api('api', { op: 'archiveRuleState' });

      ARCH = r.result || { rules: [] };

    } catch (e) {

      ARCH = { rules: [], error: e.message };

    }

    return ARCH;

  }



  function renderArchiveRules() {

    const c = uiState.cfg;

    const a = c.archive || {};

    const rules = (ARCH && ARCH.rules) || [];

    const body = rules.map((r) => `<div class="wfai-msg" style="align-items:center">

        <span class="wfai-sw ${r.enabled !== false ? 'on' : ''}" data-arule="${esc(r.id)}" data-on="${r.enabled !== false ? 1 : 0}"><i></i>${r.enabled !== false ? '开' : '关'}</span>

        <span class="who" style="flex:0 0 150px" title="${esc(r.id)}">${esc(r.name || r.id)}</span>

        <span class="txt">

          每 <input class="wfai-in n" style="max-width:64px" type="number" min="0" max="720" value="${r.interval_hours || 0}" data-arh="${esc(r.id)}"> 小时归档 ·

          满 <input class="wfai-in n" style="max-width:70px" type="number" min="0" max="100000" value="${r.max_records || 0}" data-arm="${esc(r.id)}"> 条自动压缩

          <span class="wfai-note">待打包 ${r.pending || 0} 条 · 热文件 ${Math.round((r.hotBytes || 0) / 1024)} KB · 已打包 ${r.packed || 0} 个 zip</span>

        </span>

        <button class="wfai-btn ghost" data-arnow="${esc(r.id)}" data-arname="${esc(r.name || r.id)}">归档</button>

        <button class="wfai-btn ghost" data-arzip="${esc(r.id)}" data-arname="${esc(r.name || r.id)}">压缩</button>

        <button class="wfai-btn ghost" data-arrm="${esc(r.id)}">删除</button>

      </div>`).join('');



    return `<div class="wfai-card">

        <h3>单聊 / 群聊 单独归档</h3>

        <div class="wfai-row">

          <label>未单独配置的会话</label>

          <span class="wfai-note" style="margin:0">每</span>

          <input class="wfai-in n" id="ar-dfh" type="number" min="0" max="720" value="${a.default_interval_hours || 0}">

          <span class="wfai-note" style="margin:0">小时归档，满</span>

          <input class="wfai-in n" id="ar-dfm" type="number" min="0" max="100000" value="${a.default_max_records || 0}">

          <span class="wfai-note" style="margin:0">条自动压缩（0 = 不自动）</span>

        </div>

        <div class="wfai-row" style="gap:8px">

          <input class="wfai-in" id="ar-search" placeholder="搜索会话…" style="max-width:150px">

          <select class="wfai-sel" id="ar-add-id" style="flex:1;min-width:220px">

            <option value="">— 选择一个群聊或联系人 —</option>

            ${(CATALOG ? CATALOG.items : []).map((x) => `<option value="${esc(x.username)}">${x.type === 'group' ? '👥' : '👤'} ${esc(x.name)}</option>`).join('')}

          </select>

          <input class="wfai-in n" id="ar-add-h" type="number" min="0" max="720" placeholder="小时" value="6">

          <input class="wfai-in n" id="ar-add-m" type="number" min="0" max="100000" placeholder="条数" value="500">

          <button class="wfai-btn" id="ar-add">添加</button>

        </div>

        ${body || '<div class="wfai-empty">还没有单独规则。上面选一个会话，填「每几小时」和「满多少条自动压缩」。</div>'}

        <div class="wfai-note">压缩包在 <code>${esc((ARCH && ARCH.packedDir) || '')}</code>，热数据是 NDJSON，压缩后热文件清空、计数归零。定时检查 60 秒一次。</div>

      </div>`;

  }



  async function saveArchiveRules(rules) {

    await act('save', { cfg: { archive: { rules } } });

    ARCH = null;

    await loadArchiveRules(true);

    renderBody();

  }



  function renderSettings() {

    const c = uiState.cfg;

    const sw = (id, on, label, danger) => `<span class="wfai-sw ${on ? 'on' : ''} ${danger ? 'danger' : ''}" data-sw="${id}"><i></i>${label}</span>`;

    return `

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>行为</h3>

          <div class="wfai-row"><label>自动回复</label>${sw('auto_reply', c.auto_reply, c.auto_reply ? '已开启' : '已关闭')}</div>

          <div class="wfai-row"><label>干跑（不真发送）</label>${sw('dry_run', c.dry_run, c.dry_run ? '只写日志' : '会真发送', !c.dry_run)}</div>

          <div class="wfai-row"><label>允许键盘发送</label>${sw('send_enabled', c.send.enabled, c.send.enabled ? '允许' : '禁止', true)}</div>

          <div class="wfai-row"><label>合并窗口（秒）</label><input class="wfai-in n" id="cfg-buffer" type="number" min="1" max="120" value="${c.buffer_seconds}">

            <label style="min-width:auto">历史条数</label><input class="wfai-in n" id="cfg-history" type="number" min="0" max="30" value="${c.max_history}"></div>

          <div class="wfai-row"><label>回复字数上限</label><input class="wfai-in n" id="cfg-maxchars" type="number" min="10" max="800" value="${c.max_reply_chars}"></div>

          <div class="wfai-row">${sw('filter.drop_other_emoji', c.filter.drop_other_emoji !== false, c.filter.drop_other_emoji !== false ? '忽略别人发的表情' : '表情照常处理')}

            <select class="wfai-sel" id="cfg-emoji-mode" style="max-width:210px;flex:1">

              <option value="pure" ${(c.filter.emoji_mode || 'pure') === 'pure' ? 'selected' : ''}>只忽略"纯表情"消息</option>

              <option value="strip" ${c.filter.emoji_mode === 'strip' ? 'selected' : ''}>把表情从文字里剥掉</option>

            </select></div>

          <div class="wfai-note">微信的文字表情（<code>[破涕为笑]</code>、<code>😀</code>）原本会被当成普通文字推给模型。打开后纯表情消息直接丢弃；选「剥掉」则只去掉表情本身，文字保留。</div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">系统提示词</label>

            <textarea class="wfai-ta" id="cfg-prompt">${esc(c.system_prompt)}</textarea></div>

        </div>

        <div class="wfai-card">

          <h3>AI 服务</h3>

          <div class="wfai-row"><label>服务商</label>

            <select class="wfai-sel" id="cfg-ai-provider" style="flex:1">

              <option value="deepseek" ${(c.ai.provider === 'deepseek') ? 'selected' : ''}>DeepSeek 官方（api.deepseek.com）</option>

              <option value="dashscope" ${(c.ai.provider === 'dashscope') ? 'selected' : ''}>阿里云百炼 DashScope</option>

              <option value="openai" ${(c.ai.provider === 'openai') ? 'selected' : ''}>OpenAI</option>

              <option value="ollama" ${(c.ai.provider === 'ollama') ? 'selected' : ''}>Ollama 本地</option>

              <option value="custom" ${(!c.ai.provider || c.ai.provider === 'custom') ? 'selected' : ''}>自定义</option>

            </select>

            <button class="wfai-btn ghost" id="cfg-ai-apply">套用预设</button></div>

          <div class="wfai-row">${sw('ai.native_search', c.ai.native_search === true, c.ai.native_search === true ? '模型自带联网（服务端搜索）' : '模型自带联网（关闭，走本地抓取）')}

            <select class="wfai-sel" id="cfg-ai-strategy" style="max-width:170px;flex:1">

              <option value="agent" ${(c.ai.search_strategy || 'agent') === 'agent' ? 'selected' : ''}>agent 策略</option>

              <option value="turbo" ${c.ai.search_strategy === 'turbo' ? 'selected' : ''}>turbo 策略</option>

              <option value="max" ${c.ai.search_strategy === 'max' ? 'selected' : ''}>max 策略</option>

            </select></div>

          <div class="wfai-note">打开「模型自带联网」后：DeepSeek 会用它的服务端工具 <code>deepseek_web_search</code>（还有 <code>deepseek_read_url</code> 读链接），回答带引用且搜索不计费；百炼会用 <code>enable_search</code> 参数。两者都要求模型支持，DeepSeek 需用 <code>deepseek-flash</code>。</div>

          <div class="wfai-row"><label>类型</label>

            <select class="wfai-sel" id="cfg-ai-type" style="flex:1">

              <option value="openai" ${c.ai.type !== 'ollama' ? 'selected' : ''}>OpenAI 兼容（DeepSeek / 通义 / OpenAI）</option>

              <option value="ollama" ${c.ai.type === 'ollama' ? 'selected' : ''}>Ollama 本地</option>

            </select></div>

          <div class="wfai-row"><label>Base URL</label><input class="wfai-in" id="cfg-ai-base" value="${esc(c.ai.base_url)}"></div>

          <div class="wfai-row"><label>API Key</label><input class="wfai-in" id="cfg-ai-key" type="password" value="${esc(c.ai.api_key)}"></div>

          <div class="wfai-row"><label>模型</label><input class="wfai-in" id="cfg-ai-model" value="${esc(c.ai.model)}"></div>

          <div class="wfai-row"><label>深度思考</label>

            <select class="wfai-sel" id="cfg-ai-thinking" style="max-width:170px;flex:1">

              <option value="auto" ${(c.ai.thinking || 'auto') === 'auto' ? 'selected' : ''}>跟随服务商默认</option>

              <option value="on" ${c.ai.thinking === 'on' ? 'selected' : ''}>开启（先想再答）</option>

              <option value="off" ${c.ai.thinking === 'off' ? 'selected' : ''}>关闭（更快更省）</option>

            </select>

            <label style="min-width:auto">思考强度</label>

            <select class="wfai-sel" id="cfg-ai-effort" style="max-width:130px;flex:1">

              <option value="" ${!c.ai.reasoning_effort ? 'selected' : ''}>默认</option>

              <option value="low" ${c.ai.reasoning_effort === 'low' ? 'selected' : ''}>low 快</option>

              <option value="medium" ${c.ai.reasoning_effort === 'medium' ? 'selected' : ''}>medium</option>

              <option value="high" ${c.ai.reasoning_effort === 'high' ? 'selected' : ''}>high 稳</option>

              <option value="max" ${c.ai.reasoning_effort === 'max' ? 'selected' : ''}>max 最深</option>

            </select></div>

          <div class="wfai-note">DeepSeek 用 <code>thinking.type</code> + <code>reasoning_effort</code>，百炼用 <code>enable_thinking</code>；其它服务商不发这两个参数。

            实测：关闭思考时「9.11 和 9.8 哪个大」会答错成 9.11，开启就对了；强度 max 的思考长度是 low 的 6 倍。</div>

          <div class="wfai-row"><label>超时（秒）</label><input class="wfai-in n" id="cfg-ai-timeout" type="number" min="5" max="300" value="${c.ai.timeout}"></div>

          <div class="wfai-row"><label>Ollama 地址</label><input class="wfai-in" id="cfg-ollama-url" value="${esc(c.ai.ollama_url)}"></div>

          <div class="wfai-row"><label>Ollama 模型</label><input class="wfai-in" id="cfg-ollama-model" value="${esc(c.ai.ollama_model)}"></div>

          <div class="wfai-row"><button class="wfai-btn ghost" id="wfai-use-weflow-ai">改用 WeFlow 自带 AI 配置</button></div>

        </div>

      </div>

      <div class="wfai-2col">

        ${renderFilterCard()}

    <div class="wfai-card">
      <h3>数据目录（缓存放哪）</h3>
      <div class="wfai-row"><label>当前</label><span class="wfai-note" style="margin:0;word-break:break-all" id="dp-root">${esc((uiState.dataPaths || {}).root || "")}</span></div>
      <div class="wfai-row">
        <button class="wfai-btn" id="dp-pick">选择目录</button>
        <button class="wfai-btn ghost" id="dp-default">改回默认（WeFlow 目录下）</button>
      </div>
      <div class="wfai-note" id="dp-note">默认在 <code>WeFlow\resources\wfai\data\</code>，里面按 archive / context / logs / stickers / workspace / out / plugins 分类。<br>换目录后重启生效，旧数据会自动复制过去（原来的不删）。</div>
    </div>

        <div class="wfai-card">

          <h3>WeFlow 与微信</h3>

          <div class="wfai-row"><label>WeFlow 地址</label><input class="wfai-in" id="cfg-wf-base" value="${esc(c.weflow.base_url)}"></div>

          <div class="wfai-row"><button class="wfai-btn" id="wf-auto">自动识别 WeFlow 地址 / token / 微信进程</button>

            <span class="wfai-note" style="margin:0" id="wf-auto-note"></span></div>

          <div class="wfai-row"><label>access_token</label><input class="wfai-in" id="cfg-wf-token" value="${esc(c.weflow.access_token)}"></div>

          <div class="wfai-row"><button class="wfai-btn ghost" id="wfai-pull-token2">从 WeFlow 读取 Token</button>

            <span class="wfai-sw ${WLF.loaded && WLF.enabled ? 'on' : ''}" data-wfpush><i></i>WeFlow 推送总开关</span></div>

          <div class="wfai-row"><label>微信进程</label><input class="wfai-in n" id="cfg-wx-exe" value="${esc(c.send.wechat_exe)}">

            <label style="min-width:auto">延迟 ms</label><input class="wfai-in n" id="cfg-wx-delay" type="number" min="50" max="3000" value="${c.send.delay_ms}"></div>

          <div class="wfai-row"><label>搜索下移行数</label><input class="wfai-in n" id="cfg-wx-down" type="number" min="0" max="8" value="${c.send.search_down || 0}">

            <span class="wfai-note" style="margin:0">微信搜索框第一行是「搜索网络结果」，必要时下移跳过</span></div>

          <div class="wfai-row" style="gap:8px"><input class="wfai-in n" id="wfai-test-contact" placeholder="群名/备注" style="flex:1">

            <button class="wfai-btn" id="wfai-test-send">测试发送</button></div>

          <div class="wfai-note">发送依赖微信窗口的键盘自动化：激活微信 → Ctrl+F 搜索 → 回车进入会话 → 粘贴 → 回车。默认干跑，确认无误再关闭。</div>

        </div>

      </div>

      <div class="wfai-row" style="justify-content:flex-end">

        <button class="wfai-btn ghost" id="wfai-reload-cfg">丢弃修改</button>

        <button class="wfai-btn pri" id="wfai-save">保存设置</button><span class="wfai-note" style="margin:0">（右上角那个按钮在哪个页签都能点）</span>

      </div>`;

  }



  function renderArchiveCard() {

  const a = uiState.archiveMgr || { items: [], totals: {} };

  const items = (a.items || []).slice();

  const q = (uiState.arQuery || '').toLowerCase();

  const list = q ? items.filter((x) => String(x.name || '').toLowerCase().includes(q) || String(x.sessionId || '').toLowerCase().includes(q)) : items;

  const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

  const limit = uiState.arAll ? 400 : 50;
  const rows = list.slice(0, limit).map((x) => `

    <div class="wfai-pick" data-arsid="${esc(x.sessionId)}" style="cursor:default">

      <span class="nm">${esc(x.name === x.sessionId ? x.sessionId.replace('@chatroom', '（群）') : x.name)}</span>

      <span class="uid">${x.sizeKb} KB · ${x.lines} 条 · 最后 ${fmt(x.lastTs)}${x.packed ? ' · 压缩包 ' + x.packed + ' 个' : ''}</span>

      <button class="wfai-btn ghost" data-aropen="${esc(x.sessionId)}" style="margin-left:auto">打开文件夹</button>

      <button class="wfai-btn ghost" data-aredit="${esc(x.sessionId)}">编辑</button>

      <button class="wfai-btn ghost" data-ardel="${esc(x.sessionId)}">删除</button>

    </div>`).join('');

  return `

    <div class="wfai-card">

      <h3>本地归档管理</h3>

      <div class="wfai-row"><label>总计</label>

        <span class="wfai-note" style="margin:0">${a.totals ? a.totals.sessions : 0} 个会话 · ${a.totals ? a.totals.sizeKb : 0} KB · ${a.totals ? a.totals.lines : 0} 条消息</span>

        <button class="wfai-btn ghost" id="arc-refresh" style="margin-left:auto">刷新</button>

        <button class="wfai-btn ghost" id="arc-open">打开目录</button>

        <button class="wfai-btn ghost" id="arc-clear">清空全部</button></div>

      <div class="wfai-row"><input class="wfai-in" id="arc-q" placeholder="按群名/备注筛选…" value="${esc(uiState.arQuery || '')}" style="max-width:220px">

        <span class="wfai-note" style="margin:0">每行右侧「删除」会连压缩包一起删；删掉后这些会话不再占用空间</span></div>

      <div class="wfai-list" style="max-height:240px">${rows || '<div class="wfai-empty">没有归档文件</div>'}</div>
      ${list.length > 50 ? `<div class="wfai-note">只显示前 ${limit} 个（共 ${list.length} 个）${uiState.arAll ? '' : ' · <a href="#" id="arc-all">显示全部</a>'}</div>` : ''}

      <h3 style="margin-top:14px">在本机聊天记录里查</h3>

      <div class="wfai-row"><input class="wfai-in" id="arc-sq" placeholder="关键词，例如：报价 / 地址 / 那个人" style="flex:1">

        <input class="wfai-in n" id="arc-days" type="number" min="1" max="3650" value="30" style="width:80px"><span class="wfai-note" style="margin:0">天</span>

        <button class="wfai-btn" id="arc-search">搜索</button></div>

      <div class="wfai-list" id="arc-results" style="max-height:200px"></div>

      <div class="wfai-note">模型也能用这个：内置工具 <code>search_history</code>（关键词 + 时间范围），问到「上次谁说过什么」它就会翻本地归档，不用联网。</div>

    </div>`;

}



function renderScheduleCard() {

  const sc = uiState.schedule || { rules: [], history: [] };

  const rules = sc.rules || [];

  const sw = (id, on, label) => `<span class="wfai-sw ${on ? 'on' : ''}" data-rsw="${id}"><i></i>${esc(label || '')}</span>`;

  const fmt = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';

  const blocks = rules.map((r, i) => {

    const t = r.type || 'daily';

    const timeField = t === 'once'

      ? `<input class="wfai-in" id="s-${i}-atISO" type="datetime-local" value="${esc((r.atISO || '').slice(0, 16))}">`

      : t === 'interval'

        ? `<input class="wfai-in n" id="s-${i}-every" type="number" min="1" max="10080" value="${r.everyMinutes || 60}"> 分钟`

        : `<input class="wfai-in n" id="s-${i}-at" type="time" value="${esc(r.at || '09:00')}">`;

    const wk = t === 'weekly'

      ? `<span class="wfai-note" style="margin:0">周</span>${['1','2','3','4','5','6','7'].map((d) => `<label style="min-width:auto;display:inline-flex;align-items:center;gap:2px"><input type="checkbox" id="s-${i}-d${d}" ${(r.days || []).includes(Number(d)) ? 'checked' : ''}>${d}</label>`).join('')}`

      : '';

    const mo = t === 'monthly'

      ? `<label style="min-width:auto">每月</label><input class="wfai-in n" id="s-${i}-day" type="number" min="1" max="31" value="${r.day || 1}"> 号`

      : '';

    return `

      <div class="wfai-subcard" data-sidx="${i}">

        <div class="wfai-row" style="margin-top:0">

          ${sw('sched.rule.' + i, r.enabled !== false, r.enabled !== false ? '启用' : '停用')}

          <input class="wfai-in" id="s-${i}-name" placeholder="规则名" value="${esc(r.name || '')}" style="max-width:130px">

          <input class="wfai-in" id="s-${i}-contact" placeholder="发给谁（群名/备注）" value="${esc(r.contact || '')}">

          <span class="wfai-note" style="margin:0">${r.nextAt ? '下次 ' + fmt(r.nextAt) : '暂无下次'}${r.runs ? ' · 已发 ' + r.runs + ' 次' : ''}</span>

          <button class="wfai-btn ghost" id="s-${i}-test">测试</button>

          <button class="wfai-btn ghost" id="s-${i}-del">删除</button>

        </div>

        <div class="wfai-row">

          <label style="min-width:auto">类型</label>

          <select class="wfai-sel" id="s-${i}-type" style="max-width:130px">

            <option value="daily" ${t === 'daily' ? 'selected' : ''}>每天</option>

            <option value="weekly" ${t === 'weekly' ? 'selected' : ''}>每周</option>

            <option value="monthly" ${t === 'monthly' ? 'selected' : ''}>每月</option>

            <option value="once" ${t === 'once' ? 'selected' : ''}>一次性</option>

            <option value="interval" ${t === 'interval' ? 'selected' : ''}>每隔</option>

          </select>

          ${timeField}${wk}${mo}

          <label style="min-width:auto">模式</label>

          <select class="wfai-sel" id="s-${i}-mode" style="max-width:120px">

            <option value="text" ${(r.mode || 'text') === 'text' ? 'selected' : ''}>固定文本</option>

            <option value="ai" ${r.mode === 'ai' ? 'selected' : ''}>AI 生成</option>

          </select>

        </div>

        <div class="wfai-row"><textarea class="wfai-ta" id="s-${i}-text" style="min-height:52px" placeholder="${(r.mode === 'ai') ? '给模型的提示词，例如：生成一句早安问候' : '要发送的内容'}">${esc(r.mode === 'ai' ? (r.prompt || '') : (r.text || ''))}</textarea></div>

        <div class="wfai-row">

          <label style="min-width:auto">补发窗口</label><input class="wfai-in n" id="s-${i}-catch" type="number" min="0" max="1440" value="${r.catchUpMinutes || 0}"> 分钟

          <label style="min-width:auto">最多发</label><input class="wfai-in n" id="s-${i}-maxruns" type="number" min="0" max="9999" value="${r.maxRuns || 0}"> 次（0 不限）

          ${sw('sched.rule.' + i + '.person', r.atPerson === true, '群里先 @ 对方')}

          ${sw('sched.rule.' + i + '.dry', r.dryRun === true, '只干跑不真发')}

        </div>

      </div>`;

  }).join('');

  const hist = (sc.history || []).length

    ? sc.history.map((x) => `<div class="wfai-note" style="margin:0">${fmt(x.at)} · ${esc(x.name)} → ${esc(x.contact)} · ${esc(x.status)} · ${esc(x.text)}</div>`).join('')

    : '<div class="wfai-note" style="margin:0">还没有发送记录</div>';

  return `

    <div class="wfai-card">

      <h3>定时消息</h3>

      <div class="wfai-row">${sw('schedule.enabled', sc.enabled !== false, sc.enabled !== false ? '调度器已开启' : '调度器已关闭')}

        <button class="wfai-btn" id="sched-add">+ 新增规则</button>

        <button class="wfai-btn pri" id="sched-save">保存规则</button></div>

      <div class="wfai-note">到点自动发到指定的人/群。支持每天、每周、每月、一次性、每隔 N 分钟；可以发固定文本，也可以让 AI 按提示词生成。

        「补发窗口」用于电脑休眠/关机后开机补发（0 = 不补）。所有发送走同一个发送队列，不会和普通回复抢键盘。</div>

      ${blocks || '<div class="wfai-empty">还没有规则，点「+ 新增规则」</div>'}

      <h3 style="margin-top:14px">最近发送</h3>

      <div class="wfai-list" style="max-height:140px">${hist}</div>

    </div>`;

}



function renderContextCard() {

  const c = uiState.cfg || {};

  const cx = c.context || {};

  const sw = (id, on, label) => `<span class="wfai-sw ${on ? 'on' : ''}" data-rsw="${id}"><i></i>${esc(label || '')}</span>`;

  const max = Number(cx.max_tokens) || 200000;

  const preset = max === 200000 ? '200000' : max === 500000 ? '500000' : max === 1048576 ? '1048576' : 'custom';

  const list = (uiState.contexts || []);

  const rows = list.length

    ? list.map((x) => `<div class="wfai-pick" style="cursor:default"><span class="nm">${esc((x.sessionId || '').replace('@chatroom', '（群）'))}</span><span class="uid">${x.total} / ${x.max} tokens · ${x.percent}%${x.compressed ? ' · 已压缩 ' + x.compressed + ' 条' : ''}${x.summaryLen ? ' · 摘要 ' + x.summaryLen + ' 字' : ''}</span></div>`).join('')

    : '<div class="wfai-note" style="margin:0">还没有活跃会话</div>';

  return `

    <div class="wfai-card">

      <h3>上下文与压缩</h3>

      <div class="wfai-row">${sw('context.enabled', cx.enabled !== false, cx.enabled !== false ? '超长自动压缩' : '不压缩（到上限直接丢旧消息）')}</div>

      <div class="wfai-row"><label>上下文上限</label>

        <select class="wfai-sel" id="cx-preset" style="max-width:170px;flex:1">

          <option value="200000" ${preset === '200000' ? 'selected' : ''}>200K</option>

          <option value="500000" ${preset === '500000' ? 'selected' : ''}>500K</option>

          <option value="1048576" ${preset === '1048576' ? 'selected' : ''}>1M</option>

          <option value="custom" ${preset === 'custom' ? 'selected' : ''}>自定义</option>

        </select>

        <input class="wfai-in n" id="cx-max" type="number" min="8000" max="4000000" step="1000" value="${max}"> tokens</div>

      <div class="wfai-row"><label>用到多少开始压缩</label><input class="wfai-in n" id="cx-at" type="number" min="30" max="95" value="${Math.round((Number(cx.compress_at) || 0.75) * 100)}">%

        <label style="min-width:auto">保留最近</label><input class="wfai-in n" id="cx-keep" type="number" min="2" max="400" value="${cx.keep_recent || 20}">条</div>

      <div class="wfai-row"><label>摘要字数上限</label><input class="wfai-in n" id="cx-sum" type="number" min="120" max="4000" value="${cx.summary_max_chars || 700}">

        ${sw('context.archive_compressed', cx.archive_compressed !== false, cx.archive_compressed !== false ? '压缩掉的内容写进归档' : '压缩掉的就丢弃')}</div>

      <div class="wfai-note">到阈值时，把较早的对话让模型压成一段摘要（保留人名、事实、决定、待办），最近 N 条原样保留，

        摘要会在之后每次请求里作为「前情提要」带上；被压掉的原文会写进这个会话自己的归档 ndjson，不会丢。</div>

      <h3 style="margin-top:14px">当前用量</h3>

      <div class="wfai-list" style="max-height:150px">${rows}</div>

    </div>`;

}



function renderWebCard() {

  const c = uiState.cfg || {};

  const w = c.web || {};

  const sw = (id, on, label) => `<span class="wfai-sw ${on ? 'on' : ''}" data-rsw="${id}"><i></i>${esc(label || '')}</span>`;

  return `

    <div class="wfai-card">

      <h3>联网（搜索 / 读网页）</h3>

      <div class="wfai-row"><b>联网总开关</b>${sw('web.enabled', w.enabled !== false, w.enabled !== false ? '开（模型可以自己上网查）' : '关')}</div>

      <div class="wfai-row"><label>搜索地址</label><input class="wfai-in" id="wb-url" value="${esc(w.search_url || 'https://cn.bing.com/search?q={q}')}"></div>

      <div class="wfai-note">用 <code>{q}</code> 代表搜索词。默认走 Bing 网页版，本地直接发 HTTP 请求，不依赖浏览器。想换成自己的搜索 API 就填完整模板，例如 <code>https://api.serper.dev/search?q={q}</code>。</div>

      <div class="wfai-row"><label>JSON 结果字段</label><input class="wfai-in" id="wb-path" placeholder="留空=按网页解析；自定义 API 填例如 organic_results" value="${esc(w.search_json_path || '')}"></div>

      <div class="wfai-row"><label>API Key</label><input class="wfai-in" id="wb-key" type="password" value="${esc(w.api_key || '')}"></div>

      <div class="wfai-row"><label>Header</label><input class="wfai-in" id="wb-header" style="max-width:150px" value="${esc(w.api_header || 'Authorization')}">

        <label style="min-width:auto">前缀</label><input class="wfai-in" id="wb-prefix" style="max-width:110px" value="${esc(w.api_prefix === undefined ? 'Bearer ' : w.api_prefix)}"></div>

      <div class="wfai-row"><label>结果条数</label><input class="wfai-in n" id="wb-max" type="number" min="1" max="20" value="${w.max_results || 6}">

        <label style="min-width:auto">抓取上限</label><input class="wfai-in n" id="wb-kb" type="number" min="20" max="2048" value="${w.fetch_limit_kb || 200}"><span class="wfai-note" style="margin:0">KB</span>

        <label style="min-width:auto">超时</label><input class="wfai-in n" id="wb-ms" type="number" min="3000" max="120000" step="1000" value="${w.timeout_ms || 20000}"><span class="wfai-note" style="margin:0">ms</span></div>

      <div class="wfai-row"><label>测试</label><input class="wfai-in" id="wb-q" placeholder="搜点什么试试" value="今天的新闻">

        <button class="wfai-btn" id="wb-test">搜索</button>

        <button class="wfai-btn ghost" id="wb-fetch">读网页</button></div>

      <div class="wfai-note" id="wb-out" style="white-space:pre-wrap;max-height:180px;overflow:auto"></div>

      <div class="wfai-note">模型能用的两个工具：<code>web_search(关键词)</code> 和 <code>web_fetch(网址)</code>。遇到新闻、天气、价格、汇率这类它不知道的事会自己去查；你也可以直接说「上网查一下…」。</div>

    </div>`;

}



function renderGroupRules(g) {

  const rules = Array.isArray(g.rules) ? g.rules : [];

  if (g.per_group !== true) return '';

  if (!rules.length) return '<div class="wfai-empty">还没有单个群配置，点上面「+ 新增单个群配置」</div>';

  const sw = (id, on, label) => `<span class="wfai-sw ${on ? 'on' : ''}" data-rsw="${id}"><i></i>${esc(label || '')}</span>`;

  return rules.map((r, i) => `

    <div class="wfai-subcard" data-gidx="${i}">

      <div class="wfai-row" style="margin-top:0">

        <input class="wfai-in" id="gr-${i}-contact" placeholder="群名" value="${esc(r.contact || '')}" style="max-width:180px">

        <span class="wfai-note" style="margin:0">${esc(r.sessionId || '（保存后按群名匹配）')}</span>

        <button class="wfai-btn ghost" id="gr-${i}-del">删除</button>

      </div>

      <div class="wfai-row">

        ${sw(`group.rules.${i}.at_enabled`, r.at_enabled !== false, '被 @ 时响应')}

        ${sw(`group.rules.${i}.keyword_enabled`, r.keyword_enabled === true, '关键词也触发')}

        ${sw(`group.rules.${i}.auto_reply`, r.auto_reply === true, '回群里的普通消息')}

        ${sw(`group.rules.${i}.reply_mention`, r.reply_mention !== false, '回复时 @ 对方')}

      </div>

      <div class="wfai-row">

        <label style="min-width:auto">合并延迟</label><input class="wfai-in n" id="gr-${i}-buffer" type="number" min="1" max="120" value="${r.buffer_seconds || 10}" style="width:70px"><span class="wfai-note" style="margin:0">秒</span>

        <label style="min-width:auto">每分钟上限</label><input class="wfai-in n" id="gr-${i}-rate" type="number" min="1" max="60" value="${r.max_replies_per_minute || 6}" style="width:70px"><span class="wfai-note" style="margin:0">条</span>

      </div>

      <div class="wfai-row"><textarea class="wfai-ta" id="gr-${i}-prompt" style="min-height:48px" placeholder="这个群专用的提示词（留空 = 用全局群聊提示词）">${esc(r.system_prompt || '')}</textarea></div>

    </div>`).join('');

}



function renderGroupCards() {

    const c = uiState.cfg;

    const g = c.group || {};

    const ac = c.active || {};

    const mc = c.media || {};

    const rp = c.reply || {};

    const vs = c.vision || {};

    const st = c.sticker || {};

    const sw = (id, on, label, danger) => `<span class="wfai-sw ${on ? 'on' : ''} ${danger ? 'danger' : ''}" data-rsw="${id}"><i></i>${label}</span>`;

    return `

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>群聊专属（默认覆盖全局）</h3>

        <div class="wfai-row"><label>生效方式</label>

          <select class="wfai-sel" id="g-mode" style="flex:1;max-width:260px">

            <option value="off" ${g.per_group !== true ? 'selected' : ''}>全局统一（所有群用下面这套）</option>

            <option value="on" ${g.per_group === true ? 'selected' : ''}>按群单独设置（没配的群沿用全局）</option>

          </select>

          <button class="wfai-btn ghost" id="g-add">+ 新增单个群配置</button></div>

        <div id="g-rules">${renderGroupRules(g)}</div>

          <div class="wfai-row"><label>被 @ 时响应</label>${sw('group.at_enabled', g.at_enabled !== false, g.at_enabled !== false ? '开' : '关')}

            ${sw('group.keyword_enabled', g.keyword_enabled === true, g.keyword_enabled === true ? '关键词也触发' : '只认 @')}</div>

          <div class="wfai-row"><label>回复群里的普通消息</label>${sw('group.auto_reply', g.auto_reply === true, g.auto_reply === true ? '全都回（易刷屏）' : '只回触发消息', true)}</div>

          <div class="wfai-row"><label>按发言人分开合并</label>${sw('group.per_sender', g.per_sender !== false, g.per_sender !== false ? '多人 @ 各回各的' : '全群合并成一条')}

            ${sw('group.reply_mention', g.reply_mention !== false, g.reply_mention !== false ? '回复时 @对方' : '不点名')}</div>

          <div class="wfai-row"><label>群聊合并延迟（秒）</label><input class="wfai-in n" id="g-buffer" type="number" min="0" max="120" value="${g.buffer_seconds || 0}">

            <label style="min-width:auto">每分钟上限</label><input class="wfai-in n" id="g-rate" type="number" min="1" max="60" value="${g.max_replies_per_minute || 6}"></div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">群聊专属关键词（每行一个，在全局关键词之外追加）</label>

            <textarea class="wfai-ta" id="g-keywords" style="min-height:58px">${esc((g.keywords || []).join('\n'))}</textarea></div>

          <div class="wfai-row">${sw('group.ignore_global_prompt', g.ignore_global_prompt !== false, g.ignore_global_prompt !== false ? '忽略全局默认提示词（只用下面这段）' : '在全局提示词后面追加下面这段')}</div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">群聊专属提示词（留空 = 用全局）</label>

            <textarea class="wfai-ta" id="g-prompt" style="min-height:64px">${esc(g.system_prompt || '')}</textarea></div>

          <div class="wfai-note">当前是「按发言人分开合并」：A 和 B 同时 @ 你，会走两条独立管线，各自收到针对自己的回复，不会互相顶掉。

            合并发给模型的文本会带上「发言人：内容」，模型知道每句是谁说的。</div>

          <h3 style="margin-top:16px">被 @ 后持续激活</h3>

          <div class="wfai-row" style="flex-wrap:nowrap;gap:6px;align-items:center">

            ${sw('active.enabled', ac.enabled !== false, ac.enabled !== false ? '开' : '关')}

            <label style="min-width:auto;margin-left:10px">上限</label>

            <input class="wfai-in n" id="act-msgs" type="number" min="1" max="500" value="${ac.max_messages || 20}" style="width:74px">

            <span class="wfai-note" style="margin:0;white-space:nowrap">条 或</span>

            <input class="wfai-in n" id="act-mins" type="number" min="0" max="720" value="${ac.minutes || 5}" style="width:74px">

            <span class="wfai-note" style="margin:0;white-space:nowrap">分钟</span></div>

          <div class="wfai-row"><label>结束条件</label>

            <select class="wfai-sel" id="act-mode" style="flex:1">

              <option value="count" ${!ac.mode || ac.mode === 'count' ? 'selected' : ''}>按条数（够 N 条就停）</option>

              <option value="time" ${ac.mode === 'time' ? 'selected' : ''}>按时长（到点就停）</option>

              <option value="both" ${ac.mode === 'both' ? 'selected' : ''}>先到先结束</option>

            </select></div>

          <div class="wfai-row">${sw('active.extend_on_mention', ac.extend_on_mention !== false, ac.extend_on_mention !== false ? '激活中再 @ 会刷新' : '不刷新')}

            ${sw('active.push_webhook', ac.push_webhook === true, ac.push_webhook === true ? '每条也推 Webhook' : '不推 Webhook')}</div>

          <div class="wfai-note">被 @ 之后，这个群在窗口内收到的消息（谁发的都算）都会照常走「合并缓冲 → 推送 → 回复」。

            例如设 20 条 / 5 分钟，@ 一次之后群里接下来 20 条都会被处理，仍按合并延迟合并后再回。</div>

          ${(uiState.activeSessions && uiState.activeSessions.length) ? `<div class="wfai-row" style="flex-wrap:wrap;gap:8px">${uiState.activeSessions.map((x) => `<span class="wfai-pill">${esc(x.contact)} · 剩 ${x.remaining} 条 · 已处理 ${x.used}</span>`).join('')}</div>` : ''}

        </div>

        <div class="wfai-card">

          <h3>图片 / 表情包</h3>

      <div class="wfai-row">${sw('filter.drop_self', c.filter.drop_self !== false, c.filter.drop_self !== false ? '忽略自己发的消息（推荐）' : '会把自己的消息也当消息处理')}</div>

      <div class="wfai-note">WeFlow 偶尔会把本账号发出的文字、图片、表情也推过来。打开后这类回声会被直接丢掉，不会再出现"自己回自己的表情包"。</div>

          <div class="wfai-row"><label>处理图片类消息</label>${sw('media.enabled', mc.enabled !== false, mc.enabled !== false ? '开' : '全部忽略')}</div>

          <div class="wfai-row"><label>怎么处理</label>

            <select class="wfai-sel" id="md-action" style="flex:1">

              <option value="vision" ${!mc.action || mc.action === 'vision' ? 'selected' : ''}>把真图喂给视觉模型（推荐）</option>

              <option value="note" ${mc.action === 'note' ? 'selected' : ''}>只告诉模型「某人发了图」</option>

              <option value="ack" ${mc.action === 'ack' ? 'selected' : ''}>固定回一句（下面自己填）</option>

              <option value="ignore" ${mc.action === 'ignore' ? 'selected' : ''}>当没看见</option>

            </select></div>

          <div class="wfai-row"><label>固定回复内容</label><input class="wfai-in" id="md-ack" placeholder="仅在选「固定回一句」时生效" value="${esc(mc.ack_text || '')}"></div>

          <div class="wfai-note">WeFlow 的推送里图片只是 <code>[图片]</code> 文本，但它本地接口 <code>/api/v1/messages?media=1</code> 能把图**解密导出成真实文件**，

            所以选「喂给视觉模型」时，Bot 会先取回那张图再带上文字发给视觉模型。</div>

          <div class="wfai-row"><label>视觉模型</label><input class="wfai-in" id="vs-model" placeholder="留空=用主模型（多数主模型看不了图，建议单独填 qwen-vl / glm-4v 等）" value="${esc(vs.model || '')}"></div>

          <div class="wfai-row"><label>视觉 Base URL</label><input class="wfai-in" id="vs-base" placeholder="留空=用主 AI 的" value="${esc(vs.base_url || '')}"></div>

          <div class="wfai-row"><label>视觉 API Key</label><input class="wfai-in" id="vs-key" type="password" placeholder="留空=用主 AI 的" value="${esc(vs.api_key || '')}"></div>

          <div class="wfai-row"><label>最多几张图（1-20）</label><input class="wfai-in n" id="vs-max" type="number" min="1" max="20" value="${vs.max_images || 4}">

            <button class="wfai-btn" id="vs-test">测试视觉（拿最近一张图）</button></div>

          <h3 style="margin-top:16px">本地表情包库</h3>

          <div class="wfai-row"><label>启用</label>${sw('sticker.enabled', st.enabled === true, st.enabled === true ? '每次回复后附一个' : '关闭')}

            ${sw('reply.at_person', rp.at_person !== false, rp.at_person !== false ? '回复时 @ 对方' : '不 @ 人')}</div>

          <div class="wfai-row"><label>表情包目录</label><input class="wfai-in" id="st-dir" placeholder="${esc(st.dir || '')}" value="${esc(st.dir || '')}">

            <button class="wfai-btn" id="st-browse">选择</button><button class="wfai-btn ghost" id="st-open">打开目录</button></div>

          <div class="wfai-row"><label>怎么挑</label>

            <select class="wfai-sel" id="st-pick" style="flex:1">

              <option value="model" ${!st.pick || st.pick === 'model' ? 'selected' : ''}>按文件名让模型挑</option>

              <option value="tagged" ${st.pick === 'tagged' ? 'selected' : ''}>按视觉标记挑（省 token，推荐）</option>

              <option value="vision" ${st.pick === 'vision' ? 'selected' : ''}>视觉模型直接看图挑（最准，最贵）</option>

              <option value="random" ${st.pick === 'random' ? 'selected' : ''}>随机挑一个</option>

            </select></div>

          <div class="wfai-row">

            <button class="wfai-btn" id="st-scan">扫描图库（视觉模型打标记）</button>

            <span class="wfai-note" style="margin:0" id="st-scan-status">已标记 ${(uiState.stickerIndex && uiState.stickerIndex.tagged) || 0} / ${(uiState.stickerIndex && uiState.stickerIndex.total) || 0}</span>

          </div>

          ${(function () {

            const sc = uiState.stickerScan || {};

            if (sc.running) return `<div class="wfai-note">正在扫描 ${sc.done} / ${sc.total} …</div>`;

            const items = (uiState.stickerIndex && uiState.stickerIndex.items) || [];

            const tagged = items.filter((x) => x.what);

            if (!tagged.length) return '<div class="wfai-note">还没有标记。点上面的按钮，让视觉模型把每张图的内容和适用场景记下来，之后挑选就按这些标记走。</div>';

            return `<div class="wfai-list" style="max-height:170px">${tagged.slice(0, 60).map((x) => `<div class="wfai-pick" style="cursor:default"><span class="nm">${esc(x.name)}</span><span class="uid">${esc(x.what || '')}${x.mood ? ' · ' + esc(x.mood) : ''}${x.when ? ' · 适合：' + esc(x.when) : ''}</span></div>`).join('')}</div>`;

          })()}

          <div class="wfai-row"><label>发送方式</label>

            <select class="wfai-sel" id="st-as" style="flex:1">

              <option value="auto" ${!st.send_as || st.send_as === 'auto' ? 'selected' : ''}>自动（静态图当图片发，动图当文件发）</option>

              <option value="image" ${st.send_as === 'image' ? 'selected' : ''}>一律当图片发</option>

              <option value="file" ${st.send_as === 'file' ? 'selected' : ''}>一律当文件发</option>

            </select>

            <button class="wfai-btn ghost" id="st-test">测试挑选</button></div>

          <div class="wfai-note">把 <code>png / jpg / gif / webp</code> 丢进这个文件夹就行，文件名尽量能表意（开心、无语、无奈…），模型会按文件名挑。

            当前目录里有 <b id="st-count">?</b> 个表情包。</div>

          <h3 style="margin-top:16px">回复格式</h3>

          <div class="wfai-row"><label>禁用 emoji</label>${sw('reply.strip_emoji', rp.strip_emoji !== false, rp.strip_emoji !== false ? '会过滤掉' : '允许表情')}</div>

          <div class="wfai-row"><label>整理标点</label>${sw('reply.tidy_punct', rp.tidy_punct !== false, rp.tidy_punct !== false ? '去掉 markdown / 统一标点' : '原样发出')}</div>

          <div class="wfai-row"><label>群聊回复字数上限</label><input class="wfai-in n" id="rp-group" type="number" min="20" max="800" value="${rp.max_chars_group || 160}"></div>

          <div class="wfai-note">即使模型吐了 emoji，发出去之前也会被字符级过滤掉（含 ZWJ 组合、肤色、旗帜）。<br>「整理标点」会去掉加粗星号、井号标题、竖线表格、反引号代码这些 markdown 残留，把半角的逗号句号冒号问号叹号统一成中文全角，合并重复标点，并把英文引号统一成「」。</div>

        </div>

      </div>`;

  }

  function renderRules() {

    const c = uiState.cfg;

    const a = c.archive || {};

    const w = c.watch || {};

    const mm = c.mention || {};

    const p = c.push || {};

    const ar = uiState.archive || {};

    const ts = uiState.triggerStats || {};

    const sw = (id, on, label, danger) => `<span class="wfai-sw ${on ? 'on' : ''} ${danger ? 'danger' : ''}" data-rsw="${id}"><i></i>${label}</span>`;

    const last = ar.lastStats

      ? `上次 ${ar.lastStats.reason} · ${fmtTime(ar.lastStats.at)} · 会话 ${ar.lastStats.sessions} · 新写入 ${ar.lastStats.appended} 条 · 跳过 ${ar.lastStats.skipped}${ar.lastStats.errors ? ' · 错误 ' + ar.lastStats.errors : ''}`

      : '还没跑过';

    const evRows = (uiState.events || []).map((e) => `<div class="wfai-msg">

        <span class="t">${fmtTime(e.at)}</span>

        <span class="who" title="${esc(e.contact)}">${esc(e.contact)}</span>

        <span class="txt">${esc(e.message && e.message.text) || ''}${e.contextCount ? `<span class="wfai-note">（附上文 ${e.contextCount} 条）</span>` : ''}</span>

        <span class="wfai-tag ${e.delivered === 'ok' ? 'ok' : (e.delivered && e.delivered !== 'no-target' ? 'err' : 'dry')}">${esc(e.type === 'poke' ? '拍了拍' : (e.type === 'mention' ? '@' + (e.alias || '') : (e.keyword || '关键词')))} · ${esc(e.delivered || '-')}</span>

      </div>`).join('');



    return `

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>定时归档（全本地）</h3>

          <div class="wfai-row"><label>启用</label>${sw('archive.enabled', a.enabled, a.enabled ? '已开启' : '已关闭')}</div>

          <div class="wfai-row"><label>间隔（分钟）</label><input class="wfai-in n" id="ar-interval" type="number" min="1" max="1440" value="${a.interval_minutes || 30}">

            <label style="min-width:auto">范围</label>

            <select class="wfai-sel" id="ar-scope" style="flex:1;min-width:120px">

              <option value="whitelist" ${a.scope !== 'all' ? 'selected' : ''}>只归档名单内会话</option>

              <option value="all" ${a.scope === 'all' ? 'selected' : ''}>全部会话</option>

            </select></div>

          <div class="wfai-row"><label>每会话条数</label><input class="wfai-in n" id="ar-limit" type="number" min="20" max="1000" value="${a.limit_per_session || 200}">

            <label style="min-width:auto">会话上限</label><input class="wfai-in n" id="ar-maxses" type="number" min="1" max="1000" value="${a.max_sessions_per_run || 400}"></div>

          <div class="wfai-row"><label>目录</label><input class="wfai-in" id="ar-dir" placeholder="${esc(ar.dir || '')}" value="${esc(a.dir || '')}"></div>

          <div class="wfai-row"><button class="wfai-btn" id="wfai-archive-now">立即归档</button>

            <button class="wfai-btn ghost" id="wfai-open-archive">打开归档目录</button></div>

          <div class="wfai-note">${esc(last)}<br>累计写入 ${ar.totalRows || 0} 条 · 已跟踪 ${ar.sessionCursors || 0} 个会话 · 数据全部落在本机 NDJSON</div>

        </div>

        <div class="wfai-card">

          <h3>出站 Webhook</h3>

          <div class="wfai-row"><label>地址</label><input class="wfai-in" id="p-url" placeholder="http://127.0.0.1:8080/hook" value="${esc(p.url || '')}"></div>

          <div class="wfai-row"><label>超时 ms</label><input class="wfai-in n" id="p-timeout" type="number" min="1000" max="60000" value="${p.timeout_ms || 12000}"></div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">附加请求头（JSON）</label>

            <textarea class="wfai-ta" id="p-headers" style="min-height:60px">${esc(JSON.stringify(p.headers || {}, null, 0))}</textarea></div>

          <div class="wfai-row"><button class="wfai-btn" id="wfai-test-hook">发一条测试事件</button>

            <span class="wfai-note" style="margin:0">成功 ${ts.webhookOk || 0} · 失败 ${ts.webhookFail || 0}</span></div>

          <div class="wfai-note">事件体：{ source, type, at, sessionId, contact, isGroup, sender, keyword, alias, message:{text}, context:[{ts,sender,text}], contextCount }</div>

        </div>

      </div>

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>群聊被动监听（关键词）</h3>

          <div class="wfai-row"><label>启用</label>${sw('watch.enabled', w.enabled, w.enabled ? '已开启' : '已关闭')}

            ${sw('watch.groups_only', w.groups_only, w.groups_only ? '只看群聊' : '私聊也算')}</div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">关键词（每行一个，包含即命中）</label>

            <textarea class="wfai-ta" id="w-keywords" style="min-height:78px">${esc((w.keywords || []).join('\n'))}</textarea></div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">正则（每行一个，可选）</label>

            <textarea class="wfai-ta" id="w-regex" style="min-height:56px">${esc((w.regex || []).join('\n'))}</textarea></div>

          <div class="wfai-row"><label>携带上文条数</label><input class="wfai-in n" id="w-ctx" type="number" min="0" max="40" value="${w.context_count == null ? 10 : w.context_count}">

            <label style="min-width:auto">冷却秒</label><input class="wfai-in n" id="w-cool" type="number" min="0" max="3600" value="${w.cooldown_seconds == null ? 120 : w.cooldown_seconds}"></div>

          <div class="wfai-row"><label>同时让 AI 回复</label>${sw('watch.also_ai', w.also_ai, w.also_ai ? '会' : '不会')}

            ${sw('watch.respect_filter', w.respect_filter, w.respect_filter ? '受名单限制' : '不受名单限制')}</div>

          <div class="wfai-note">匹配完全在本地做（字符串 / 正则），不消耗任何大模型额度。已触发 ${ts.keyword || 0} 次。<br>「受名单限制」默认关闭：WeFlow 那份推送名单里全是私聊 wxid、没有一个群，套上去群监听会直接失效。</div>

        </div>

        <div class="wfai-card">

          <h3>@ 触发（被 @ 时）</h3>

          <div class="wfai-row"><label>启用</label>${sw('mention.enabled', mm.enabled, mm.enabled ? '已开启' : '已关闭')}</div>

          <div class="wfai-row" style="display:block"><label style="display:block;margin-bottom:6px">我的昵称/群名片（每行一个，命中 @昵称 即触发）</label>

            <textarea class="wfai-ta" id="m-aliases" style="min-height:64px">${esc((mm.aliases || []).join('\n'))}</textarea></div>

          <div class="wfai-row"><label>携带上文条数</label><input class="wfai-in n" id="m-ctx" type="number" min="0" max="40" value="${mm.context_count == null ? 10 : mm.context_count}">

            <label style="min-width:auto">冷却秒</label><input class="wfai-in n" id="m-cool" type="number" min="0" max="3600" value="${mm.cooldown_seconds == null ? 0 : mm.cooldown_seconds}" title="0 = 每次 @ 都回复"></div>

          <div class="wfai-row">${sw('mention.respect_filter', mm.respect_filter, mm.respect_filter ? '受名单限制' : '不受名单限制')}

            ${sw('mention.poke_enabled', mm.poke_enabled !== false, mm.poke_enabled !== false ? '拍一拍也算叫到' : '拍一拍不理')}</div>

          <div class="wfai-row"><label>动作</label>

            <select class="wfai-sel" id="m-action" style="flex:1;min-width:120px">

              <option value="webhook" ${mm.action === 'webhook' ? 'selected' : ''}>只推 Webhook</option>

              <option value="ai" ${mm.action === 'ai' ? 'selected' : ''}>只让 AI 回</option>

              <option value="both" ${mm.action === 'both' || !mm.action ? 'selected' : ''}>两个都做</option>

            </select></div>

          <div class="wfai-note">只认群消息里的「@昵称」文本，纯本地判断；已触发 ${ts.mention || 0} 次。选「只让 AI 回」时不需要开启上面的自动回复开关。</div>

        </div>

      </div>

      <div class="wfai-row" style="justify-content:flex-end">

        <button class="wfai-btn ghost" id="wfai-rules-reload">丢弃修改</button>

        <button class="wfai-btn pri" id="wfai-rules-save">保存规则</button>

      </div>

      ${renderArchiveCard()}

    ${renderScheduleCard()}

    ${renderContextCard()}

    ${renderWebCard()}

    ${renderGroupCards()}

      ${renderArchiveRules()}

      <div class="wfai-card">

        <h3>触发记录</h3>

        <div class="wfai-row" style="margin-top:0"><div class="wfai-spacer"></div>

          <span class="wfai-note" style="margin:0">关键词 ${ts.keyword || 0} · @ ${ts.mention || 0}</span>

          <button class="wfai-btn ghost" id="wfai-clear-events">清空</button></div>

        ${evRows || '<div class="wfai-empty">还没有触发。关键词/@ 命中后会出现在这里。</div>'}

      </div>`;

  }



  function setPath(obj, dot, val) {

    const ps = String(dot).split('.');

    let o = obj;

    for (let i = 0; i < ps.length - 1; i++) { o[ps[i]] = o[ps[i]] || {}; o = o[ps[i]]; }

    o[ps[ps.length - 1]] = val;

  }



  function readScheduleRules() {

    const q = (id) => { const e = els.page.querySelector('#' + id); return e ? e.value : ''; };

    const n = (id, d) => { const x = Number(q(id)); return Number.isFinite(x) ? x : d; };

    const chk = (id) => { const e = els.page.querySelector('#' + id); return !!(e && e.checked); };

    const cur = (uiState.schedule && uiState.schedule.rules) || [];

    return cur.map((r, i) => {

      const type = q(`s-${i}-type`) || 'daily';

      const mode = q(`s-${i}-mode`) || 'text';

      const box = els.page.querySelector(`#s-${i}-text`);

      const body = box ? box.value.trim() : '';

      const on = (function () {

        const el = Array.from(els.page.querySelectorAll('[data-rsw]')).find((e) => e.dataset.rsw === `sched.rule.${i}`);

        return el ? el.classList.contains('on') : true;

      })();

      const person = Array.from(els.page.querySelectorAll('[data-rsw]')).some((e) => e.dataset.rsw === `sched.rule.${i}.person` && e.classList.contains('on'));

      const dry = Array.from(els.page.querySelectorAll('[data-rsw]')).some((e) => e.dataset.rsw === `sched.rule.${i}.dry` && e.classList.contains('on'));

      const days = ['1','2','3','4','5','6','7'].filter((d) => chk(`s-${i}-d${d}`)).map(Number);

      const contact = q(`s-${i}-contact`).trim();

      return {

        id: r.id,

        createdAt: r.createdAt,

        name: q(`s-${i}-name`).trim() || contact || '未命名',

        enabled: on,

        contact,

        sessionId: r.sessionId || (contact.endsWith('@chatroom') ? contact : ''),

        isGroup: !!r.isGroup || /群/.test(contact),

        type,

        at: q(`s-${i}-at`) || r.at || '09:00',

        days: days.length ? days : [1],

        day: n(`s-${i}-day`, 1),

        atISO: q(`s-${i}-atISO`) || r.atISO || '',

        everyMinutes: n(`s-${i}-every`, 60),

        mode,

        text: mode === 'text' ? body : (r.text || ''),

        prompt: mode === 'ai' ? body : (r.prompt || ''),

        atPerson: person,

        catchUpMinutes: n(`s-${i}-catch`, 0),

        maxRuns: n(`s-${i}-maxruns`, 0),

        dryRun: dry,

        runs: r.runs || 0,

        lastRunAt: r.lastRunAt || 0,

      };

    });

  }



  // 读 DOM；元素不在就退回"上一次的值"，绝不拿默认值把用户的设置顶掉

  const pickVal = (id, fallback) => {

    const el = els.page && els.page.querySelector('#' + id);

    return el ? el.value : fallback;

  };



  function readRules() {

    const q = (id) => { const e = els.page.querySelector(id); return e ? e.value : ''; };

    const n = (id, d) => { const x = Number(q(id)); return Number.isFinite(x) ? x : d; };

    const lines = (id) => q(id).split('\n').map((s) => s.trim()).filter(Boolean);

    const cur = uiState.cfg;

    let headers = cur.push.headers || {};

    try { const t = q('#p-headers').trim(); headers = t ? JSON.parse(t) : {}; } catch (_) { toast('请求头不是合法 JSON，已保留原值', 'err'); }

    return {

      archive: {

        enabled: cur.archive.enabled,

        interval_minutes: n('#ar-interval', 30),

        scope: q('#ar-scope') || 'whitelist',

        limit_per_session: n('#ar-limit', 200),

        max_sessions_per_run: n('#ar-maxses', 400),

        dir: q('#ar-dir').trim(),

      },

      watch: {

        enabled: cur.watch.enabled,

        groups_only: cur.watch.groups_only,

        keywords: lines('#w-keywords'),

        regex: lines('#w-regex'),

        context_count: n('#w-ctx', 10),

        cooldown_seconds: n('#w-cool', 120),

        also_ai: cur.watch.also_ai,

        respect_filter: cur.watch.respect_filter,

      },

      mention: {

        enabled: cur.mention.enabled,

        aliases: lines('#m-aliases'),

        context_count: n('#m-ctx', 10),

        cooldown_seconds: n('#m-cool', 0),

        poke_enabled: cur.mention.poke_enabled !== false,

        action: q('#m-action') || 'both',

        respect_filter: cur.mention.respect_filter,

      },

      push: { url: q('#p-url').trim(), headers, timeout_ms: n('#p-timeout', 12000) },

      group: {

        buffer_seconds: n('#g-buffer', 0),

        max_replies_per_minute: n('#g-rate', 6),

        keywords: lines('#g-keywords'),

        system_prompt: q('#g-prompt'),

        ignore_global_prompt: cur.group.ignore_global_prompt !== false,

        at_enabled: cur.group.at_enabled !== false,

        keyword_enabled: cur.group.keyword_enabled === true,

        auto_reply: cur.group.auto_reply === true,

        per_sender: cur.group.per_sender !== false,

        reply_mention: cur.group.reply_mention !== false,

      },

      filter: { drop_self: cur.filter.drop_self !== false },

      context: {

        enabled: cur.context.enabled !== false,

        max_tokens: Math.max(8000, n('#cx-max', 200000)),

        compress_at: Math.max(0.3, Math.min(0.95, n('#cx-at', 75) / 100)),

        keep_recent: Math.max(2, n('#cx-keep', 20)),

        summary_max_chars: Math.max(120, n('#cx-sum', 700)),

        archive_compressed: cur.context.archive_compressed !== false,

      },

      web: {

        enabled: cur.web.enabled !== false,

        search_url: pickVal('wb-url', cur.web.search_url || '').trim() || 'https://cn.bing.com/search?q={q}',

        search_json_path: q('#wb-path').trim(),

        api_key: q('#wb-key').trim(),

        api_header: q('#wb-header').trim() || 'Authorization',

        api_prefix: q('#wb-prefix'),

        max_results: n('#wb-max', 6),

        fetch_limit_kb: n('#wb-kb', 200),

        timeout_ms: n('#wb-ms', 20000),

      },

      active: {

        enabled: cur.active.enabled !== false,

        mode: pickVal('act-mode', cur.active.mode || 'count') || 'count',

        max_messages: n('#act-msgs', 20),

        minutes: n('#act-mins', 5),

        extend_on_mention: cur.active.extend_on_mention !== false,

        push_webhook: cur.active.push_webhook === true,

      },

      media: {

        enabled: cur.media.enabled !== false,

        action: pickVal('md-action', cur.media.action || 'vision') || 'vision',

        ack_text: q('#md-ack'),

      },

      vision: {

        enabled: cur.vision.enabled !== false,

        base_url: q('#vs-base').trim(),

        api_key: q('#vs-key').trim(),

        model: q('#vs-model').trim(),

        max_images: n('#vs-max', 4),

        max_kb: cur.vision.max_kb || 4096,

      },

      sticker: {

        enabled: cur.sticker.enabled === true,

        dir: q('#st-dir').trim(),

        pick: pickVal('st-pick', cur.sticker.pick || 'model') || 'model',

        max_per_reply: 1,

        send_as: pickVal('st-as', cur.sticker.send_as || 'auto') || 'auto',

      },

      reply: {

        strip_emoji: cur.reply.strip_emoji !== false,

        max_chars_group: n('#rp-group', 160),

        at_person: cur.reply.at_person !== false,

        tidy_punct: cur.reply.tidy_punct !== false,

      },

    };

  }



  const ACCESS_MODES = [

    ['off', '不访问文件', '插件只能写 Bot 自己的输出目录'],

    ['readonly', '只读 · 工作区内', '可读工作区，不能写'],

    ['readonly_all', '只读 · 整机', '可读整台电脑的文件，不能写'],

    ['workspace_rw', '读写 · 工作区内', '在工作区里可读可写'],

    ['full', '完全访问（整机读写）', '整台电脑都能读和改，最危险'],

  ];



  function renderPlugins() {

    const c = uiState.cfg;

    const a = c.access || {};

    const ag = c.agent || {};

    const plugins = uiState.plugins || [];

    const cur = ACCESS_MODES.find((m) => m[0] === a.mode) || ACCESS_MODES[0];

    const danger = a.mode === 'full' || a.mode === 'readonly_all';

    const rows = plugins.map((p) => `<div class="wfai-msg" style="align-items:center">

        <span class="who" style="flex:0 0 150px">${esc(p.name)}</span>

        <span class="wfai-tag ${p.source === 'builtin' ? 'ok' : 'dry'}">${p.source === 'builtin' ? '内置' : '用户'}</span>

        <span class="txt"><code style="color:var(--wfai-acc)">${esc(p.commands.map((x) => '/' + x).join(' '))}</code>

          <span class="wfai-note">v${esc(p.version)} · ${esc(p.description)}</span>

          ${p.usage ? `<span class="wfai-note" style="white-space:pre-wrap">${esc(p.usage)}</span>` : ''}

          ${p.ok ? '' : `<span class="wfai-note" style="color:var(--wfai-err)">${esc(p.error || '不可用')}</span>`}

        </span>

        <span class="wfai-sw ${p.enabled ? 'on' : ''}" data-plugin="${esc(p.id)}" data-on="${p.enabled ? 1 : 0}"><i></i>${p.enabled ? '启用' : '停用'}</span>

        ${p.source === 'builtin' ? '<span style="width:46px"></span>' : `<button class="wfai-btn ghost" data-uninstall="${esc(p.id)}">卸载</button>`}

      </div>`).join('');



    return `

      ${danger ? `<div class="wfai-warnbar danger">当前文件权限是「${esc(cur[1])}」：Bot 可以读到（${a.mode === 'full' ? '并且改写' : ''}）整台电脑上的文件。只在需要时打开。</div>` : ''}

      <div class="wfai-2col">

        <div class="wfai-card">

          <h3>文件访问权限</h3>

          <div class="wfai-row"><label>权限级别</label>

            <select class="wfai-sel" id="ac-mode" style="flex:1">

              ${ACCESS_MODES.map(([v, l, d]) => `<option value="${v}" ${a.mode === v ? 'selected' : ''}>${l} — ${d}</option>`).join('')}

            </select></div>

          <div class="wfai-row"><label>工作区目录</label><input class="wfai-in" id="ac-ws" placeholder="${esc(uiState.workspace || '')}" value="${esc(a.workspace || '')}"></div>

          <div class="wfai-row"><label>单次读取上限 KB</label><input class="wfai-in n" id="ac-readkb" type="number" min="1" max="8192" value="${a.max_read_kb || 512}">

            <label style="min-width:auto">写入上限 MB</label><input class="wfai-in n" id="ac-writemb" type="number" min="1" max="512" value="${a.max_write_mb || 32}"></div>

          <div class="wfai-row"><button class="wfai-btn" id="ac-save">保存权限</button>

            <button class="wfai-btn ghost" id="ac-open-ws">打开工作区</button>

            <button class="wfai-btn ghost" id="ac-open-out">打开输出目录</button></div>

          <div class="wfai-note">生效位置：工作区 = ${esc(uiState.workspace || '')}<br>输出目录（始终可写）= ${esc((uiState.paths && uiState.paths.out) || '')}<br>系统目录（Windows / Program Files / WeFlow 安装目录）即使完全访问也拒绝写入。</div>

        </div>

        <div class="wfai-card">

          <h3>命令路由</h3>

          <div class="wfai-row"><label>启用 Agent</label>${sw2('ag-enabled', ag.enabled, ag.enabled ? '已启用' : '已停用')}</div>

          <div class="wfai-row"><label>模型自主选工具</label>${sw2('ag-tools', ag.auto_tools, ag.auto_tools ? '开（推荐）' : '关')}

            <label style="min-width:auto">最多</label><input class="wfai-in n" id="ag-rounds" type="number" min="1" max="8" value="${ag.max_tool_rounds || 4}">

            <span class="wfai-note" style="margin:0">轮</span></div>

          <div class="wfai-note">打开后由大模型自己判断该调哪个插件/工具（function calling），不用写 <code>/命令</code>；

            也可以继续用 <code>/help</code> 这类显式命令，会优先走命令路由。当前工具的调用模型还依赖你的模型支持 tools。</div>

          <div class="wfai-row"><label>接受命令的场景</label>

            <select class="wfai-sel" id="ag-where" style="flex:1">

              <option value="mention_dm" ${ag.where !== 'all' ? 'selected' : ''}>私聊 + 群里 @ 我（推荐）</option>

              <option value="all" ${ag.where === 'all' ? 'selected' : ''}>所有消息</option>

            </select></div>

          <div class="wfai-row"><label>生成的文件发回微信</label>${sw2('ag-files', ag.send_files, ag.send_files ? '会发' : '不发')}</div>

          <div class="wfai-row"><label>最多几个附件</label><input class="wfai-in n" id="ag-maxfiles" type="number" min="1" max="5" value="${ag.max_files_per_reply || 3}">

            <label style="min-width:auto">插件超时 秒</label><input class="wfai-in n" id="ag-timeout" type="number" min="5" max="180" value="${ag.plugin_timeout_seconds || 25}"></div>

          <div class="wfai-note">工具调用统计：${(uiState.toolStats && uiState.toolStats.calls) || 0} 次（成功 ${(uiState.toolStats && uiState.toolStats.ok) || 0} / 失败 ${(uiState.toolStats && uiState.toolStats.fail) || 0}）。命令清单见下；也可以直接在微信里发 <code>/help</code>。</div>

        </div>

      </div>

      <div class="wfai-card">

        <h3>插件（${plugins.length}）</h3>

        <div class="wfai-row" style="margin-top:0">

          <button class="wfai-btn pri" id="pl-install-zip">从 ZIP 安装</button>

          <button class="wfai-btn ghost" id="pl-install-dir">从文件夹安装</button>

          <button class="wfai-btn ghost" id="pl-install-url">从 GitHub 安装</button>

          <button class="wfai-btn ghost" id="pl-template">生成示例插件</button>

          <div class="wfai-spacer"></div>

          <button class="wfai-btn ghost" id="pl-rescan">重新扫描</button>

          <button class="wfai-btn ghost" id="pl-open">打开插件目录</button>

        </div>

        ${rows || '<div class="wfai-empty">没有发现插件。点「打开插件目录」放一个 &lt;id&gt;/plugin.json + index.js 进去。</div>'}

      </div>

      <div class="wfai-card">

        <h3>本地自测（不经过微信）</h3>

        <div class="wfai-row"><input class="wfai-in" id="ag-test-input" placeholder="/help 或 /ppt 示例标题&#10;# 第一页&#10;- 要点">

          <button class="wfai-btn pri" id="ag-test-run">运行</button></div>

        <div class="wfai-log" id="ag-test-out" style="max-height:240px">（还没运行）</div>

      </div>`;

  }



  function sw2(id, on, label, danger) {

    return `<span class="wfai-sw ${on ? 'on' : ''} ${danger ? 'danger' : ''}" data-agsw="${id}" data-on="${on ? 1 : 0}"><i></i>${label}</span>`;

  }



  function readAccess() {

    const q = (id) => { const e = els.page.querySelector(id); return e ? e.value : ''; };

    const n = (id, d) => { const x = Number(q(id)); return Number.isFinite(x) ? x : d; };

    const cur = uiState.cfg;

    return {

      access: {

        mode: q('#ac-mode') || 'off',

        workspace: q('#ac-ws').trim(),

        max_read_kb: n('#ac-readkb', 512),

        max_write_mb: n('#ac-writemb', 32),

      },

      agent: {

        enabled: cur.agent.enabled,

        where: q('#ag-where') || 'mention_dm',

        send_files: cur.agent.send_files,

        max_files_per_reply: n('#ag-maxfiles', 3),

        plugin_timeout_seconds: n('#ag-timeout', 25),

        auto_tools: cur.agent.auto_tools,

        max_tool_rounds: n('#ag-rounds', 4),

      },

    };

  }



  function renderLogs() {

    const lines = uiState.logs.map((l) => `<span class="${l.level}">${esc(l.msg)}</span>`).join('\n');

    return `<div class="wfai-row" style="margin-top:0"><div class="wfai-spacer"></div>

        <span class="wfai-note">${esc(uiState.paths.logs)}</span>

        <button class="wfai-btn ghost" id="wfai-clear-logs">清空</button></div>

      <div class="wfai-log">${lines || '暂无日志'}</div>`;

  }



  function renderBody() {

    const body = els.body;

    // 用户正在改、还没保存的输入框，重绘后要原样写回去

    const dirtySnap = {};

    try {

      for (const id of DIRTY) {

        const el = els.page && els.page.querySelector('#' + id);

        if (el) dirtySnap[id] = el.value;

        else if (DIRTY_VALS.has(id)) dirtySnap[id] = DIRTY_VALS.get(id);

      }

    } catch (_) {}

    const keepBody = body ? body.scrollTop : 0;

    const prevList = els.page.querySelector('#wl-list');

    const keepList = prevList ? prevList.scrollTop : 0;

    const restore = () => {

      if (body) body.scrollTop = keepBody;

      const l = els.page.querySelector('#wl-list');

      if (l && keepList) l.scrollTop = keepList;

    };

    if (!uiState) { body.innerHTML = '<div class="wfai-empty">正在连接本地服务…</div>'; return; }

    if (tab === 'settings') {

      if (!CATALOG) loadCatalog();

      if (!WLF.loaded) loadWeFlowFilter().then((w) => { if (w && w.loaded && tab === 'settings') renderBody(); });

    }

    if (tab === 'rules' && !CATALOG) loadCatalog();

    if (tab === 'rules' && !ARCH) loadArchiveRules().then(() => { if (tab === 'rules') renderBody(); });

    if (tab === 'overview') body.innerHTML = renderOverview();

    else if (tab === 'messages') body.innerHTML = renderMessages();

    else if (tab === 'settings') body.innerHTML = renderSettings();

    else if (tab === 'rules') body.innerHTML = renderRules();

    else if (tab === 'plugins') body.innerHTML = renderPlugins();

    else body.innerHTML = renderLogs();

    if (tab === 'logs') { const p = body.querySelector('.wfai-log'); if (p) p.scrollTop = p.scrollHeight; }

    else restore();

    // 把未保存的内容写回去

    try {

      for (const [id, v] of Object.entries(dirtySnap)) {

        const el = body.querySelector('#' + id);

        if (el && el.value !== v) el.value = v;

      }

    } catch (_) {}

    wire();

    markDirtyListeners();

  }



  function renderHeader() {

    if (!uiState) return;

    const conn = uiState.conn.connected;

    const led = els.page.querySelector('#wfai-led-conn');

    if (led) led.className = 'wfai-led ' + (conn ? 'on' : (uiState.conn.lastError ? 'err' : 'warn'));

    const tc = els.page.querySelector('#wfai-txt-conn');

    if (tc) tc.textContent = conn ? '已连接 WeFlow' : (uiState.conn.lastError ? '连接失败' : '未连接');

    const tr = els.page.querySelector('#wfai-txt-run');

    if (tr) tr.textContent = uiState.started ? '监听中' : '已停止';

    const tb = els.page.querySelector('#wfai-btn-toggle');

    if (tb) {

      tb.textContent = uiState.started ? '停止监听' : '开始监听';

      tb.className = 'wfai-btn ' + (uiState.started ? 'ghost' : 'pri');

    }

    const s = uiState.stats;

    const set = (id, v) => { const e = els.page.querySelector(id); if (e) e.textContent = v; };

    set('#wfai-s-recv', s.received); set('#wfai-s-replied', s.replied); set('#wfai-s-sent', s.sent);

    set('#wfai-s-dry', s.dryrun); set('#wfai-s-filtered', s.filtered); set('#wfai-s-errors', s.errors);

    const tg = uiState.triggerStats || {};

    set('#wfai-s-trig', (tg.keyword || 0) + (tg.mention || 0));

    // sidebar dot

    const dot = document.querySelector('.wfai-nav .wfai-dot');

    if (dot) dot.className = 'wfai-dot ' + (conn ? 'on' : (uiState.conn.lastError ? 'err' : ''));

  }



  // 正在输入框里打字时不要重绘页面，否则刚打的字会被轮询冲掉

  function isEditing() {

    const a = document.activeElement;

    if (!a || !els.page || !els.page.contains(a)) return false;

    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;

    if (a.type === 'checkbox' || a.type === 'radio') return false;

    return true;

  }



  function renderBodySafe(force) {

    if (!force && isEditing()) return;

    renderBody();

  }



  // -------------------------------------------------------------------- events

  async function act(op, extra, okMsg) {

    try {

      const r = await api('api', { op, ...(extra || {}) });

      if (extra && extra.cfg) { DIRTY.clear(); DIRTY_VALS.clear(); }

      const keepEditing = isEditing();

      if (r.state) { uiState = r.state; renderHeader(); if (!keepEditing) renderBody(); else renderHeader(); }

      if (okMsg) toast(okMsg);

      return r;

    } catch (e) {

      toast(e.message, 'err');

      throw e;

    }

  }



  function collectSettings() {

    const v = (id) => { const e = els.page.querySelector(id); return e ? e.value : ''; };

    const n = (id, d) => { const x = Number(v(id)); return Number.isFinite(x) ? x : d; };

    return {

      auto_reply: uiState.cfg.auto_reply,

      dry_run: uiState.cfg.dry_run,

      buffer_seconds: n('#cfg-buffer', 10),

      max_history: n('#cfg-history', 6),

      max_reply_chars: n('#cfg-maxchars', 120),

      system_prompt: v('#cfg-prompt'),

      filter: (function () {

        const curF = uiState.cfg.filter || {};

        const modeEl = els.page.querySelector('#cfg-filter-mode');

        const listEl = els.page.querySelector('#cfg-filter-list');

        const patch = {

          drop_other_emoji: curF.drop_other_emoji !== false,

          emoji_mode: (els.page.querySelector('#cfg-emoji-mode') || {}).value || curF.emoji_mode || 'pure',

        };

        // 只有在"名单编辑框真的渲染出来"的时候才覆盖名单，否则保留原样

        if (modeEl) patch.mode = modeEl.value;

        if (listEl) patch.list = listEl.value.split('\n').map((s) => s.trim()).filter(Boolean);

        return patch;

      })(),

      weflow: { base_url: v('#cfg-wf-base').trim(), access_token: v('#cfg-wf-token').trim() },

      ai: {

        provider: v('#cfg-ai-provider') || 'custom',

        native_search: uiState.cfg.ai.native_search === true,

        search_strategy: v('#cfg-ai-strategy') || 'agent',

        native_read_url: uiState.cfg.ai.native_read_url !== false,

        thinking: v('#cfg-ai-thinking') || 'auto',

        reasoning_effort: v('#cfg-ai-effort') || '',

        type: v('#cfg-ai-type'),

        base_url: v('#cfg-ai-base').trim(),

        api_key: v('#cfg-ai-key').trim(),

        model: v('#cfg-ai-model').trim(),

        timeout: n('#cfg-ai-timeout', 40),

        ollama_url: v('#cfg-ollama-url').trim(),

        ollama_model: v('#cfg-ollama-model').trim(),

      },

      send: { enabled: uiState.cfg.send.enabled, delay_ms: n('#cfg-wx-delay', 350), search_down: n('#cfg-wx-down', 0), wechat_exe: v('#cfg-wx-exe').trim() },

    };

  }



  async function pullToken(btn) {

    try {

      const apiBridge = window.electronAPI;

      if (!apiBridge || !apiBridge.config) throw new Error('electronAPI 不可用');

      const t = await apiBridge.config.get('httpApiToken');

      if (!t) throw new Error('WeFlow 配置里没有 httpApiToken');

      if (String(t).startsWith('safe:')) throw new Error('该值被 WeFlow 加密存储（safe: 前缀），请到 WeFlow 设置里复制明文 Token');

      const input = els.page.querySelector('#cfg-wf-token');

      if (input) input.value = t;

      await act('save', { cfg: { weflow: { access_token: t } } }, '已读取并保存 Token');

    } catch (e) {

      toast('读取失败：' + e.message, 'err');

    }

  }



  async function useWeFlowAi() {

    try {

      const apiBridge = window.electronAPI;

      const [base, key, model] = await Promise.all([

        apiBridge.config.get('aiModelApiBaseUrl'),

        apiBridge.config.get('aiModelApiKey'),

        apiBridge.config.get('aiModelApiModel'),

      ]);

      if (!base) throw new Error('WeFlow 没有配置 AI 接口');

      const cfg = {

        ai: {

          type: 'openai',

          base_url: String(base).trim(),

          api_key: /^safe:/.test(String(key || '')) ? '' : String(key || '').trim(),

          model: String(model || '').trim(),

        },

      };

      await act('save', { cfg }, '已套用 WeFlow 的 AI 配置');

      if (/^safe:/.test(String(key || ''))) toast('API Key 在 WeFlow 里是加密存储，需要手动填一次', 'err');

    } catch (e) {

      toast('读取失败：' + e.message, 'err');

    }

  }



  function markDirtyListeners() {

    try {

      els.body.querySelectorAll('input,textarea,select').forEach((el) => {

        if (!el.id || el.__wfaiDirty) return;

        el.__wfaiDirty = true;

        const remember = () => { DIRTY.add(el.id); DIRTY_VALS.set(el.id, el.value); };

        el.addEventListener('input', remember);

        el.addEventListener('change', remember);

      });

    } catch (_) {}

  }



  // ------------------------------------------------------------------ 归档编辑浮层

  // 直接挂在 document.body 上，不参与面板重绘，所以不会被轮询冲掉

  function openArchiveEditor(sid) {

    const old = document.getElementById('arc-modal');

    if (old) old.remove();

    const wrap = document.createElement('div');

    wrap.id = 'arc-modal';

    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;';

    wrap.innerHTML = `

      <div style="width:min(1000px,92vw);max-height:88vh;display:flex;flex-direction:column;background:#232019;border:1px solid #3a342c;border-radius:12px;padding:14px;gap:10px;box-shadow:0 20px 60px rgba(0,0,0,.6)">

        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">

          <b style="color:#f4e6c8">编辑归档：${esc(sid)}</b>

          <span style="font-size:12px;color:#9c937f" id="arc-m-info">读取中…</span>

          <span style="margin-left:auto"></span>

          <button class="wfai-btn pri" id="arc-m-save">保存修改</button>

          <button class="wfai-btn ghost" id="arc-m-close">关闭</button>

        </div>

        <textarea id="arc-m-text" spellcheck="false" style="flex:1;min-height:340px;width:100%;background:#1b1913;color:#e8e2d4;border:1px solid #3a342c;border-radius:8px;padding:10px;font-family:Consolas,Menlo,monospace;font-size:12px;line-height:1.5;resize:vertical"></textarea>

        <div style="font-size:12px;color:#9c937f" id="arc-m-note">每行一条 JSON 记录，改完点「保存修改」（自动留一份 .bak）。删掉某几行就等于删掉那几条记录。</div>

      </div>`;

    document.body.appendChild(wrap);

    const ta = wrap.querySelector('#arc-m-text');

    const info = wrap.querySelector('#arc-m-info');

    const note = wrap.querySelector('#arc-m-note');

    wrap.querySelector('#arc-m-close').onclick = () => wrap.remove();

    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };

    const callApi = async (payload) => {

      const b = window.__WFAI__ || {};

      const res = await fetch('http://127.0.0.1:' + b.port + '/api', {

        method: 'POST',

        headers: { 'Content-Type': 'application/json', 'x-wfai': b.token },

        body: JSON.stringify(payload),

      });

      const j = await res.json();

      if (j && j.ok === false) throw new Error(j.error || '接口失败');

      return j;

    };

    callApi({ op: 'archiveRead', sessionId: sid }).then((r) => {

      const v = (r && r.result) || {};

      ta.value = v.text || '';

      info.textContent = (v.sizeKb || 0) + ' KB' + (v.truncated ? '（太大，只显示前 3MB）' : '');

    }).catch((e) => { info.textContent = '读取失败：' + e.message; });

    let armed = false;

    wrap.querySelector('#arc-m-save').onclick = async () => {

      const btn = wrap.querySelector('#arc-m-save');

      if (!armed) {

        armed = true;

        btn.textContent = '再点一次确认保存';

        note.textContent = '会覆盖这个会话的归档文件（自动留一份 .bak）。再点一次「确认保存」执行。';

        setTimeout(() => { armed = false; try { btn.textContent = '保存修改'; } catch (_) {} }, 5000);

        return;

      }

      armed = false;

      btn.textContent = '保存中…';

      try {

        const r = await callApi({ op: 'archiveWrite', sessionId: sid, text: ta.value });

        const v = (r && r.result) || {};

        note.textContent = `已保存：${v.valid} 条有效${v.invalid ? '，' + v.invalid + ' 条格式不对' : ''}`;

        try { const l = await callApi({ op: 'archiveList' }); uiState.archiveMgr = l.result || {}; } catch (_) {}

      } catch (e) { note.textContent = '保存失败：' + e.message; }

    };

  }



  // ------------------------------------------------------------------ 隐藏 WeFlow 的「匿名数据收集」开关

  // 它本来就不上传、也不显示任何东西，留着只会让人以为在偷数据。

  function hideTelemetryToggle() {

    try {

      // 1) 「匿名数据收集」开关（纯上报，服务器已废，留着只会让人误会）

      for (const el of document.querySelectorAll('.log-toggle-line')) {

        if ((el.textContent || '').includes('匿名数据收集')) {

          el.style.display = 'none';;

          el.setAttribute('data-wfai-hidden', '1');

        }

      }

      // 2) 本地统计两个入口：后端通道已封，进去只会是空页面

      const deadRoutes = ['#/analytics', '#/annual-report'];

      for (const a of document.querySelectorAll('nav a.nav-item')) {

        const href = a.getAttribute('href') || '';

        if (deadRoutes.includes(href) && a.style.display !== 'none') {

          a.style.display = 'none';;

          a.setAttribute('data-wfai-hidden', '1');

        }

      }

    } catch (_) {}

  }



  // 把每段绑定隔离开：任何一段抛错都不能让后面的按钮变砖
  function safeBind(fn) { try { fn(); } catch (e) { try { console.warn('[wfai] bind error', e); } catch (_) {} } }

  function wire() {
    try { wireInner(); } catch (e) { try { (window.__WFAI_WIRE_ERR = window.__WFAI_WIRE_ERR || []).push(String((e && e.stack) || e)); } catch (_) {} try { console.warn('[wfai] wire error', e); } catch (_) {} }
  }

  function wireInner() {
    // ---- 顶部固定「保存设置」：任何页签都可见，按当前页签决定存什么 ----
    (function bindTopSave() {
      const topSave = els.page.querySelector('#wfai-save-top');
      const saveBar = els.page.querySelector('#wfai-savebar');
      const dirtyTag = els.page.querySelector('#wfai-dirty');
      const cnt = (typeof DIRTY !== 'undefined' && DIRTY) ? DIRTY.size : 0;
      const has = cnt > 0;
      if (saveBar) saveBar.classList.toggle('dirty', has);
      if (topSave) {
        topSave.classList.toggle('has', has);
        if (!topSave.dataset.bound) {
          topSave.dataset.bound = '1';
          topSave.addEventListener('click', () => {
            const sBtn = els.page.querySelector('#wfai-save');
            const rBtn = els.page.querySelector('#wfai-rules-save');
            if (sBtn) { sBtn.click(); toast('设置已保存'); return; }
            if (rBtn) { rBtn.click(); toast('规则已保存'); return; }
            try { window.__WFAI_UI__.goto('settings'); } catch (_) {}
            toast('已切到设置页，改完点右上角保存');
          });
        }
      }
      if (dirtyTag) dirtyTag.textContent = has ? ('● ' + cnt + ' 处未保存') : '';
    })();


    adoptWeFlowEndpoint();
    hideTelemetryToggle();

    const page = els.page;

    // assign (not add) so repeated renders never stack handlers on header buttons

    const on = (sel, ev, fn) => { const e = page.querySelector(sel); if (e) e['on' + ev] = fn; };



    page.querySelectorAll('.wfai-tab').forEach((t) => {

      t.onclick = () => {

        tab = t.dataset.tab;

        page.querySelectorAll('.wfai-tab').forEach((x) => x.classList.toggle('act', x === t));

        renderBody();

      };

    });



    on('#wfai-btn-toggle', 'click', async () => {

      if (uiState && uiState.started) await act('stop', {}, '已停止监听');

      else {

        if (tab === 'settings') await act('start', { cfg: collectSettings() }, '开始监听');

        else await act('start', {}, '开始监听');

      }

    });

    on('#wfai-reconnect', 'click', () => act('reconnect', {}, '正在重新连接'));

    on('#wfai-sim', 'click', async () => {

      try {

        await act('simulate', { contact: '模拟联系人', text: '你好，在吗？(这是一条模拟推送)' });

        toast(uiState && uiState.cfg.auto_reply ? '已注入模拟推送，稍后查看消息列表' : '已注入，但自动回复是关闭的，只会记录');

      } catch (_) {}

    });

    on('#wfai-pull-token', 'click', () => pullToken());

    on('#wfai-pull-token2', 'click', () => pullToken());

    on('#wfai-open-cfg', 'click', () => act('openConfig'));

    on('#wfai-use-weflow-ai', 'click', () => useWeFlowAi());

    on('#wfai-clear-msgs', 'click', () => act('clear', {}, '已清空'));

    on('#wfai-clear-logs', 'click', () => act('clear', {}, '已清空'));

    on('#wfai-reload-cfg', 'click', () => refresh(true));

    on('#wfai-save', 'click', () => act('save', { cfg: collectSettings() }, '设置已保存'));

    // ---- 本地归档管理 ----

    if (tab === 'rules' && els.page.querySelector('#arc-refresh') && !uiState.archiveMgr) {

      act('archiveList').then((r) => { uiState.archiveMgr = r.result || {}; renderBody(true); }).catch(() => {});

    }

    on('#arc-refresh', 'click', async () => {

      try { const r = await act('archiveList', { refresh: true }); uiState.archiveMgr = r.result || {}; renderBody(true); } catch (e) { toast(e.message, 'err'); }

    });

    on('#arc-open', 'click', async () => {

      try {

        // 不要再依赖前端缓存的 dir（没加载完就是空字符串，openPath('') 会静默失败）

        const r = await act('archiveOpen');

        toast('已打开：' + ((r.result || {}).path || ''));

      } catch (e) { toast(e.message, 'err'); }

    });

    on('#arc-all', 'click', (e) => { e.preventDefault(); uiState.arAll = true; renderBody(true); });
    on('#arc-clear', 'click', async () => {

      if (!confirm('会删掉所有会话的归档文件（含压缩包），此操作不可撤销。确认？')) return;

      try { const r = await act('archiveClearAll'); toast('已清空 ' + ((r.result || {}).removed || 0) + ' 个文件'); const l = await act('archiveList'); uiState.archiveMgr = l.result || {}; renderBody(true); } catch (e) { toast(e.message, 'err'); }

    });

    on('#arc-q', 'input', (e) => {

      uiState.arQuery = e.target.value;

      if (e.isComposing) return;

      const box = els.page.querySelector('.wfai-list');

      if (box) {

        const q = String(uiState.arQuery || '').toLowerCase();

        const items = ((uiState.archiveMgr || {}).items) || [];

        const list = q ? items.filter((x) => String(x.name || '').toLowerCase().includes(q) || String(x.sessionId || '').toLowerCase().includes(q)) : items;

        box.querySelectorAll('[data-ardel]').forEach((b) => { const row = b.closest('[data-arsid]'); if (row) row.style.display = list.some((x) => x.sessionId === b.dataset.ardel) ? '' : 'none'; });

      }

    });

    Array.from(page.querySelectorAll('[data-aropen]')).forEach((b) => {

      b.onclick = async () => {

        try { const r = await act('archiveOpen', { sessionId: b.dataset.aropen }); const v = r.result || {}; toast('已打开：' + (v.path || '')); }

        catch (e) { toast(e.message, 'err'); }

      };

    });

    Array.from(page.querySelectorAll('[data-aredit]')).forEach((b) => {

      b.onclick = () => openArchiveEditor(b.dataset.aredit);

    });

    on('#arc-close', 'click', () => {});

    on('#arc-save', 'click', async () => {

      const ta = els.page.querySelector('#arc-text');

      const cur = uiState.arcEdit;

      if (!cur || !ta) return;

      if (!confirm('会覆盖这个会话的归档文件（自动留 .bak），确认保存？')) return;

      const text = ta.value;

      try {

        const r = await act('archiveWrite', { sessionId: cur.sid, text });

        const v = r.result || {};

        uiState.arcEdit = { ...cur, text, note: `已保存：${v.valid} 条有效${v.invalid ? '，' + v.invalid + ' 条格式不对' : ''}` };

        DIRTY.delete('arc-text');

        toast('已保存');

        const l = await act('archiveList'); uiState.archiveMgr = l.result || {};

        renderBody(true);

      } catch (e) { toast(e.message, 'err'); }

    });

    Array.from(page.querySelectorAll('[data-arfile]')).forEach((b) => {

      b.onclick = async () => {

        try { const r = await act('archiveOpen', { sessionId: b.dataset.arfile, file: true }); toast('已用默认程序打开，改完保存即可'); }

        catch (e) { toast(e.message, 'err'); }

      };

    });

    Array.from(page.querySelectorAll('[data-ardel]')).forEach((b) => {

      b.onclick = async () => {

        const sid = b.dataset.ardel;

        if (!confirm('删除这个会话的归档？' + sid)) return;

        try {

          await act('archiveDelete', { sessionId: sid });

          toast('已删除');

          const l = await act('archiveList'); uiState.archiveMgr = l.result || {}; renderBody(true);

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    on('#arc-search', 'click', async () => {

      const out = els.page.querySelector('#arc-results');

      if (out) out.textContent = '搜索中…';

      try {

        const q = (els.page.querySelector('#arc-sq') || {}).value || '';

        const days = Number((els.page.querySelector('#arc-days') || {}).value) || 30;

        const r = await act('archiveSearch', { query: q, days, limit: 40 });

        const v = r.result || {};

        if (!out) return;

        if (!v.items || !v.items.length) { out.innerHTML = '<div class="wfai-empty">没搜到</div>'; return; }

        out.innerHTML = v.items.map((x) => {

          const d = new Date(x.ts * 1000);

          const pad = (n) => String(n).padStart(2, '0');

          return `<div class="wfai-pick" style="cursor:default"><span class="nm">${esc(x.name || x.sessionId)}</span><span class="uid">${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${esc(x.sender || '我')} · ${esc(String(x.text).slice(0, 120))}</span></div>`;

        }).join('');

      } catch (e) { if (out) out.textContent = '出错：' + e.message; }

    });

    on('#g-add', 'click', async () => {

      const g = (uiState.cfg && uiState.cfg.group) || {};

      const rules = Array.isArray(g.rules) ? g.rules.slice() : [];

      rules.push({ contact: '', sessionId: '', at_enabled: true, keyword_enabled: false, auto_reply: false, reply_mention: true, buffer_seconds: 10, max_replies_per_minute: 6, system_prompt: '' });

      try {

        await act('save', { cfg: { group: { per_group: true, rules } } }, '已新增一个群配置');

        const s2 = await api('state'); if (s2 && s2.cfg) uiState.cfg = s2.cfg;

        renderBody(true);

      } catch (e) { toast(e.message, 'err'); }

    });

    Array.from(page.querySelectorAll('[id^="gr-"][id$="-del"]')).forEach((b) => {

      b.onclick = async () => {

        const i = Number((b.id.match(/^gr-(\d+)-del$/) || [])[1]);

        const g = (uiState.cfg && uiState.cfg.group) || {};

        const rules = (Array.isArray(g.rules) ? g.rules : []).filter((_, k) => k !== i);

        try {

          await act('save', { cfg: { group: { rules } } }, '已删除');

          const s2 = await api('state'); if (s2 && s2.cfg) uiState.cfg = s2.cfg;

          renderBody(true);

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    on('#ar-search', 'input', (e) => {

      const q = String(e.target.value || '').trim().toLowerCase();

      const sel = els.page.querySelector('#ar-add-id');

      if (!sel) return;

      const keep = sel.value;

      const items = (CATALOG && CATALOG.items) || [];

      const list = q

        ? items.filter((x) => (x.name || '').toLowerCase().includes(q) || (x.username || '').toLowerCase().includes(q))

        : items;

      sel.innerHTML = list.slice(0, 300).map((x) => `<option value="${esc(x.username)}">${x.type === 'group' ? '👥' : '👤'} ${esc(x.name)}</option>`).join('')

        || '<option value="">没有匹配的会话</option>';

      if (keep && list.some((x) => x.username === keep)) sel.value = keep;

    });

    on('#wf-auto', 'click', async () => {

      const note = els.page.querySelector('#wf-auto-note');

      if (note) note.textContent = '识别中…';

      try {

        const r = await act('detectWeFlow');

        const v = r.result || {};

        const baseEl = els.page.querySelector('#cfg-wf-base');

        const tokEl = els.page.querySelector('#cfg-wf-token');

        const exeEl = els.page.querySelector('#cfg-wx-exe');

        if (baseEl && v.base_url) baseEl.value = v.base_url;

        if (tokEl && v.access_token) tokEl.value = v.access_token;

        if (exeEl && v.wechat_exe) exeEl.value = v.wechat_exe;

        if (note) note.textContent = (v.notes || []).join('；');

        toast('已填入，记得点「保存设置」');

      } catch (e) { if (note) note.textContent = '失败：' + e.message; }

    });

    on('#cfg-ai-apply', 'click', async () => {

      const p = (els.page.querySelector('#cfg-ai-provider') || {}).value || 'custom';

      const PRESET = {

        deepseek: { base_url: 'https://api.deepseek.com', model: 'deepseek-flash', type: 'openai' },

        dashscope: { base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', type: 'openai' },

        openai: { base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', type: 'openai' },

        ollama: { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', type: 'ollama' },

      };

      const pr = PRESET[p];

      if (!pr) return toast('自定义无需套用', 'err');

      try {

        await act('save', { cfg: { ai: { provider: p, type: pr.type, base_url: pr.base_url, model: pr.model } } }, `已套用 ${p} 预设`);

      } catch (e) { toast(e.message, 'err'); }

    });

    on('#wfai-test-ai', 'click', async () => {

      const b = page.querySelector('#wfai-test-ai');

      if (b) { b.disabled = true; b.textContent = '测试中…'; }

      try {

        const r = await act('testAi');

        toast(`AI 正常（${r.result.ms}ms）：${r.result.reply.slice(0, 40)}`);

      } catch (_) {} finally { if (b) { b.disabled = false; b.textContent = '测试 AI'; } }

    });

    on('#wfai-test-send', 'click', async () => {

      const contact = (page.querySelector('#wfai-test-contact') || {}).value || '';

      if (!contact.trim()) return toast('先填写要测试的群名/备注', 'err');

      if (!confirm(`将向「${contact}」真实发送一条测试消息，微信窗口会被自动操作。继续？`)) return;

      try {

        const r = await act('testSend', { contact: contact.trim(), text: `WeFlow Bot 测试消息 ${new Date().toLocaleTimeString()}` });

        toast(r.result.ok ? '微信发送成功' : '发送失败：' + r.result.detail, r.result.ok ? '' : 'err');

      } catch (_) {}

    });



    page.querySelectorAll('[data-sw]').forEach((sw) => {

      sw.onclick = async () => {

        const key = sw.dataset.sw;

        const cur = uiState.cfg;

        const patch = {};

        if (key === 'auto_reply') patch.auto_reply = !cur.auto_reply;

        if (key === 'dry_run') patch.dry_run = !cur.dry_run;

        if (key === 'send_enabled') {

          if (cur.send.enabled && !confirm('关闭键盘发送后，AI 回复只会写日志。继续？')) return;

          if (!cur.send.enabled && !confirm('开启后 AI 回复会真的通过键盘自动化发到微信，可能发错人。确认开启？')) return;

          patch.send = { enabled: !cur.send.enabled };

        }

        // 带点的键（如 filter.drop_other_emoji）走通用路径：取当前值取反再写回

        if (key.includes('.')) {

          let v = cur;

          for (const seg of key.split('.')) v = v && v[seg];

          setPath(patch, key, !v);

        }

        await act('save', { cfg: patch });

      };

    });



    page.querySelectorAll('[data-msgfilter]').forEach((b) => {

      b.onclick = () => { msgFilter = b.dataset.msgfilter; renderBody(); };

    });



    // ---- 规则页 ----

    // 开关统一走"事件委托"：绑在不会重建的 page 上，
    // 这样即使某个 handler 绑定出错，开关也永远能用（以前是逐个元素绑 onclick，
    // wire 中途抛错就整片开关失效）。
    if (!page.dataset.rswBound) {
      page.dataset.rswBound = '1';
      page.addEventListener('click', (ev) => {
        const sw = ev.target && ev.target.closest ? ev.target.closest('[data-rsw]') : null;
        if (!sw) return;
        toggleSwitch(sw);
      });
    }


  // 开关的实际逻辑（被上面的委托调用）
  async function toggleSwitch(swEl) {
    try {
      const path = swEl.dataset.rsw;
      if (!path) return;
      // 定时消息里的开关不参与 readRules，只切视觉状态，等「保存规则」统一收集
      if (path.startsWith('sched.')) { swEl.classList.toggle('on'); return; }
      const draft = readRules();
      const looksOn = swEl.classList.contains('on');
      const next = !looksOn;
      setPath(draft, path, next);
      swEl.classList.toggle('on', next);
      await act('save', { cfg: draft });
      try { Object.assign(uiState.cfg, draft); } catch (_) { uiState.cfg = draft; }
      try { const s2 = await api('state'); if (s2 && s2.cfg) uiState.cfg = s2.cfg; } catch (_) {}
    } catch (e) {
      try { toast('开关保存失败：' + e.message, 'err'); } catch (_) {}
    }
  }

    // ↓↓↓ 以下为其余绑定（保持在 wireInner 作用域内，on() 才可见）

    on('#wfai-rules-save', 'click', () => act('save', { cfg: readRules() }, '规则已保存'));

    on('#wfai-rules-reload', 'click', () => refresh(true));

    on('#wfai-archive-now', 'click', async () => {

      const b = page.querySelector('#wfai-archive-now');

      if (b) { b.disabled = true; b.textContent = '归档中…'; }

      try {

        const r = await act('archiveNow');

        const s = r.result || {};

        toast(s.skipped ? `跳过：${s.skipped}` : `归档完成：新写入 ${s.appended || 0} 条 / 会话 ${s.sessions || 0} 个`);

      } catch (_) {} finally { if (b) { b.disabled = false; b.textContent = '立即归档'; } }

    });

    on('#wfai-open-archive', 'click', () => act('openArchive'));

    on('#wfai-test-hook', 'click', async () => {

      try {

        await act('save', { cfg: readRules() });

        const r = await act('testWebhook');

        toast('测试事件：' + ((r.result && r.result.delivered) || '?'), r.result && r.result.delivered === 'ok' ? '' : 'err');

      } catch (_) {}

    });

    on('#wfai-clear-events', 'click', () => act('clearEvents', {}, '触发记录已清空'));

    on('#wfai-import-wl', 'click', async () => {

      try {

        const r = await act('importWhitelist');

        const x = r.result || {};

        toast(`已导入 ${x.count} 条（${x.mode === 'blacklist' ? '黑名单' : '白名单'}模式，WeFlow 原设置=${x.weflowMode}）`);

      } catch (e) { toast(e.message, 'err'); }

    });



    // ---- 名单选择器 ----

    page.querySelectorAll('[data-wl]').forEach((cb) => {

      cb.onchange = async (ev) => {

        const id = cb.dataset.wl;

        const cur = new Set(currentFilterList());

        if (ev.target.checked) cur.add(id); else cur.delete(id);

        const list = [...cur];

        // 先就地更新，绝不整页重绘，避免滚动条跳回顶部

        setFilterList(list);

        try {

          const mode = uiState.cfg.filter.mode === 'off' ? 'whitelist' : uiState.cfg.filter.mode;

          const r = await api('api', { op: 'save', cfg: { filter: { mode, list, sync_weflow: uiState.cfg.filter.sync_weflow !== false } } });

          if (r.state) { uiState = r.state; renderHeader(); }

          await pushToWeFlow(list, mode);

          // 只在「已选」视图下需要把取消的那一行移除

          if (WL.kind === 'picked') renderBody();

        } catch (e) {

          toast(e.message, 'err');

          renderBody();

        }

      };

    });

    page.querySelectorAll('[data-wlkind]').forEach((c) => {

      c.onclick = () => { WL.kind = c.dataset.wlkind; renderBody(); };

    });

    if (els.page.querySelector('#wl-q')) {

      let wlTimer = null;

      let composing = false;

      on('#wl-q', 'compositionstart', () => { composing = true; });

      on('#wl-q', 'compositionend', (e) => {

        composing = false;

        WL.query = e.target.value;

        clearTimeout(wlTimer);

        wlTimer = setTimeout(() => { renderBody(); const a = els.page.querySelector('#wl-q'); if (a) { a.focus(); try { a.setSelectionRange(WL.query.length, WL.query.length); } catch (_) {} } }, 60);

      });

      on('#wl-q', 'input', (e) => {

        WL.query = e.target.value;

        if (composing || e.isComposing) return;      // 输入法还在组合，不能重绘，否则中文打不进去

        const pos = e.target.selectionStart;

        clearTimeout(wlTimer);

        wlTimer = setTimeout(() => {

          renderBody();

          const again = els.page.querySelector('#wl-q');

          if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (_) {} }

        }, 220);

      });

    }

    on('#wl-more', 'click', (e) => { e.preventDefault(); WL.showAll = true; renderBody(true); });
    on('#wl-all', 'click', async () => {

      const cur = new Set(currentFilterList());

      const { items } = wlVisible();

      for (const x of items) cur.add(x.username);

      try { await applyFilterChange([...cur]); toast(`已加入 ${items.length} 项`); } catch (e) { toast(e.message, 'err'); }

    });

    on('#wl-none', 'click', async () => {

      if (!confirm('清空整个名单？')) return;

      try { await applyFilterChange([]); } catch (e) { toast(e.message, 'err'); }

    });

    on('#wl-reload', 'click', () => loadCatalog(true));

    on('#wl-read-wf', 'click', async () => {

      try { await adoptFromWeFlow(); renderBody(); } catch (e) { toast(e.message, 'err'); }

    });

    on('#wl-push-wf', 'click', async () => {

      try {

        await pushToWeFlow(currentFilterList(), uiState.cfg.filter.mode === 'off' ? 'whitelist' : uiState.cfg.filter.mode);

        toast('已推送到 WeFlow');

      } catch (e) { toast(e.message, 'err'); }

    });

    page.querySelectorAll('[data-syncwl]').forEach((el) => {

      el.onclick = async () => {

        const on = uiState.cfg.filter.sync_weflow === false;

        await act('save', { cfg: { filter: { sync_weflow: on } } });

        if (on) { await adoptFromWeFlow(); }

        renderBody();

      };

    });

    page.querySelectorAll('[data-wfpush]').forEach((el) => {

      el.onclick = async () => {

        try {

          const bridge = window.electronAPI;

          const next = !(WLF.loaded && WLF.enabled);

          await bridge.config.set('messagePushEnabled', next);

          WLF.enabled = next; WLF.loaded = true;

          toast('WeFlow 推送已' + (next ? '开启' : '关闭'));

          renderBody();

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    if (els.page.querySelector('#cfg-filter-mode')) {

      const sel = els.page.querySelector('#cfg-filter-mode');

      const orig = sel.value;

      sel.onchange = async () => {

        try { await applyFilterChange(currentFilterList(), sel.value); } catch (e) { toast(e.message, 'err'); }

      };

    }



    // ---- 视觉 / 表情包 ----

    on('#vs-test', 'click', async () => {

      const b = els.page.querySelector('#vs-test');

      if (b) { b.disabled = true; b.textContent = '识别中…'; }

      try {

        await act('save', { cfg: { media: { action: 'vision' }, vision: readRules().vision } });

        // 不写死任何会话：优先取最近活跃的那个

        const sess = (uiState.recent || [])[0] || (uiState.sessions || [])[0] || {};

        const sid = sess.sessionId || sess.contact || '';

        if (!sid) { toast('还没有任何会话消息，先让微信来一条', 'err'); return; }

        const pr = await act('mediaProbe', { sessionId: sid, withinSeconds: 86400 });

        const info = pr.result || {};

        if (!info.found) { toast('这个会话最近没有可导出的图片', 'err'); return; }

        const r = await act('visionTest', { file: info.file });

        const v = r.result || {};

        toast(v.ok ? `视觉模型说：${String(v.text).slice(0, 60)}` : '失败：' + (v.error || ''), v.ok ? '' : 'err');

      } catch (e) { toast(e.message, 'err'); } finally { if (b) { b.disabled = false; b.textContent = '测试视觉（拿最近一张图）'; } }

    });

    // 数据目录
    // 只用一次性标志位：uiState 每 4 秒被服务端快照覆盖，用它做条件会死循环
    if (tab === 'settings' && els.page.querySelector('#dp-root') && !dataPathsLoaded) {
      dataPathsLoaded = true;
      act('dataPaths').then((r) => { uiState.dataPaths = r.result || {}; renderBody(true); }).catch(() => {});
    }
    on('#dp-pick', 'click', async () => {
      const cur = ((uiState.dataPaths || {}).root) || '';
      try {
        const r = await api('api', { op: 'pickDir', title: '选择缓存目录', defaultPath: cur });
        const p = r && r.result && r.result.path;
        if (!p) return;
        await act('setDataRoot', { root: p });
        const d = await act('dataPaths');
        uiState.dataPaths = d.result || {};
        const note = els.page.querySelector('#dp-note');
        if (note) note.innerHTML = '已设为 <code>' + p + '</code>，<b>重启 WeFlow 后生效</b>，旧数据会自动复制过去。';
        renderBody(true);
      } catch (e) { toast(e.message, 'err'); }
    });
    on('#dp-default', 'click', async () => {
      try {
        const r = await act('setDataRoot', { root: '__default__' });
        const d = await act('dataPaths');
        uiState.dataPaths = d.result || {};
        const note = els.page.querySelector('#dp-note');
        if (note) note.innerHTML = '已改回默认 <code>' + ((r.result || {}).root || '') + '</code>，<b>重启 WeFlow 后生效</b>。';
        renderBody(true);
      } catch (e) { toast(e.message, 'err'); }
    });
    on('#st-browse', 'click', async () => {
      const input = els.page.querySelector('#st-dir');
      const cur = input ? String(input.value || '').trim() : '';
      try {
        const r = await api('api', { op: 'pickDir', kind: 'sticker', title: '选择本地表情包库目录', defaultPath: cur });
        const p = r && r.result && r.result.path;
        if (!p) return;
        if (input) input.value = p;
        await act('save', { cfg: { sticker: { dir: p } } });
        const l = await act('stickerList');
        toast('已设置为 ' + p + '（' + (((l.result || {}).total) || 0) + ' 张图）');
      } catch (e) { toast(e.message, 'err'); }
    });
    on('#st-open', 'click', async () => {

      try {

        const r = await act('stickerList');

        const d = (r.result || {}).dir;

        await act('openPath', { path: d, allowOutside: true });

      } catch (e) { toast(e.message, 'err'); }

    });

    on('#sched-add', 'click', async () => {

      const rules = readScheduleRules();

      rules.push({

        id: 'r' + Date.now(), createdAt: Date.now(), name: '新规则', enabled: true,

        contact: '', isGroup: false, type: 'daily', at: '09:00', days: [1], day: 1,

        atISO: '', everyMinutes: 60, mode: 'text', text: '', prompt: '', runs: 0, lastRunAt: 0,

      });

      try { await act('schedSave', { rules }, '已新增规则'); uiState.schedule = { ...(uiState.schedule || {}), rules }; renderBody(true); } catch (e) { toast(e.message, 'err'); }

    });

    on('#sched-save', 'click', async () => {

      try {

        const rules = readScheduleRules();

        await act('schedSave', { rules }, '定时规则已保存');

        const l = await act('schedList');

        uiState.schedule = l.result; DIRTY.clear();

        renderBody(true);

      } catch (e) { toast(e.message, 'err'); }

    });

    Array.from(page.querySelectorAll('[id^="s-"][id$="-del"]')).forEach((b) => {

      b.onclick = async () => {

        const i = Number((b.id.match(/^s-(\d+)-del$/) || [])[1]);

        const rules = readScheduleRules().filter((_, k) => k !== i);

        try { await act('schedSave', { rules }, '已删除'); const l = await act('schedList'); uiState.schedule = l.result; renderBody(true); } catch (e) { toast(e.message, 'err'); }

      };

    });

    Array.from(page.querySelectorAll('[id^="s-"][id$="-test"]')).forEach((b) => {

      b.onclick = async () => {

        const i = Number((b.id.match(/^s-(\d+)-test$/) || [])[1]);

        const rules = readScheduleRules();

        try {

          await act('schedSave', { rules });

          const r = await act('schedTest', { id: rules[i] && rules[i].id });

          const v = r.result || {};

          toast(v.ok ? `已触发：${v.text || ''}` : '失败：' + (v.error || v.skipped || ''), v.ok ? '' : 'err');

          const l = await act('schedList'); uiState.schedule = l.result; renderBody(true);

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    on('#cx-preset', 'change', () => {

      const v = (els.page.querySelector('#cx-preset') || {}).value;

      const box = els.page.querySelector('#cx-max');

      if (box && v && v !== 'custom') box.value = v;

    });

    on('#wb-test', 'click', async () => {

      const out = els.page.querySelector('#wb-out');

      if (out) out.textContent = '搜索中…';

      try {

        await act('save', { cfg: { web: readRules().web } });

        const q = (els.page.querySelector('#wb-q') || {}).value || '';

        const r = await act('webTest', { q });

        const v = r.result || {};

        if (out) out.textContent = v.ok ? String(v.text).slice(0, 1200) : '失败：' + (v.text || '');

      } catch (e) { if (out) out.textContent = '出错：' + e.message; }

    });

    on('#wb-fetch', 'click', async () => {

      const out = els.page.querySelector('#wb-out');

      const q = ((els.page.querySelector('#wb-q') || {}).value || '').trim();

      if (!/^https?:\/\//i.test(q)) { if (out) out.textContent = '请在上面输入一个完整网址（http/https）'; return; }

      if (out) out.textContent = '抓取中…';

      try {

        await act('save', { cfg: { web: readRules().web } });

        const r = await act('webTest', { url: q });

        const v = r.result || {};

        if (out) out.textContent = v.ok ? String(v.text).slice(0, 1200) : '失败：' + (v.text || '');

      } catch (e) { if (out) out.textContent = '出错：' + e.message; }

    });

    on('#st-scan', 'click', async () => {

      const b = els.page.querySelector('#st-scan');

      if (b) { b.disabled = true; b.textContent = '扫描中…'; }

      try {

        const r = await act('stickerScan', { force: false });

        const n = (r.result || {}).total || 0;

        toast(n ? `开始扫描 ${n} 张表情包` : '图库里都标过了（想重扫按住 Shift 点）');

        // 轮询进度

        for (let i = 0; i < 60; i++) {

          await new Promise((res) => setTimeout(res, 2000));

          const ix = await act('stickerIndex');

          uiState.stickerIndex = ix.result;

          const sc = (ix.result || {}).scan || {};

          if (b) b.textContent = `扫描中 ${sc.done || 0}/${sc.total || 0}`;

          if (!sc.running) break;

        }

        toast('扫描完成');

      } catch (e) { toast(e.message, 'err'); } finally {

        if (b) { b.disabled = false; b.textContent = '扫描图库（视觉模型打标记）'; }

        try { const ix = await act('stickerIndex'); uiState.stickerIndex = ix.result; } catch (_) {}

        renderBody();

      }

    });

    on('#st-test', 'click', async () => {

      try {

        await act('save', { cfg: { sticker: readRules().sticker } });

        const r = await act('stickerProbe', { text: '今天真是太好了，谢谢' });

        const v = r.result || {};

        toast(v.picked ? `挑中了：${v.picked}` : '没挑出来（目录为空或模型没答对）', v.picked ? '' : 'err');

      } catch (e) { toast(e.message, 'err'); }

    });

    if (els.page.querySelector('#st-count')) {

      api('api', { op: 'stickerList' }).then((r) => {

        const el = els.page.querySelector('#st-count');

        if (el) el.textContent = String(((r.result || {}).total) || 0);

      }).catch(() => {});

    }



    // ---- 插件安装/卸载 ----

    on('#pl-install-zip', 'click', () => installPlugin('zip'));

    on('#pl-install-dir', 'click', () => installPlugin('dir'));

    on('#pl-install-url', 'click', () => installPlugin('url'));

    on('#pl-template', 'click', () => installPlugin('tmpl'));

    page.querySelectorAll('[data-uninstall]').forEach((b) => {

      b.onclick = async () => {

        const id = b.dataset.uninstall;

        if (!confirm(`卸载插件 ${id}？会删除它在插件目录里的文件夹。`)) return;

        try { await act('uninstallPlugin', { id }); toast('已卸载'); } catch (e) { toast(e.message, 'err'); }

      };

    });



    // ---- 单独归档规则 ----

    on('#ar-add', 'click', async () => {

      const sid = (page.querySelector('#ar-add-id') || {}).value || '';

      if (!sid) return toast('先选一个会话', 'err');

      const name = (() => {

        const o = page.querySelector('#ar-add-id');

        return o && o.selectedOptions[0] ? o.selectedOptions[0].textContent.replace(/^[^\s]+\s/, '') : sid;

      })();

      const hours = Number((page.querySelector('#ar-add-h') || {}).value || 0);

      const max = Number((page.querySelector('#ar-add-m') || {}).value || 0);

      const rules = ((ARCH && ARCH.rules) || []).map((r) => ({ id: r.id, name: r.name, enabled: r.enabled !== false, interval_hours: r.interval_hours, max_records: r.max_records }));

      if (rules.some((r) => r.id === sid)) return toast('这个会话已有规则', 'err');

      rules.push({ id: sid, name: name.trim(), enabled: true, interval_hours: hours, max_records: max });

      try { await saveArchiveRules(rules); toast('已添加归档规则'); } catch (e) { toast(e.message, 'err'); }

    });

    page.querySelectorAll('[data-arrm]').forEach((b) => {

      b.onclick = async () => {

        const id = b.dataset.arrm;

        const rules = ((ARCH && ARCH.rules) || []).filter((r) => r.id !== id)

          .map((r) => ({ id: r.id, name: r.name, enabled: r.enabled !== false, interval_hours: r.interval_hours, max_records: r.max_records }));

        try { await saveArchiveRules(rules); toast('已删除'); } catch (e) { toast(e.message, 'err'); }

      };

    });

    page.querySelectorAll('[data-arule]').forEach((el) => {

      el.onclick = async () => {

        const id = el.dataset.arule;

        const on = el.dataset.on !== '1';

        const rules = ((ARCH && ARCH.rules) || []).map((r) =>

          r.id === id ? { ...r, enabled: on } : { id: r.id, name: r.name, enabled: r.enabled !== false, interval_hours: r.interval_hours, max_records: r.max_records });

        try { await saveArchiveRules(rules.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, interval_hours: r.interval_hours, max_records: r.max_records }))); } catch (e) { toast(e.message, 'err'); }

      };

    });

    for (const sel of ['[data-arh]', '[data-arm]']) {

      page.querySelectorAll(sel).forEach((inp) => {

        inp.onchange = async () => {

          const id = inp.dataset.arh || inp.dataset.arm;

          const key = inp.dataset.arh ? 'interval_hours' : 'max_records';

          const val = Number(inp.value || 0);

          const rules = ((ARCH && ARCH.rules) || []).map((r) => ({

            id: r.id, name: r.name, enabled: r.enabled !== false,

            interval_hours: r.interval_hours, max_records: r.max_records,

          }));

          const hit = rules.find((r) => r.id === id);

          if (hit) hit[key] = val;

          try { await saveArchiveRules(rules); } catch (e) { toast(e.message, 'err'); }

        };

      });

    }

    page.querySelectorAll('[data-arnow]').forEach((b) => {

      b.onclick = async () => {

        b.disabled = true; b.textContent = '…';

        try {

          const r = await act('archiveSession', { sessionId: b.dataset.arnow });

          const s = r.result || {};

          toast(`已归档：新写入 ${s.appended || 0} 条`);

        } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; b.textContent = '归档'; }

      };

    });

    page.querySelectorAll('[data-arzip]').forEach((b) => {

      b.onclick = async () => {

        try {

          const r = await act('rotateSession', { sessionId: b.dataset.arzip, name: b.dataset.arname });

          toast((r.result || {}).message || '已压缩');

          await loadArchiveRules(true);

          renderBody();

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    if (els.page.querySelector('#ar-dfh') || els.page.querySelector('#ar-dfm')) {

      for (const [id, key] of [['#ar-dfh', 'default_interval_hours'], ['#ar-dfm', 'default_max_records']]) {

        const el = els.page.querySelector(id);

        if (el) el.onchange = async () => {

          try {

            await act('save', { cfg: { archive: { [key]: Number(el.value || 0) } } });

            toast('默认归档参数已保存');

          } catch (e) { toast(e.message, 'err'); }

        };

      }

    }

    page.querySelectorAll('[data-plugin]').forEach((el) => {

      el.onclick = async () => {

        const enabled = el.dataset.on !== '1';

        try {

          await act('setPlugin', { id: el.dataset.plugin, enabled });

          toast(enabled ? '插件已启用' : '插件已停用');

        } catch (e) { toast(e.message, 'err'); }

      };

    });

    page.querySelectorAll('[data-agsw]').forEach((el) => {

      el.onclick = async () => {

        try {

          const draft = readAccess();

          const k = el.dataset.agsw;

          if (k === 'ag-enabled') draft.agent.enabled = el.dataset.on !== '1';

          if (k === 'ag-files') draft.agent.send_files = el.dataset.on !== '1';

          if (k === 'ag-tools') draft.agent.auto_tools = el.dataset.on !== '1';

          await act('save', { cfg: draft });

        } catch (_) {}

      };

    });

    on('#ac-save', 'click', async () => {

      try {

        const d = readAccess();

        const mode = d.access.mode;

        if ((mode === 'full' || mode === 'readonly_all') && !confirm(`确定把文件权限设为「${mode === 'full' ? '完全访问（整机读写）' : '只读 · 整机'}」？\nBot 将能访问整台电脑上的文件。`)) return;

        await act('save', { cfg: d }, '权限已保存');

      } catch (e) { toast(e.message, 'err'); }

    });

    on('#ac-open-ws', 'click', () => act('openPath', { path: (uiState.cfg.access || {}).workspace || uiState.workspace }));

    on('#ac-open-out', 'click', () => act('openPath', { path: (uiState.paths || {}).out }));

    on('#pl-rescan', 'click', async () => { try { await act('scanPlugins'); toast('已重新扫描'); } catch (e) { toast(e.message, 'err'); } });

    on('#pl-open', 'click', () => act('openPlugins'));

    on('#ag-test-run', 'click', async () => {

      const inp = page.querySelector('#ag-test-input');

      const out = page.querySelector('#ag-test-out');

      const text = inp ? inp.value : '';

      if (!text.trim()) return toast('先输入一条命令', 'err');

      if (out) out.textContent = '运行中…';

      try {

        const r = await act('testAgent', { text });

        const res = r.result || {};

        if (out) {

          out.textContent = `${res.ok ? '✅ 成功' : '❌ 失败'}\n${res.message || '(无输出)'}` +

            ((res.files || []).length ? `\n\n附件：\n${res.files.join('\n')}` : '');

        }

      } catch (e) {

        if (out) out.textContent = '❌ ' + e.message;

      }

    });




  }

  // --------------------------------------------------------------------- state

  async function refresh(force) {

    try {

      const s = await api('state');

      const changed = !uiState

        || s.messages.length !== uiState.messages.length

        || s.stats.received !== uiState.stats.received

        || s.stats.sent !== uiState.stats.sent

        || s.stats.dryrun !== uiState.stats.dryrun

        || (s.events || []).length !== (uiState.events || []).length

        || (s.archive && uiState.archive && s.archive.lastRun !== uiState.archive.lastRun)

        || s.conn.connected !== uiState.conn.connected

        || s.started !== uiState.started

        // 日志每几秒就多一行，不该因为它整页重绘（只有日志页才需要刷）
        || (tab === 'logs' && s.logs.length && uiState.logs.length && s.logs[s.logs.length - 1].ts !== uiState.logs[uiState.logs.length - 1].ts);

      // 服务端快照里没有这些"本地界面状态"，替换时要把它们留住，

      // 否则每 2 秒轮询一次就会把编辑器关掉、把归档列表重新拉一遍

      const keepLocal = {

        archiveMgr: uiState ? uiState.archiveMgr : undefined,

        arQuery: uiState ? uiState.arQuery : undefined,

        arcEdit: uiState ? uiState.arcEdit : undefined,
        dataPaths: uiState ? uiState.dataPaths : undefined,

      };

      uiState = Object.assign({}, s, keepLocal);

      renderHeader();

      const tabNeedsBody = tab === 'overview' || tab === 'messages' || tab === 'logs';
      // 只有正在看的那一页数据变了才重绘：否则来一条消息就把整页（含按钮）重建，
      // 你按下的一瞬间按钮已被换掉，表现就是"所有按钮点不动"。
      if (open_ && (force || (tabNeedsBody && changed))) renderBodySafe(force);

    } catch (e) {

      const led = els.page && els.page.querySelector('#wfai-led-conn');

      if (led) led.className = 'wfai-led err';

      const tc = els.page && els.page.querySelector('#wfai-txt-conn');

      if (tc) tc.textContent = '本地服务未响应';

      if (open_ && !uiState) renderBody();

    }

  }



  // ------------------------------------------------------------------ show/hide

  let open_ = false;



  function hostRect() {

    const aside = document.querySelector('aside.sidebar');

    if (!aside) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

    const ar = aside.getBoundingClientRect();

    const parent = aside.parentElement;

    let best = null;

    let bestArea = 0;

    if (parent) {

      for (const el of parent.children) {

        if (el === aside) continue;

        const r = el.getBoundingClientRect();

        const a = r.width * r.height;

        if (a > bestArea) { bestArea = a; best = r; }

      }

    }

    if (best && best.width > 240 && best.height > 240) return { left: best.left, top: best.top, right: best.right, bottom: best.bottom };

    return { left: ar.right, top: ar.top, right: window.innerWidth, bottom: window.innerHeight };

  }



  function place() {

    const r = hostRect();

    Object.assign(els.page.style, {

      left: r.left + 'px', top: r.top + 'px',

      width: (r.right - r.left) + 'px', height: (r.bottom - r.top) + 'px',

    });

  }



  function setActive(on) {

    const a = document.querySelector('.wfai-nav');

    if (a) { if (on) a.classList.add('active'); else a.classList.remove('active'); }

    // keep exactly one highlighted row: suppress the router's own highlight

    // while the Bot page is open, and restore it from the URL when closing.

    const nav = document.querySelector('aside.sidebar nav.nav-menu');

    if (!nav) return;

    const others = Array.from(nav.querySelectorAll('a.nav-item')).filter((x) => !x.classList.contains('wfai-nav'));

    if (on) {

      others.forEach((x) => x.classList.remove('active'));

    } else {

      const p = String(location.pathname || '') + String(location.hash || '');

      let matched = false;

      others.forEach((x) => {

        const href = x.getAttribute('href') || '';

        const hit = href && (p === href || p.endsWith(href) || p.startsWith(href + '/'));

        x.classList.toggle('active', !!hit);

        if (hit) matched = true;

      });

      if (!matched && others.length) others[0].classList.add('active');

    }

  }



  function open() {

    open_ = true;

    place();

    els.page.classList.remove('hidden');

    setActive(true);

    if (!els.injected) { document.body.appendChild(els.page); els.injected = true; place(); }

    if (!uiState) els.body.innerHTML = '<div class="wfai-empty">正在连接本地服务…</div>';

    refresh(true);

  }



  function close() {

    open_ = false;

    els.page.classList.add('hidden');

    setActive(false);

  }



  // --------------------------------------------------------------- self-heal

  function ensureNav() {

    const nav = document.querySelector('aside.sidebar nav.nav-menu');

    if (!nav) return;

    if (nav.querySelector('.wfai-nav')) return;

    const last = nav.querySelectorAll('.nav-item');

    const item = navItem();

    if (last.length) last[last.length - 1].after(item);

    else nav.appendChild(item);

    if (open_) setActive(true);

  }



  function watchNav() {

    const nav = document.querySelector('aside.sidebar nav.nav-menu');

    if (!nav) { setTimeout(watchNav, 600); return; }

    const mo = new MutationObserver(() => { if (!nav.querySelector('.wfai-nav')) ensureNav(); });

    mo.observe(nav, { childList: true });

    // clicking any other nav row leaves our page

    nav.addEventListener('click', (e) => {

      const a = e.target.closest('a.nav-item');

      if (a && !a.classList.contains('wfai-nav') && open_) close();

    }, true);

    // route changes via history API

    for (const m of ['pushState', 'replaceState']) {

      const orig = history[m];

      history[m] = function () { const r = orig.apply(this, arguments); if (open_) close(); return r; };

    }

    window.addEventListener('popstate', () => { if (open_) close(); });

    window.addEventListener('resize', () => { if (open_) place(); });



    // 隐藏「匿名数据收集」开关：页面切换会重建 DOM，所以挂个观察器持续藏

    hideTelemetryToggle();

    let hideTimer = null;

    try {

      const mo2 = new MutationObserver(() => {

        clearTimeout(hideTimer);

        hideTimer = setTimeout(hideTelemetryToggle, 300);

      });

      mo2.observe(document.body, { childList: true, subtree: true });

    } catch (_) {}

    setInterval(hideTelemetryToggle, 4000);

  }



  // ---------------------------------------------------------------------- init

  function init() {

    const style = document.createElement('style');

    style.id = 'wfai-style';

    style.textContent = CSS;

    document.head.appendChild(style);



    els.toast = h('<div id="wfai-toast"></div>');

    document.body.appendChild(els.toast);



    els.page = buildPage();

    els.body = els.page.querySelector('#wfai-body');

    els.injected = false;

    wire();



    ensureNav();

    watchNav();

    // 新机器/新配置：Bot 的 WeFlow token 是空的，几秒后自动从 WeFlow 配置服务里取
    setTimeout(() => { try { adoptWeFlowEndpoint(); } catch (_) {} }, 5000);



    // 轮询：面板打开时 4 秒一次（原来是 2 秒，重绘太频繁，鼠标悬停会一直闪）
    // 鼠标停在面板里、或者在某个输入框里打字时，跳过这次重绘，避免打断操作
    let hovering = false;
    try {
      document.addEventListener('mouseover', (e) => {
        hovering = !!(els.page && els.page.contains(e.target));
      }, true);
    } catch (_) {}
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        const b = document.querySelector('#wfai-save-top');
        if (b) b.click();
      }
    });
    pollTimer = setInterval(() => {
      try {
        if (hovering) return;
        const act = document.activeElement;
        if (act && els.page && els.page.contains(act) && /INPUT|TEXTAREA|SELECT/.test(act.tagName)) return;
      } catch (_) {}
      refresh(false);
    }, open_ ? 4000 : 12000);

    refresh(false);



    window.__WFAI_UI__ = {

    build: WFAI_BUILD,

    destroy() {

      try { if (pollTimer) clearInterval(pollTimer); } catch (_) {}

      try { document.querySelectorAll('#wfai-page, #wfai-nav-row, #wfai-style, #wfai-toast').forEach((n) => n.remove()); } catch (_) {}

    },

      reopen: () => { ensureNav(); },

      close,

      open,

      goto: (t) => {

        open();

        tab = t || 'overview';

        els.page.querySelectorAll('.wfai-tab').forEach((x) => x.classList.toggle('act', x.dataset.tab === tab));

        renderBody();          // 同步渲染，避免和 open() 里的异步 refresh 抢

        refresh(true);

        return tab;

      },

    };

    console.log('[wfai] panel ready on port', BOOT.port);

  }



  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);

  else init();

})();


