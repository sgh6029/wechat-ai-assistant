/*
 * WeFlow "Bot" integration - main-process sidecar.
 *
 * Loaded by a single bootstrap line appended to dist-electron/main-CYwVc7t8.js.
 * Lives OUTSIDE app.asar at <install>/resources/wfai/hook.js so it can be edited
 * without touching the archive again.
 *
 * Responsibilities
 *   1. subscribe to WeFlow's own push stream (SSE) and turn pushes into replies
 *   2. call the AI provider (OpenAI-compatible or Ollama)
 *   3. deliver replies to the WeChat desktop window (opt-in, dry-run by default)
 *   4. serve a tiny localhost HTTP API that the injected renderer panel talks to
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const TAG = '[wfai]';
const WFAI_DIR = path.join(process.resourcesPath, 'wfai');
const UI_FILE = path.join(WFAI_DIR, 'ui.js');
const SEND_PS1 = path.join(WFAI_DIR, 'send.ps1');

// ---------------------------------------------------------------------------
// tiny utils
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function log(level, msg) {
  const line = `${nowIso()} [${level}] ${msg}`;
  S.logs.push({ ts: Date.now(), level, msg });
  if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);
  try {
    if (!S.logFile) {
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      fs.mkdirSync(PATHS.logs, { recursive: true });
      S.logFile = path.join(PATHS.logs, `wfai-${stamp}.log`);
    }
    fs.appendFileSync(S.logFile, line + '\n');
  } catch (_) { /* logging must never throw */ }
  if (level === 'error') console.error(TAG, msg);
}

const S = {
  logs: [],
  logFile: null,
  messages: [],
  stats: { received: 0, replied: 0, sent: 0, dryrun: 0, filtered: 0, errors: 0 },
  conn: { connected: false, since: null, lastEventAt: null, lastPingAt: null, attempts: 0, lastError: null },
  buffers: new Map(),
  history: new Map(),
  recent: new Map(),
  events: [],
  triggerStats: { keyword: 0, mention: 0, webhookOk: 0, webhookFail: 0 },
  toolStats: { calls: 0, ok: 0, fail: 0 },
  archive: { running: false, lastRun: 0, lastStats: null, cursors: {}, totalRows: 0, error: null, dir: '' },
  cooldown: new Map(),
  active: new Map(),           // sessionId -> { until, remaining, used, startedAt }
  stickerScan: { running: false, done: 0, total: 0, error: null, startedAt: 0 },
  attach: new Map(),           // sessionId -> [文件]，必须按会话隔离，否则 A 的文件会发到 B
  selfSent: [],                // 自己刚发出去的消息（用来丢掉回声）
  sseGen: 0,                   // SSE 连接代际，防止旧连接的回调乱排重连
  lastAiMeta: new Map(),      // sessionId -> { citations, searches, toolSearch }，按会话隔离
  ctx: new Map(),              // sessionId -> { text, tokens, compressed, lastAt }
  scheduleTimer: null,
  scheduleHistory: [],        // 最近的定时发送记录
  archiveTimer: null,
  archiveBootTimer: null,
  cfg: null,
  server: null,
  port: 0,
  apiToken: null,
  started: false,
  sse: null,
};

const PATHS = { cfgDir: null, cfgFile: null, logs: null, archive: null, workspace: null, out: null, lib: null, pluginDirs: [] };
const S_PLUGINS = { list: [], scannedAt: 0, lastError: null };

function pushMessage(rec) {
  S.messages.unshift(rec);
  if (S.messages.length > 300) S.messages.length = 300;
  return rec;
}

function ok(v) { return { ok: true, value: v }; }

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
function defaultConfig() {
  return {
    paths: { root: '' },        // 数据根目录；空 = <WeFlow>/resources/wfai/data
    auto_reply: false,
    dry_run: true,
    listen: true,               // 是否订阅 WeFlow 推送（独立于 auto_reply）
    weflow: { base_url: 'http://127.0.0.1:5031', access_token: '' },
    ai: {
      provider: 'custom',          // deepseek | dashscope | openai | ollama | custom
      native_search: false,        // 用服务商自带的联网搜索（DeepSeek / 阿里百炼）
      native_read_url: true,       // DeepSeek：顺带开启"阅读链接"
      search_priority: 'native',   // native=优先用服务商自带联网 | tools=优先用本地抓取工具
      search_strategy: 'agent',    // 百炼：turbo | max | agent
      type: 'openai',
      base_url: 'https://api.deepseek.com',
      api_key: '',
      model: 'deepseek-flash',
      ollama_url: 'http://127.0.0.1:11434/api/generate',
      ollama_model: 'qwen3.5:2b-q4_K_M',
      timeout: 40,
      temperature: 0.7,
    },
    buffer_seconds: 10,
    max_history: 6,
    // ---- 定时消息：到点自动发（内置调度，不依赖插件）----
    schedule: {
      enabled: true,
      tick_seconds: 30,            // 每多少秒检查一次
      rules: [],                   // 规则数组，见 addScheduleRule
    },
    // ---- 上下文预算：超了先压缩成摘要，再继续聊 ----
    context: {
      enabled: true,
      max_tokens: 200000,          // 200k / 500k / 1048576 都行
      compress_at: 0.75,           // 用到 75% 就开始压缩
      keep_recent: 20,             // 压缩时最近多少条原样保留
      summary_max_chars: 700,      // 摘要长度上限
      archive_compressed: true,    // 被压缩掉的原文写进归档
    },
    max_reply_chars: 120,
    system_prompt: '你是微信聊天助手。请用简短、自然、口语化的中文回复对方，不要使用书面语，不要加表情符号，不超过 50 字。',
    // ---- 会话过滤 ----
    filter: { drop_self: true, drop_other_emoji: true, emoji_mode: 'pure', mode: 'off', list: [], sync_weflow: true },   // mode: off | whitelist | blacklist
    send: { enabled: false, delay_ms: 350, search_down: 0, wechat_exe: 'Weixin.exe' },
    // ---- 定时归档：WeFlow 本地 API -> 本地 NDJSON，全程不出本机 ----
    archive: {
      enabled: false,
      interval_minutes: 30,
      scope: 'whitelist',          // whitelist | all
      limit_per_session: 200,
      max_sessions_per_run: 400,
      dir: '',
      default_max_records: 0,      // 未单独配置的会话：累计多少条后自动压缩打包（0=不自动）
      default_interval_hours: 0,   // 未单独配置的会话：多久归档一次（0=跟随主任务）
      rules: [],                   // 单聊/群聊单独归档：[{id, name, enabled, interval_hours, max_records}]
    },
    // ---- 出站推送目标：任意本地 webhook ----
    push: { url: '', headers: {}, timeout_ms: 12000 },
    // ---- 关键词被动监听：本地字符串/正则匹配，不调大模型 ----
    watch: {
      enabled: false,
      groups_only: true,
      keywords: [],
      regex: [],
      context_count: 10,
      cooldown_seconds: 120,
      also_ai: false,
      respect_filter: false,       // 默认不受 AI 名单限制（WeFlow 那份名单里没有群）
    },
    // ---- @ 触发：本地规则匹配 ----
    mention: {
      enabled: false,
      aliases: [],
      context_count: 10,
      action: 'both',              // webhook | ai | both
      respect_filter: false,
      cooldown_seconds: 0,         // 0 = 每次 @ 都回；想防刷屏再调大
      self_names: [],              // 额外把自己认成谁（默认用上面那些群昵称）
      poke_enabled: true,          // 被「拍一拍」也算被叫到
    },
    // ---- 文件访问权限（Agent / 插件用）----
    access: {
      mode: 'off',                 // off | readonly | readonly_all | workspace_rw | full
      workspace: '',
      max_read_kb: 512,
      max_write_mb: 32,
    },
    // ---- Agent（命令路由 + 模型自主选工具）----
    agent: {
      enabled: true,
      where: 'mention_dm',         // mention_dm | all   —— 在哪些场景接受 /命令
      send_files: true,
      max_files_per_reply: 3,
      plugin_timeout_seconds: 25,
      auto_tools: true,            // 让模型自己决定调用哪个插件/工具
      max_tool_rounds: 4,          // 最多来回几轮工具调用
    },
    // ---- 群聊专属（覆盖全局）----
    group: {
      buffer_seconds: 10,          // 群聊合并延迟（0 = 用全局）
      system_prompt: '',
      ignore_global_prompt: true,  // true=只用群聊这段；false=在全局提示词后面追加
      at_enabled: true,            // 被 @ 时是否响应
      keyword_enabled: false,      // 群里是否响应关键词（默认只认 @）
      auto_reply: false,           // 群里对普通消息是否也回（默认不回，防刷屏）
      per_group: false,            // false=所有群用上面这份全局；true=按下面的 rules 单独覆盖
      rules: [],                   // [{sessionId/contact, ...覆盖字段}]，没配的群继续用全局
      keywords: [],                // 群聊专属关键词（在全局之外追加）
      reply_mention: true,         // 回复时带上 @发言人
      max_replies_per_minute: 6,   // 同一个群每分钟最多回几条
      per_sender: true,            // 按发言人分别合并，多人同时找不互相顶掉
    },
    // ---- 被 @ 之后的「持续激活」窗口 ----
    active: {
      enabled: true,
      mode: 'count',               // count 按条数 | time 按时长 | both 先到先结束
      max_messages: 20,            // 激活期间最多再处理多少条消息
      minutes: 5,                  // 激活持续时间
      extend_on_mention: true,     // 激活中又被 @ 是否刷新窗口
      push_webhook: false,         // 激活期间每条消息是否也 POST 到 webhook
    },
    // ---- 图片 / 表情包 ----
    media: {
      enabled: true,               // 关掉 = 完全忽略图片/表情消息
      action: 'vision',            // vision=把图喂给视觉模型 | note=只告诉模型"发了图" | ack=固定回复 | ignore
      ack_text: '收到图片了，我看一下～',
    },
    // ---- 视觉模型（用来真正"看"图片）----
    vision: {
      enabled: true,
      base_url: '',                // 空 = 用主 AI 的 base_url
      api_key: '',                 // 空 = 用主 AI 的 api_key
      model: '',                   // 空 = 用主 AI 的 model（推荐单独填一个视觉模型）
      max_images: 4,
      max_kb: 4096,
    },
    // ---- 联网（搜索 / 抓网页）----
    web: {
      enabled: true,
      search_url: 'https://cn.bing.com/search?q={q}',
      search_json_path: '',        // 自定义 API：留空=按 HTML 解析；填 serper/ddg 等返回的数组字段名
      api_key: '',                 // 自定义 API 的 key（会作为 Authorization: Bearer 或 X-API-KEY 发送）
      api_header: 'Authorization',
      api_prefix: 'Bearer ',
      max_results: 6,
      fetch_limit_kb: 200,
      timeout_ms: 20000,
    },
    // ---- 本地表情包库 ----
    sticker: {
      enabled: false,
      dir: '',                     // 放图片/动图的文件夹
      pick: 'model',               // model=按文件名 | tagged=按视觉标记 | vision=视觉模型直接看图选 | random=随机
      max_per_reply: 1,
      send_as: 'auto',             // auto=静态图当图片发、动图当文件发 | image | file
    },
    // ---- 回复格式 ----
    reply: {
      strip_emoji: true,           // 禁止回复里出现 emoji
      at_person: true,             // 回复时是否 @ 对方
      tidy_punct: true,            // 整理标点（去 markdown、统一全半角）
      max_chars_group: 160,        // 群聊回复更短
    },
    // ---- 插件开关：id -> bool ----
    plugins: { disabled: [] },
  };
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function seedTokenFromStandalone() {
  // The standalone assistant keeps a working token; reuse it on first run.
  const candidates = [
    'C:\\Users\\Public\\wfai-seed.json',
    path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'weflow', 'wfai-seed.json'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        const j = JSON.parse(fs.readFileSync(c, 'utf8'));
        if (j.access_token) return j.access_token;
      }
    } catch (_) { /* ignore */ }
  }
  return '';
}

function loadConfig() {
  const def = defaultConfig();
  let cur = {};
  try {
    if (fs.existsSync(PATHS.cfgFile)) cur = JSON.parse(fs.readFileSync(PATHS.cfgFile, 'utf8'));
  } catch (e) {
    log('error', `读取配置失败: ${e.message}`);
    // 主文件坏了就退回上一次的备份，绝不能用默认值把用户的设置顶掉
    try {
      const bak = PATHS.cfgFile + '.bak';
      if (fs.existsSync(bak)) {
        cur = JSON.parse(fs.readFileSync(bak, 'utf8'));
        log('warn', '已从 config.json.bak 恢复配置');
        try { fs.copyFileSync(bak, PATHS.cfgFile); } catch (_) {}
      } else {
        log('warn', '没有 config.json.bak，只能先用默认配置');
      }
    } catch (e2) {
      log('error', `备份也读不出来: ${e2.message}`);
    }
  }
  const cfg = deepMerge(def, cur);
  if (!cfg.weflow.access_token) {
    const seed = seedTokenFromStandalone();
    if (seed) { cfg.weflow.access_token = seed; log('info', '已从独立版配置导入 access_token'); }
  }
  S.cfg = cfg;
  return cfg;
}
function saveConfig(patch) {
  // 关键：先把磁盘上的最新配置读出来合并，再用"原子替换"写回去。
  // 否则两个写入者（旧内存/另一个实例）会互相覆盖，表现就是"重启后设置全变回默认"。
  let disk = null;
  try {
    if (fs.existsSync(PATHS.cfgFile)) disk = JSON.parse(fs.readFileSync(PATHS.cfgFile, 'utf8'));
  } catch (_) { disk = null; }
  const base = disk ? deepMerge(defaultConfig(), disk) : (S.cfg || defaultConfig());
  S.cfg = deepMerge(base, patch || {});
  const tmp = PATHS.cfgFile + '.tmp';
  try {
    fs.mkdirSync(PATHS.cfgDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(S.cfg, null, 2), 'utf8');
    fs.renameSync(tmp, PATHS.cfgFile);
    try { fs.copyFileSync(PATHS.cfgFile, PATHS.cfgFile + '.bak'); } catch (_) {}
    log('info', '配置已保存');
  } catch (e) {
    log('error', `保存配置失败: ${e.message}`);
    throw e;
  }
  return S.cfg;
}

// ---------------------------------------------------------------------------
// HTTP helper (node http/https, no deps)
// ---------------------------------------------------------------------------
function requestJson(urlStr, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('无效 URL: ' + urlStr)); }
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const req = lib.request(
      { method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) }, timeout },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, text });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** 每次回复都把「现在几点、这是哪个会话、你能力边界」告诉模型 */
function environmentPrompt(opts) {
  const o = opts || {};
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${WEEKDAYS[d.getDay()]}）`;
  const lines = [
    '【环境信息】',
    `- 当前时间：${stamp}`,
    '- 你是运行在这台 Windows 电脑上的微信助手（WeFlow 里的 Bot），不是手机里的助手。',
  ];
  if (o.contact) lines.push(`- 当前会话：${o.isGroup ? `群聊「${o.contact}」` : `与「${o.contact}」的私聊`}`);
  if (o.isGroup) {
    const al = (S.cfg.mention && S.cfg.mention.aliases) || [];
    if (al.length) lines.push(`- 你在这个群里被叫做：${al.slice(0, 4).join(' / ')}（别人 @ 的就是这个名字）`);
  }
  lines.push('- 你能读到本机文件、能生成 PPT/Word 等文档、知道当前时间；但你看不到图片、表情包、语音的具体内容，只会收到「[某人发了一张图片]」这类提示。');
  // 服务商自带联网开着的时候，必须明确告诉模型它可以查，否则它会拒绝
  if (aiNativeSearchMode()) {
    lines.push('- 你**可以联网搜索**（搜索在服务端完成）。遇到新闻、天气、价格、赛事、汇率、软件版本这类实时信息，先搜再答，不要说"我无法联网"。');
  }
  lines.push('- 被问到现在几点、今天是几号、星期几时，直接用上面的时间回答，不要说你不知道，也不要让用户自己去看手机。');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 联网：搜索 + 抓网页（默认走本地 HTTP 请求，不依赖任何浏览器）
// ---------------------------------------------------------------------------
/** 从 OpenAI 兼容响应里取文字：content 空了就退到 reasoning_content */
function pickAnswerText(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    const m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return '';
    const c = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((x) => x.text || '').join('') : '');
    if (c && c.trim()) return c.trim();
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) {
      const nums = m.reasoning_content.trim().match(/\b(\d{1,2}|none)\b/i);
      return nums ? nums[0] : '';
    }
    return '';
  } catch (_) { return ''; }
}

function webCfg() {
  const w = S.cfg.web || {};
  return {
    enabled: w.enabled !== false,
    search_url: String(w.search_url || 'https://cn.bing.com/search?q={q}').trim(),
    json_path: String(w.search_json_path || '').trim(),
    api_key: String(w.api_key || '').trim(),
    api_header: String(w.api_header || 'Authorization').trim(),
    api_prefix: w.api_prefix === undefined ? 'Bearer ' : String(w.api_prefix),
    max_results: Math.max(1, Math.min(20, Number(w.max_results) || 6)),
    fetch_limit_kb: Math.max(20, Math.min(2048, Number(w.fetch_limit_kb) || 200)),
    timeout: Math.max(3000, Math.min(120000, Number(w.timeout_ms) || 20000)),
  };
}

function httpGetText(urlStr, { timeout = 20000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve({ ok: false, error: 'URL 不合法: ' + urlStr }); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
        path: u.pathname + (u.search || ''), method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          ...headers,
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          return resolve(httpGetText(next, { timeout, headers }));
        }
        const chunks = [];
        let size = 0;
        res.on('data', (d) => { size += d.length; if (size <= 4 * 1024 * 1024) chunks.push(d); });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(res.headers['content-type'] || '');
          const enc = (ct.match(/charset=([\w-]+)/i) || [])[1];
          let text;
          try {
            text = enc && !/utf-?8/i.test(enc)
              ? new (require('util').TextDecoder)(enc, { fatal: false }).decode(buf)
              : buf.toString('utf8');
          } catch (_) {
            text = buf.toString('utf8');
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, text, url: urlStr });
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.setTimeout(timeout, () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, error: '超时' }); });
    req.end();
  });
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function decodeBingUrl(href) {
  // bing 有时候给 /ck/a?...&u=a1<base64url>
  try {
    const m = String(href).match(/[?&]u=a1([^&]+)/);
    if (m) {
      let b = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b.length % 4) b += '=';
      return Buffer.from(b, 'base64').toString('utf8');
    }
  } catch (_) {}
  return href;
}

async function webSearch(query) {
  const w = webCfg();
  if (!w.enabled) return { ok: false, text: '联网功能已关闭（规则页 → 联网）' };
  const q = String(query || '').trim();
  if (!q) return { ok: false, text: '搜索词为空' };
  const url = w.search_url.replace(/\{q\}/g, encodeURIComponent(q));
  const headers = {};
  if (w.api_key) headers[w.api_header] = w.api_prefix + w.api_key;
  const r = await httpGetText(url, { timeout: w.timeout, headers });
  if (!r.ok) return { ok: false, text: '搜索失败：' + (r.error || 'HTTP ' + r.status) };

  const out = [];
  // ① 自定义 JSON API
  if (w.json_path || /^\s*[[{]/.test(r.text)) {
    try {
      const j = JSON.parse(r.text);
      let arr = null;
      if (w.json_path) {
        arr = w.json_path.split('.').reduce((o, k) => (o == null ? o : o[k]), j);
      }
      if (!Array.isArray(arr)) {
        for (const k of ['organic_results', 'results', 'data', 'items', 'webPages.value', 'web']) {
          const v = k.split('.').reduce((o, kk) => (o == null ? o : o[kk]), j);
          if (Array.isArray(v)) { arr = v; break; }
        }
      }
      if (Array.isArray(arr)) {
        for (const it of arr.slice(0, w.max_results)) {
          const title = it.title || it.name || it.heading || '';
          const link = it.link || it.url || it.href || '';
          const snip = it.snippet || it.description || it.body || it.content || '';
          if (link) out.push({ title: htmlToText(title).slice(0, 120), url: link, snippet: htmlToText(snip).slice(0, 300) });
        }
      }
    } catch (_) {}
  }
  // ② Bing/Google 之类 HTML
  if (!out.length) {
    const re = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(r.text)) && out.length < w.max_results) {
      const link = decodeBingUrl(m[1]);
      const title = htmlToText(m[2]);
      if (!title || /^(图片|视频|地图|更多|网页|资讯)/.test(title)) continue;
      out.push({ title: title.slice(0, 120), url: link, snippet: '' });
    }
    // 抓摘要：b_caption
    if (out.length) {
      const caps = [];
      const cre = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
      let cm;
      while ((cm = cre.exec(r.text)) && caps.length < out.length) caps.push(htmlToText(cm[1]).slice(0, 300));
      out.forEach((o, i) => { if (caps[i]) o.snippet = caps[i]; });
    }
  }
  if (!out.length) {
    const plain = htmlToText(r.text).slice(0, 600);
    return { ok: false, text: `没解析出搜索结果。原始返回片段：${plain}` };
  }
  const text = out.map((o, i) => `${i + 1}. ${o.title}\n   ${o.url}${o.snippet ? '\n   ' + o.snippet : ''}`).join('\n');
  log('info', `联网搜索「${q}」→ ${out.length} 条`);
  return { ok: true, text: `搜索「${q}」结果：\n${text}`, results: out };
}

async function webFetch(url, limitKb) {
  const w = webCfg();
  if (!w.enabled) return { ok: false, text: '联网功能已关闭' };
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { ok: false, text: '只支持 http/https 链接' };
  const r = await httpGetText(u, { timeout: w.timeout });
  if (!r.ok) return { ok: false, text: '抓取失败：' + (r.error || 'HTTP ' + r.status) };
  const limit = Math.min(2048, limitKb || w.fetch_limit_kb) * 1024;
  const isJson = /^\s*[[{]/.test(r.text);
  const body = isJson ? r.text.slice(0, limit) : htmlToText(r.text).slice(0, limit);
  const title = (r.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  log('info', `联网抓取 ${u} → ${Math.round(body.length / 1024)}KB`);
  return { ok: true, text: `${title ? '标题：' + htmlToText(title) + '\n' : ''}正文（已截断到 ${Math.round(limit / 1024)}KB）：\n${body}` };
}

// ---------------------------------------------------------------------------
// 视觉：把 WeFlow 解出来的图片真正喂给模型
// ---------------------------------------------------------------------------
function visionCfg() {
  const v = S.cfg.vision || {};
  const ai = S.cfg.ai || {};
  return {
    enabled: v.enabled !== false,
    base_url: String(v.base_url || ai.base_url || '').trim(),
    api_key: String(v.api_key || ai.api_key || '').trim(),
    model: String(v.model || ai.model || '').trim(),
    max_images: Math.max(1, Math.min(20, Number(v.max_images) || 4)),
    max_kb: Math.max(256, Number(v.max_kb) || 4096),
  };
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };

/**
 * 从 WeFlow 本地接口把「最近一张图片/表情」导出成真实文件。
 * 推送里只有 [图片] 文本，但 /api/v1/messages?media=1 会返回 mediaLocalPath。
 */
async function findRecentImages(sessionId, withinSeconds = 900, limit = 4, sinceTs = 0) {
  // 微信图片是懒解密：第一把常常还拿不到 mediaLocalPath，等一两秒再试
  for (let attempt = 1; attempt <= 3; attempt++) {
    const got = await findRecentImageOnce(sessionId, withinSeconds, attempt, limit, sinceTs);
    if (got && got.length) return got;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}

async function findRecentImage(sessionId, withinSeconds = 900) {
  const list = await findRecentImages(sessionId, withinSeconds, 1);
  return list.length ? list[0] : null;
}

async function findRecentImageOnce(sessionId, withinSeconds, attempt, limit = 4, sinceTs = 0) {
  try {
    const want = Math.max(1, Math.min(20, limit));
    const r = await wfGet(`/api/v1/messages?talker=${encodeURIComponent(sessionId)}&limit=${Math.max(12, want * 3)}&media=1`);
    const list = (r.messages || []).filter((m) => m && m.mediaLocalPath);
    if (!list.length) {
      log('info', `第 ${attempt} 次取图：这个会话最近没有可导出的图片（可能还没解密出来）`);
      return [];
    }
    const picked = [];
    const now = Math.floor(Date.now() / 1000);
    for (const m of list) {
      const ts = Number(m.createTime || 0);
      if (sinceTs && ts && ts < sinceTs) continue;
      if (withinSeconds > 0 && ts && now - ts > withinSeconds) {
        log('info', `第 ${attempt} 次取图：最近的图片是 ${now - ts} 秒前的，超出 ${withinSeconds} 秒窗口`);
        continue;
      }
      const ext = path.extname(m.mediaLocalPath).toLowerCase();
      if (!MIME_BY_EXT[ext]) continue;
      let size = 0;
      try { size = fs.statSync(m.mediaLocalPath).size; } catch (_) { continue; }

      picked.push({ path: m.mediaLocalPath, mime: MIME_BY_EXT[ext], size, ts, localType: m.localType });
      if (picked.length >= want) break;
    }
    if (picked.length) log('info', `取到 ${picked.length} 张图（第 ${attempt} 次尝试）`);
    return picked;
  } catch (e) {
    log('warn', '取图片失败：' + e.message);
  }
  return [];
}

/** 调视觉模型：图片 + 文字一起发 */
const RESIZE_PS1 = path.join(WFAI_DIR, 'tools', 'resize-image.ps1');

/** 大图先缩成 JPEG（视觉模型不需要原图，还能省 token） */
function shrinkImage(file, mime) {
  return new Promise((resolve) => {
    if (!fs.existsSync(RESIZE_PS1)) return resolve({ path: file, mime });
    const out = path.join(require('os').tmpdir(), `wfai-vision-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
    let ps;
    try {
      ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', RESIZE_PS1, '-In', file, '-Out', out, '-Max', '1280'], { windowsHide: true });
    } catch (_) { return resolve({ path: file, mime }); }
    let outTxt = '';
    ps.stdout.on('data', (d) => { outTxt += d.toString(); });
    ps.stderr.on('data', (d) => { outTxt += d.toString(); });
    const timer = setTimeout(() => { try { ps.kill(); } catch (_) {} resolve({ path: file, mime }); }, 25000);
    ps.on('close', () => {
      clearTimeout(timer);
      if (/^OK/m.test(outTxt.trim()) && fs.existsSync(out)) {
        log('info', `大图已缩放：${outTxt.trim().replace(/^OK\s*/, '')}`);
        return resolve({ path: out, mime: 'image/jpeg' });
      }
      log('warn', '缩放失败，改用原图：' + outTxt.trim().slice(0, 120));
      resolve({ path: file, mime });
    });
    ps.on('error', () => resolve({ path: file, mime }));
  });
}

async function aiVision(systemPrompt, history, userText, images, sessionIdHint) {
  if (sessionIdHint) S._aiSession = sessionIdHint;
  const v = visionCfg();
  if (!v.enabled || !v.base_url || !v.model) throw new Error('未配置视觉模型');
  const base = v.base_url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const content = [{ type: 'text', text: userText || '看看这张图，简单说说你看到了什么。' }];
  for (const img of images.slice(0, v.max_images)) {
    const b64 = fs.readFileSync(img.path).toString('base64');
    content.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${b64}` } });
  }
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content });
  const r = await requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.api_key}` },
    body: { model: v.model, messages, max_tokens: 800, temperature: 0.7, stream: false },
    timeout: Math.max(30, Number(S.cfg.ai.timeout) || 40) * 1000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`视觉模型 HTTP ${r.status}: ${r.text.slice(0, 240)}`);
  const out = pickAnswerText(r.text);
  if (!out) throw new Error('视觉模型返回了空内容（可能这个模型不支持图片，或 max_tokens 被推理吃光了）');
  return out;
}

// ---------------------------------------------------------------------------
// 本地表情包库
// ---------------------------------------------------------------------------
const STICKER_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function stickerDir() {
  const d = (S.cfg.sticker && S.cfg.sticker.dir) || path.join(PATHS.cfgDir, 'stickers');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

// 表情包列表缓存：目录内文件有增删（mtime 变了）才重新 readdir，
// 避免每按一次按钮、每回一次消息都去扫一遍磁盘
const _stCache = { dir: '', mtime: 0, names: [], total: 0 };
function listStickers(max = 400) {
  const dir = stickerDir();
  let mt = 0;
  try { mt = fs.statSync(dir).mtimeMs; } catch (_) {}
  if (_stCache.dir === dir && _stCache.mtime === mt && _stCache.names.length) {
    return { dir, names: _stCache.names.slice(0, max), total: _stCache.total, cached: true };
  }
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && STICKER_EXT.has(path.extname(d.name).toLowerCase()))
      .map((d) => d.name)
      .sort();
  } catch (_) {}
  _stCache.dir = dir;
  _stCache.mtime = mt;
  _stCache.names = names;
  _stCache.total = names.length;
  return { dir, names: names.slice(0, max), total: names.length };
}

// ---------------------------------------------------------------------------
// 表情包视觉标记：让视觉模型给每张图打上「内容 / 情绪 / 适用场景」
// ---------------------------------------------------------------------------
function stickerIndexPath() { return path.join(stickerDir(), '_index.json'); }

function loadStickerIndex() {
  try {
    const p = stickerIndexPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return {};
}

function saveStickerIndex(idx) {
  try { fs.writeFileSync(stickerIndexPath(), JSON.stringify(idx, null, 1), 'utf8'); } catch (_) {}
}

const TAG_PROMPT = '你是表情包标注助手。看这张表情包，用极简中文标注，严格只输出一行 JSON，不要代码块、不要解释：\n{"what":"画面内容≤12字","mood":"情绪≤6字","when":"适合在什么情况下发≤24字"}';

function parseTagJson(txt) {
  const s = String(txt || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      return {
        what: String(j.what || '').slice(0, 40),
        mood: String(j.mood || '').slice(0, 20),
        when: String(j.when || '').slice(0, 80),
      };
    } catch (_) {}
  }
  return { what: s.slice(0, 40), mood: '', when: '' };
}

/** 扫描图库：逐张丢给视觉模型打标签（后台跑，进度写在 S.stickerScan） */
async function scanStickers(force) {
  if (S.stickerScan.running) return { skipped: 'running' };
  const { dir, names } = listStickers(2000);
  const idx = loadStickerIndex();
  const todo = names.filter((n) => force || !idx[n]);
  S.stickerScan = { running: true, done: 0, total: todo.length, error: null, startedAt: Date.now() };
  log('info', `开始扫描表情包图库：${todo.length} 张待标记（共 ${names.length} 张）`);
  (async () => {
    const v = visionCfg();
    for (const name of todo) {
      try {
        const file = path.join(dir, name);
        let use = { path: file, mime: MIME_BY_EXT[path.extname(name).toLowerCase()] || 'image/png' };
        try {
          if (fs.statSync(file).size > 1024 * 1024) use = await shrinkImage(file, use.mime);
        } catch (_) {}
        const txt = await aiVision('你是表情包标注助手，只输出 JSON。', [], TAG_PROMPT, [use]);
        const tag = parseTagJson(txt);
        idx[name] = { ...tag, model: v.model, ts: Date.now() };
        saveStickerIndex(idx);
        S.stickerScan.done++;
        log('info', `标注 ${name}：${tag.what} / ${tag.mood} / ${tag.when}`);
      } catch (e) {
        S.stickerScan.error = e.message;
        log('warn', `标注失败 ${name}：${e.message}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    S.stickerScan.running = false;
    log('info', `图库扫描结束：成功 ${S.stickerScan.done}/${S.stickerScan.total}${S.stickerScan.error ? '，中断原因：' + S.stickerScan.error : ''}`);
  })();
  return { started: true, total: todo.length };
}

/** 视觉直选：把（缩小后的）图一次性发给视觉模型，让它看图挑 */
async function pickStickerByVision(replyText, names, dir) {
  const v = visionCfg();
  const MAX = 30;
  const picked = names.slice(0, MAX);
  if (!picked.length) return null;
  const content = [{
    type: 'text',
    text: `我刚发出去的回复是：「${String(replyText).slice(0, 220)}」\n下面按顺序给了 ${picked.length} 张表情包。请挑一张最贴切气氛的，只回答它的序号（一个数字），都不合适就回答 none。\n${picked.map((n, i) => `${i + 1}. ${n}`).join('\n')}`,
  }];
  for (const n of picked) {
    const file = path.join(dir, n);
    let use = { path: file, mime: MIME_BY_EXT[path.extname(n).toLowerCase()] || 'image/png' };
    try {
      if (fs.statSync(file).size > 400 * 1024) use = await shrinkImage(file, use.mime);
    } catch (_) {}
    let b64;
    try { b64 = fs.readFileSync(use.path).toString('base64'); } catch (_) { continue; }
    if (b64.length > 6 * 1024 * 1024) continue;
    content.push({ type: 'image_url', image_url: { url: `data:${use.mime};base64,${b64}` } });
  }
  if (content.length < 2) return null;
  const base = v.base_url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const body = {
    model: v.model,
    messages: [
      { role: 'system', content: '你是微信表情包选择器，看图片挑最合适的一张。只输出序号或 none。' },
      { role: 'user', content },
    ],
    max_tokens: 600,
    temperature: 0.4,
    stream: false,
  };
  let r = await requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.api_key}` },
    body,
    timeout: Math.max(40, Number(S.cfg.ai.timeout) || 40) * 1000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`视觉选图 HTTP ${r.status}: ${r.text.slice(0, 160)}`);
  let txt = pickAnswerText(r.text);
  if (!txt) {
    // 推理模型偶尔把 token 全用在思考上，再来一次
    r = await requestJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.api_key}` },
      body,
      timeout: Math.max(40, Number(S.cfg.ai.timeout) || 40) * 1000,
    });
    txt = pickAnswerText(r.text);
  }
  log('info', `视觉直选，模型回答「${txt.slice(0, 40)}」（共发了 ${content.length - 1} 张图）`);
  // ① 直接命中文件名
  const byName = picked.find((n) => txt.includes(n));
  if (byName) { log('info', `视觉直选命中文件名：${byName}`); return path.join(dir, byName); }
  // ② 序号
  const mm = txt.match(/(\d+)/);
  if (mm) {
    const i = Number(mm[1]) - 1;
    if (i >= 0 && i < picked.length) {
      log('info', `视觉直选了第 ${i + 1} 张：${picked[i]}`);
      return path.join(dir, picked[i]);
    }
  }
  log('warn', `视觉直选没解析出来（「${txt.slice(0, 30)}」），改成逐张打分`);
  return await pickStickerByScoring(replyText, picked, dir);
}

/** 一把多图不行时的退路：一张一张问"适不适合这个场景"，取最高分 */
async function pickStickerByScoring(replyText, names, dir) {
  const v = visionCfg();
  const base = v.base_url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  let best = null;
  let bestScore = 0;
  for (const n of names.slice(0, 20)) {
    try {
      const file = path.join(dir, n);
      let use = { path: file, mime: MIME_BY_EXT[path.extname(n).toLowerCase()] || 'image/png' };
      let size = 0;
      try { size = fs.statSync(file).size; } catch (_) { continue; }
      if (size > 400 * 1024) use = await shrinkImage(file, use.mime);
      const b64 = fs.readFileSync(use.path).toString('base64');
      if (b64.length > 6 * 1024 * 1024) continue;
      const r = await requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${v.api_key}` },
        body: {
          model: v.model,
          messages: [
            { role: 'system', content: '你是表情包匹配打分器。只输出一个 0-10 的整数，不要解释。' },
            {
              role: 'user',
              content: [
                { type: 'text', text: `我刚发的回复是：「${String(replyText).slice(0, 200)}」。这张表情包适合用来接这句话吗？0=完全不搭，10=非常搭。只回数字。` },
                { type: 'image_url', image_url: { url: `data:${use.mime};base64,${b64}` } },
              ],
            },
          ],
          max_tokens: 400,
          temperature: 0.2,
          stream: false,
        },
        timeout: Math.max(30, Number(S.cfg.ai.timeout) || 40) * 1000,
      });
      if (r.status < 200 || r.status >= 300) continue;
      const ans = pickAnswerText(r.text);
      const m = ans.match(/(\d+(?:\.\d+)?)/);
      const score = m ? Number(m[1]) : 0;
      log('info', `打分 ${n} = ${score}（「${ans.slice(0, 12)}」）`);
      if (score > bestScore) { bestScore = score; best = n; }
    } catch (e) {
      log('warn', `打分失败 ${n}：${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (best && bestScore >= 4) {
    log('info', `逐张打分选中 ${best}（${bestScore} 分）`);
    return path.join(dir, best);
  }
  log('info', `逐张打分最高只有 ${bestScore} 分，不发表情包`);
  return null;
}

async function pickSticker(replyText) {
  const st = S.cfg.sticker || {};
  if (st.enabled !== true) return null;
  const { dir, names, total } = listStickers();
  if (!names.length) return null;
  // 视觉直选：把图直接给模型看
  if (st.pick === 'vision' && visionCfg().enabled) {
    try {
      const hit = await pickStickerByVision(replyText, names, dir);
      if (hit) return hit;
      log('info', '视觉直选没结果，退回按标记/文件名挑');
    } catch (e) {
      log('warn', '视觉直选失败，退回按标记挑：' + e.message);
    }
  }
  if (st.pick === 'random') {
    return path.join(dir, names[Math.floor(Math.random() * names.length)]);
  }
  try {
    const idx = loadStickerIndex();
    const useTags = st.pick === 'tagged' || st.pick === 'vision' || Object.keys(idx).length > 0;
    const describe = (n) => {
      const g = idx[n];
      if (!useTags || !g) return n;
      return `${n} — ${g.what || ''}${g.mood ? ' / ' + g.mood : ''}${g.when ? ' / 适合：' + g.when : ''}`;
    };
    const sys = '你是微信表情包选择器。给定一条刚发出的回复和一堆表情包（含内容与适用场景），挑一个最贴切气氛的。只输出文件名本身，不要解释，不要加引号。如果都不合适就输出 none。';
    const user = `回复内容：${replyText}\n\n可选表情包：\n${names.slice(0, 120).map(describe).join('\n')}`;
    const pick = await aiReply(sys, [], user);
    const raw = String(pick || '').trim().split('\n')[0].trim().replace(/^["'「『]+|["'」』。！!]+$/g, '');
    if (!raw || raw.toLowerCase() === 'none') return null;
    // 先精确，再"文件名（去扩展名）出现在模型回答里"，最后反过来
    let hit = names.find((n) => n === raw);
    if (!hit) hit = names.find((n) => n.toLowerCase() === raw.toLowerCase());
    if (!hit) hit = names.find((n) => raw.includes(n) || raw.includes(n.replace(/\.[^.]+$/, '')));
    if (!hit) hit = names.find((n) => n.replace(/\.[^.]+$/, '').includes(raw));
    if (hit) return path.join(dir, hit);
    log('warn', `表情包没选出来（模型回：${raw.slice(0, 40)}）`);
  } catch (e) {
    log('warn', '表情包挑选失败：' + e.message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 云端服务商适配：DeepSeek 官方 / 阿里云百炼（DashScope）/ OpenAI 兼容
//   参考 https://api-docs.deepseek.com/zh-cn/guides/web_tools/
//        https://help.aliyun.com/zh/model-studio/web-search
// ---------------------------------------------------------------------------
const AI_PRESETS = {
  deepseek: { label: 'DeepSeek 官方', base_url: 'https://api.deepseek.com', model: 'deepseek-flash', native: 'deepseek-tools' },
  dashscope: { label: '阿里云百炼 DashScope', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', native: 'dashscope-param' },
  openai: { label: 'OpenAI 兼容', base_url: 'https://api.openai.com/v1', model: 'gpt-4o-mini', native: null },
  ollama: { label: 'Ollama 本地', base_url: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', native: null },
  custom: { label: '自定义', base_url: '', model: '', native: null },
};

/** 当前该用哪种"服务商自带联网"；null = 不支持 / 没开 */
function aiNativeSearchMode() {
  const ai = S.cfg.ai || {};
  if (!ai.native_search) return null;
  if (ai.type === 'ollama') return null;
  const p = String(ai.provider || '').toLowerCase();
  if (AI_PRESETS[p] && AI_PRESETS[p].native) return AI_PRESETS[p].native;
  // 没选服务商就按 base_url 猜
  const b = String(ai.base_url || '');
  if (/api\.deepseek\.com/i.test(b)) return 'deepseek-tools';
  if (/dashscope|aliyuncs/i.test(b)) return 'dashscope-param';
  return null;
}

/** 这条消息是不是更需要本地工具（做文档、读文件），而不是联网 */
function needsLocalTools(text) {
  return /(PPT|ppt|演示文稿|幻灯片|Word|word|文档|纪要|总结(聊天|一下)?记录|表格|Excel|excel|生成|做个|做一个|文件|发我|发给我|目录|文件夹|列出|读一下|打开)/.test(String(text || ''));
}

/** 把"深度思考"参数塞进请求体；返回实际生效的开关 */
function applyThinking(body) {
  const ai = S.cfg.ai || {};
  const mode = String(ai.thinking || 'auto').toLowerCase();
  const effort = String(ai.reasoning_effort || '').toLowerCase();
  const provider = String(ai.provider || '').toLowerCase();
  const base = String(ai.base_url || '');
  const isDeepSeek = provider === 'deepseek' || /api\.deepseek\.com/i.test(base);
  const isDashScope = provider === 'dashscope' || /dashscope|aliyuncs/i.test(base);

  if (isDeepSeek) {
    if (mode === 'on' || mode === 'off') body.thinking = { type: mode === 'on' ? 'enabled' : 'disabled' };
    if (effort) body.reasoning_effort = effort;
    // 思考模式不吃 temperature，传了也不生效
    if (mode === 'on') delete body.temperature;
    return mode === 'on' ? 'on' : (mode === 'off' ? 'off' : 'auto');
  }
  if (isDashScope) {
    if (mode === 'on' || mode === 'off') body.enable_thinking = mode === 'on';
    return mode === 'on' ? 'on' : (mode === 'off' ? 'off' : 'auto');
  }
  return 'auto';
}

/** 把原生联网参数塞进请求体 */
function applyNativeSearch(body) {
  const mode = aiNativeSearchMode();
  if (!mode) return null;
  const ai = S.cfg.ai || {};
  if (mode === 'deepseek-tools') {
    // 注意：DeepSeek 的服务端联网工具不能和普通 function tools 同时出现
    body.tools = [{ type: 'deepseek_web_search' }];
    if (ai.native_read_url !== false) body.tools.push({ type: 'deepseek_read_url' });
  } else if (mode === 'dashscope-param') {
    body.enable_search = true;
    const strat = String(ai.search_strategy || 'agent');
    body.search_options = { search_strategy: strat === 'turbo' || strat === 'max' ? strat : 'agent' };
  }
  return mode;
}

/** 从响应里抽引用/搜索痕迹 */
function extractNativeMeta(msg, usage) {
  const out = { citations: [], searches: [], toolSearch: 0 };
  try {
    for (const a of (msg && msg.annotations) || []) {
      const c = a && a.url_citation;
      if (c && c.url) out.citations.push({ url: c.url, title: c.title || '' });
    }
    for (const group of (msg && msg.server_tool_calls) || []) {
      for (const call of group.calls || []) {
        const act = call.action || {};
        if (act.type === 'search' || call.kind === 'search' || call.kind === 'deep_search') {
          out.searches.push({ queries: act.queries || [], sources: (call.sources || []).map((s) => ({ url: s.url, title: s.title })) });
        } else if (act.type === 'read_link' || call.kind === 'read_link') {
          out.searches.push({ queries: [], sources: [{ url: act.url || (call.page && call.page.url), title: (call.page && call.page.title) || '' }] });
        }
      }
    }
    if (usage && usage.server_tool_use) out.toolSearch = Number(usage.server_tool_use.tool_search || 0);
    // 去重
    const seen = new Set();
    out.citations = out.citations.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  } catch (_) {}
  return out;
}

async function aiReply(systemPrompt, history, userText, sessionIdHint) {
  if (sessionIdHint) S._aiSession = sessionIdHint;
  const ai = S.cfg.ai;
  if (ai.type === 'ollama') {
    const prompt = `${systemPrompt}\n\n${history.map((h) => h.role === 'assistant' ? `我: ${h.content}` : `对方: ${h.content}`).join('\n')}\n对方: ${userText}\n我:`;
    const r = await requestJson(ai.ollama_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { model: ai.ollama_model, prompt, stream: false }, timeout: ai.timeout * 1000 });
    if (r.status !== 200) throw new Error(`Ollama HTTP ${r.status}: ${r.text.slice(0, 200)}`);
    const j = JSON.parse(r.text);
    return String(j.response || '').trim();
  }
  const base = ai.base_url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const h of history) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: userText });
  const reqBody = { model: ai.model, messages, temperature: ai.temperature, max_tokens: 512, stream: false };
  const searchMode = applyNativeSearch(reqBody);
  if (searchMode) log('info', `已启用服务商自带联网（${searchMode}）`);
  const r = await requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.api_key}` },
    body: reqBody,
    timeout: ai.timeout * 1000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`AI HTTP ${r.status}: ${r.text.slice(0, 300)}`);
  const j = JSON.parse(r.text);
  const msg = j?.choices?.[0]?.message;
  const text = msg?.content;
  if (typeof text !== 'string') throw new Error('AI 返回格式异常: ' + r.text.slice(0, 200));
  const meta = extractNativeMeta(msg, j.usage);
  S.lastAiMeta.set(String(S._aiSession || ''), meta);
  try {
    const rt = j && j.usage && j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens;
    if (rt) { meta.reasoningTokens = Number(rt); log('info', `深度思考用了 ${rt} tokens（effort=${(S.cfg.ai || {}).reasoning_effort || '默认'}）`); }
  } catch (_) {}
  if (meta.citations.length) log('info', `联网回答带 ${meta.citations.length} 条引用：${meta.citations.slice(0, 3).map((c) => c.url).join(' ')}`);
  else if (meta.toolSearch) log('info', `联网搜索 ${meta.toolSearch} 次（无引用返回）`);
  return text.trim();
}

function aiReplyWithMeta(systemPrompt, history, userText) {
  S.lastAiMeta.set(String(S._aiSession || ''), { citations: [], searches: [], toolSearch: 0 });
  return aiReply(systemPrompt, history, userText).then((text) => ({ text, meta: S.lastAiMeta.get(String(S._aiSession || '')) || { citations: [], searches: [], toolSearch: 0 } }));
}

// ---------------------------------------------------------------------------
// WeChat delivery
// ---------------------------------------------------------------------------
// 所有往微信打字的动作都必须串行，否则多人同时 @ 会互相打架
let sendChain = Promise.resolve();
function enqueueSend(fn) {
  const next = sendChain.then(fn, fn);
  sendChain = next.then(() => {}, () => {});
  return next;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/gu;

/** 整理标点：去 markdown 残留、统一全角半角、压掉重复标点 */
function tidyPunct(input) {
  let t = String(input == null ? '' : input);

  t = t.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF\u00AD]/g, '');

  // 代码块 / 行内代码
  t = t.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (m, body) => body.trim());
  t = t.replace(/`([^`\n]+)`/g, '$1');

  // 标题 / 引用 / 分隔线
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
  t = t.replace(/^[ \t]*>[ \t]?/gm, '');
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');

  // 列表
  t = t.replace(/^[ \t]*(\d+)[.)][ \t]+(?=\S)/gm, '$1、');
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, '· ');

  // 表格：先删分隔行，再把数据行的竖线换成顿号
  t = t.replace(/^[ \t]*\|(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*\n?/gm, '');
  t = t.replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (m, row) => row.split('|').map((s) => s.trim()).filter(Boolean).join('、'));

  // 链接 / 图片
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 $2');
  t = t.replace(/\[([^\]]+)\]\((#[^)]*)\)/g, '$1');

  // 强调
  t = t.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  t = t.replace(/__([^_\n]+)__/g, '$1');
  t = t.replace(/~~([^~\n]+)~~/g, '$1');
  t = t.replace(/\*\*/g, '');
  t = t.replace(/(^|[\s\u4e00-\u9fff（(])[*_]([^*_\n]+)[*_](?=$|[\s\u4e00-\u9fff，。！？、）)])/g, '$1$2');

  // 省略号 / 破折号
  t = t.replace(/\.{3,}/g, '…');
  t = t.replace(/。{2,}/g, '。');
  t = t.replace(/~{2,}/g, '——');

  // 中文语境下的半角标点 -> 全角
  const C = '\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef\\u2103\\u2109\\u00b0';
  t = t.replace(new RegExp(`([${C}])[ \\t]*,[ \\t]*`, 'g'), '$1，');
  t = t.replace(new RegExp(`([${C}])[ \\t]*;[ \\t]*`, 'g'), '$1；');
  t = t.replace(new RegExp(`([${C}])[ \\t]*:[ \\t]*`, 'g'), '$1：');
  t = t.replace(new RegExp(`([${C}])[ \\t]*\\?`, 'g'), '$1？');
  t = t.replace(new RegExp(`([${C}])[ \\t]*!`, 'g'), '$1！');
  t = t.replace(new RegExp(`([${C}])\\.(?=[${C}]|$)`, 'g'), '$1。');

  // 标点堆叠
  t = t.replace(/[，、；：]+(?=[。！？])/g, '');
  t = t.replace(/([。！？])[，、；：]+/g, '$1');
  t = t.replace(/([，、])\1+/g, '$1');
  t = t.replace(/[。！？]+/g, (m) => m[m.length - 1]);
  t = t.replace(/([！？])。/g, '$1');

  // 引号统一
  t = t.replace(/"([^"\n]{1,60})"/g, '「$1」');
  t = t.replace(/“([^”\n]{1,60})”/g, '「$1」');

  // 空白
  t = t.replace(/[ \t\u00a0]+/g, ' ');
  t = t.replace(/([，。！？：；、）】」])[ \t]+/g, '$1');
  t = t.replace(/[ \t]+([，。！？：；、（【「])/g, '$1');
  t = t.replace(/[ \t]+$/gm, '');
  t = t.replace(/[ \t]*\n[ \t]*/g, '\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  // 收尾
  t = t.replace(/[，、；：]+$/g, '');
  return t.trim();
}

/** 去掉 emoji + 整理标点 */
function sanitizeReply(text) {
  let t = String(text == null ? '' : text);
  const rp = S.cfg.reply || {};
  if (rp.strip_emoji !== false) t = t.replace(EMOJI_RE, '');
  if (rp.tidy_punct !== false) {
    t = tidyPunct(t);
  } else {
    t = t.replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  }
  return t.trim();
}

const MEDIA_KINDS = ['图片', '表情', '动画表情', '视频', '语音', '位置', '名片', '小程序', '链接', '文件', '消息', '红包', '转账', '通话', '拍一拍'];
function classifyMedia(text) {
  const t = String(text || '').trim();
  if (!t.startsWith('[')) return null;
  const end = t.indexOf(']');
  if (end < 2 || end > 12) return null;
  const kind = t.slice(1, end);
  return MEDIA_KINDS.includes(kind) ? kind : null;
}

// 同一个群每分钟最多回几条，防刷屏
const groupRate = new Map();
/** 取某个群最终生效的群聊配置（全局 + 该群的单独覆盖） */
function groupCfgFor(sessionId) {
  const g = S.cfg.group || {};
  const base = { ...g };
  if (g.per_group !== true || !Array.isArray(g.rules) || !g.rules.length) return base;
  const hit = g.rules.find((r) => r && (
    (r.sessionId && String(r.sessionId) === String(sessionId)) ||
    (!r.sessionId && r.contact && String(r.contact) === String(sessionId))
  ));
  if (!hit) return base;
  const out = { ...base };
  for (const k of Object.keys(hit)) {
    if (k === 'sessionId' || k === 'contact' || k === 'name') continue;
    if (hit[k] === undefined || hit[k] === null || hit[k] === '') continue;
    if (typeof hit[k] === 'object' && !Array.isArray(hit[k])) out[k] = { ...(base[k] || {}), ...hit[k] };
    else out[k] = hit[k];
  }
  return out;
}

function groupRateOk(sessionId) {
  const g = groupCfgFor(sessionId);
  const cap = Math.max(1, Number(g.max_replies_per_minute) || 6);
  const now = Date.now();
  const arr = (groupRate.get(sessionId) || []).filter((x) => now - x < 60000);
  if (arr.length >= cap) { groupRate.set(sessionId, arr); return false; }
  arr.push(now);
  groupRate.set(sessionId, arr);
  return true;
}

// ---------------------------------------------------------------------------
// 被 @ 之后的「持续激活」窗口：一段时间 / 一定条数内，群里谁都算在对话里
// ---------------------------------------------------------------------------
function activeCfg() {
  return S.cfg.active || {};
}

function activateSession(sessionId, contact, why) {
  const a = activeCfg();
  if (a.enabled === false) return null;
  const prev = S.active.get(sessionId);
  if (prev && a.extend_on_mention === false) return prev;
  const entry = {
    sessionId,
    contact: contact || sessionId,
    until: Date.now() + Math.max(0, Number(a.minutes) || 0) * 60000,
    remaining: Math.max(0, Number(a.max_messages) || 0),
    used: 0,
    startedAt: Date.now(),
    why: why || 'mention',
  };
  S.active.set(sessionId, entry);
  const mode = a.mode || 'count';
  const parts = [];
  if (mode !== 'time') parts.push(`${entry.remaining} 条`);
  if (mode !== 'count') parts.push(`${Math.max(0, Number(a.minutes) || 0)} 分钟`);
  log('info', `【持续激活】${entry.contact} ${parts.join(' / ')}${prev ? '（已刷新）' : ''}`);
  return entry;
}

function activeState(sessionId) {
  const a = activeCfg();
  if (a.enabled === false) return null;
  const st = S.active.get(sessionId);
  if (!st) return null;
  const mode = a.mode || 'count';
  if (mode !== 'count' && Date.now() > st.until) {
    S.active.delete(sessionId);
    log('info', `【持续激活】${st.contact} 到期结束（共处理 ${st.used} 条）`);
    return null;
  }
  if (mode !== 'time' && st.remaining <= 0) {
    S.active.delete(sessionId);
    log('info', `【持续激活】${st.contact} 条数用完（共处理 ${st.used} 条）`);
    return null;
  }
  return st;
}

/** 消耗一条激活额度；返回是否仍在激活中 */
function consumeActivation(sessionId) {
  const st = activeState(sessionId);
  if (!st) return null;
  const a = activeCfg();
  const mode = a.mode || 'count';
  if (mode !== 'time') st.remaining = Math.max(0, st.remaining - 1);
  st.used += 1;
  return st;
}

function activeSnapshot() {
  const out = [];
  for (const [sid, st] of S.active) {
    const alive = activeState(sid);
    if (!alive) continue;
    out.push({
      sessionId: sid,
      contact: st.contact,
      remaining: st.remaining,
      used: st.used,
      until: st.until,
      startedAt: st.startedAt,
    });
  }
  return out;
}

function runSendScript(payload) {
  return new Promise((resolve) => {
    const tmp = path.join(require('os').tmpdir(), `wfai-send-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    } catch (e) {
      return resolve({ ok: false, detail: '写入发送负载失败: ' + e.message });
    }
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SEND_PS1, '-PayloadFile', tmp], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { ps.kill(); } catch (_) {} resolve({ ok: false, detail: '发送脚本超时' }); }, 40000);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('close', (code) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmp); } catch (_) {}
      const detail = (out + err).trim().slice(0, 600);
      resolve({ ok: code === 0 && /WFAI_SEND_OK/.test(out), detail });
    });
    ps.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, detail: e.message }); });
  });
}

function wechatSend(contact, text) {
  return enqueueSend(() => runSendScript({
    kind: 'text',
    contact,
    text,
    delay_ms: S.cfg.send.delay_ms,
    exe: S.cfg.send.wechat_exe,
    search_down: S.cfg.send.search_down || 0,
  }));
}

function wechatSendSticker(contact, filePath) {
  return enqueueSend(() => new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve({ ok: false, detail: '表情包不存在: ' + filePath });
    const ext = path.extname(filePath).toLowerCase();
    const sendAs = (S.cfg.sticker || {}).send_as || 'auto';
    resolve(runSendScript({
      kind: 'sticker',
      contact,
      file: filePath,
      send_as: sendAs === 'file' || (sendAs === 'auto' && ext === '.gif') ? 'file' : 'image',
      delay_ms: S.cfg.send.delay_ms,
      exe: S.cfg.send.wechat_exe,
      search_down: S.cfg.send.search_down || 0,
    }));
  }));
}

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function wechatSendFile(contact, filePath) {
  return enqueueSend(() => new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve({ ok: false, detail: '文件不存在: ' + filePath });
    const st = fs.statSync(filePath);
    if (!st.isFile()) return resolve({ ok: false, detail: '不是文件: ' + filePath });
    if (st.size > 100 * 1024 * 1024) return resolve({ ok: false, detail: '文件超过 100MB，微信可能拒绝' });
    // 图片走"发图片"而不是"发文件"，群里看着才像图
    const isImg = IMG_EXT_RE.test(filePath) && st.size <= 25 * 1024 * 1024;
    resolve(runSendScript({
      kind: isImg ? 'sticker' : 'file',
      contact,
      file: filePath,
      send_as: isImg ? 'image' : 'file',
      delay_ms: S.cfg.send.delay_ms,
      exe: S.cfg.send.wechat_exe,
      search_down: S.cfg.send.search_down || 0,
    }));
  }));
}

// ---------------------------------------------------------------------------
// message pipeline
// ---------------------------------------------------------------------------
function entryMatches(entry, sessionId, contact) {
  const v = String(entry || '').trim();
  if (!v) return false;
  const sid = String(sessionId || '');
  const name = String(contact || '');
  if (v === sid || v.toLowerCase() === sid.toLowerCase()) return true;
  if (name && (v === name || name.includes(v) || v.includes(name))) return true;
  return false;
}

function filterVerdict(sessionId, contact) {
  const f = S.cfg.filter;
  if (!f || f.mode === 'off' || !Array.isArray(f.list) || f.list.length === 0) return true;
  const hit = f.list.some((x) => entryMatches(x, sessionId, contact));
  return f.mode === 'whitelist' ? hit : !hit;
}

// ---------------------------------------------------------------------------
// 定时消息调度器
//   规则字段
//     id/name/enabled/contact/sessionId/isGroup
//     type: daily | weekly | monthly | once | interval
//     at: 'HH:MM'（daily/weekly/monthly 用）  days: [1..7]（weekly）  day: 1-31（monthly）
//     atISO: '2026-12-01T09:00:00'（once）     everyMinutes: N（interval）
//     mode: text | ai        text/prompt
//     atPerson: bool         在群里先 @ 对方
//     jitterSeconds: N       随机抖动，避免每天同一秒
//     catchUpMinutes: N      错过多久之内还补发（0 = 不补）
//     endAt: 时间戳          到期就不再生效
//     dryRun: bool           只记录不真发
// ---------------------------------------------------------------------------
function schedRules() {
  const s = S.cfg.schedule || {};
  if (!Array.isArray(s.rules)) s.rules = [];
  return s.rules;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 解析 'HH:MM' */
function parseHHMM(at) {
  const m = String(at || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { h: 9, m: 0 };
  return { h: Math.min(23, Number(m[1])), m: Math.min(59, Number(m[2])) };
}

/** 该规则"最近一次应该触发"的时间点（<= now），没有返回 0 */
function prevSlot(rule, now) {
  const d = new Date(now);
  const { h, m } = parseHHMM(rule.at);
  const t = rule.type || 'daily';

  if (t === 'once') {
    const at = Date.parse(rule.atISO || '');
    return Number.isFinite(at) && at <= now ? at : 0;
  }
  if (t === 'interval') {
    const every = Math.max(1, Number(rule.everyMinutes) || 60) * 60000;
    const base = Number(rule.lastRunAt) || Number(rule.createdAt) || now;
    if (!Number(rule.lastRunAt)) return now;   // 第一次：立刻按周期起点算
    return base + every <= now ? base + every : 0;
  }

  // daily / weekly / monthly：从今天往回找最近一个匹配的时间点
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  if (t === 'daily') {
    return base.getTime() <= now ? base.getTime() : base.getTime() - 86400000;
  }
  if (t === 'weekly') {
    const days = (Array.isArray(rule.days) && rule.days.length ? rule.days : [1]).map(Number);
    for (let back = 0; back <= 8; back++) {
      const cand = new Date(base.getTime() - back * 86400000);
      const wd = cand.getDay() === 0 ? 7 : cand.getDay();
      if (days.includes(wd) && cand.getTime() <= now) return cand.getTime();
    }
    return 0;
  }
  if (t === 'monthly') {
    const want = Math.max(1, Math.min(31, Number(rule.day) || 1));
    for (let back = 0; back <= 40; back++) {
      const cand = new Date(base.getTime() - back * 86400000);
      if (cand.getDate() === want && cand.getTime() <= now) return cand.getTime();
    }
    return 0;
  }
  return 0;
}

/** 下一次将在什么时候触发（只用于展示） */
function nextSlot(rule, now) {
  const t = rule.type || 'daily';
  const { h, m } = parseHHMM(rule.at);
  if (t === 'once') {
    const at = Date.parse(rule.atISO || '');
    return Number.isFinite(at) && at > now ? at : 0;
  }
  if (t === 'interval') {
    const every = Math.max(1, Number(rule.everyMinutes) || 60) * 60000;
    const base = Number(rule.lastRunAt) || Number(rule.createdAt) || now;
    return base + every;
  }
  const d = new Date(now);
  const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  if (t === 'daily') return base.getTime() > now ? base.getTime() : base.getTime() + 86400000;
  if (t === 'weekly') {
    const days = (Array.isArray(rule.days) && rule.days.length ? rule.days : [1]).map(Number);
    for (let k = 0; k <= 8; k++) {
      const cand = new Date(base.getTime() + k * 86400000);
      const wd = cand.getDay() === 0 ? 7 : cand.getDay();
      if (days.includes(wd) && cand.getTime() > now) return cand.getTime();
    }
    return 0;
  }
  if (t === 'monthly') {
    const want = Math.max(1, Math.min(31, Number(rule.day) || 1));
    for (let k = 0; k <= 45; k++) {
      const cand = new Date(base.getTime() + k * 86400000);
      if (cand.getDate() === want && cand.getTime() > now) return cand.getTime();
    }
    return 0;
  }
  return 0;
}

async function runScheduleRule(rule, opts) {
  const o = opts || {};
  const s = S.cfg.schedule || {};
  if (!o.force) {
    if (s.enabled === false) return { skipped: '全局已关闭' };
    if (rule.enabled === false) return { skipped: '规则已停用' };
    if (Number(rule.maxRuns) > 0 && Number(rule.runs || 0) >= Number(rule.maxRuns)) return { skipped: '已达最大次数' };
    if (Number(rule.endAt) > 0 && Date.now() > Number(rule.endAt)) return { skipped: '已过结束时间' };
  }
  const contact = String(rule.contact || '').trim();
  if (!contact) return { ok: false, error: '没填发给谁' };

  let text = String(rule.text || '').trim();
  if (rule.mode === 'ai') {
    const prompt = String(rule.prompt || rule.text || '').trim();
    if (!prompt) return { ok: false, error: 'AI 模式没填提示词' };
    try {
      text = await aiReply(S.cfg.system_prompt + '\n\n现在是定时任务，请按要求生成一条要发出去的简短消息，不要解释。', [], prompt);
      text = sanitizeReply(text);
    } catch (e) {
      return { ok: false, error: 'AI 生成失败: ' + e.message };
    }
  }
  if (!text) return { ok: false, error: '内容为空' };
  if (rule.atPerson && rule.isGroup) text = '@' + contact + ' ' + text;

  const dry = rule.dryRun === true || S.cfg.dry_run || !S.cfg.send.enabled;
  const rec = {
    id: `sched-${Date.now()}`,
    ts: Date.now(),
    sessionId: rule.sessionId || contact,
    contact,
    group: rule.isGroup ? contact : '',
    text,
    outbound: true,
    status: dry ? 'sched-dry' : 'sched-sent',
    ruleName: rule.name || rule.id,
  };
  pushMessage(rec);
  if (dry) {
    log('info', `[定时] 干跑「${rule.name || rule.id}」→ ${contact}：${text.slice(0, 60)}`);
  } else {
    const r = await wechatSend(contact, text.slice(0, 900));
    if (!r.ok) {
      rec.status = 'send-error';
      S.stats.errors++;
      log('error', `[定时] 发送失败「${rule.name || rule.id}」→ ${contact}: ${r.detail}`);
      return { ok: false, error: r.detail };
    }
    S.stats.sent++;
    log('info', `[定时] 已发送「${rule.name || rule.id}」→ ${contact}：${text.slice(0, 60)}`);
  }
  rule.lastRunAt = Date.now();
  rule.runs = (Number(rule.runs) || 0) + 1;
  saveConfig({});
  S.scheduleHistory.unshift({ at: Date.now(), name: rule.name || rule.id, contact, text: text.slice(0, 80), status: rec.status });
  if (S.scheduleHistory.length > 50) S.scheduleHistory.length = 50;
  return { ok: true, text, status: rec.status };
}

function tickSchedule() {
  const s = S.cfg.schedule || {};
  if (s.enabled === false) return;
  const now = Date.now();
  for (const rule of schedRules()) {
    try {
      if (rule.enabled === false) continue;
      if (Number(rule.endAt) > 0 && now > Number(rule.endAt)) continue;
      if (Number(rule.maxRuns) > 0 && Number(rule.runs || 0) >= Number(rule.maxRuns)) continue;
      const slot = prevSlot(rule, now);
      if (!slot) continue;
      if (Number(rule.lastRunAt) >= slot) continue;     // 这个点已经处理过
      const catchUp = Math.max(0, Number(rule.catchUpMinutes) || 0) * 60000;
      const late = now - slot;
      // 至少给 90 秒容差，否则正常 tick 也会被当成"错过"
      const tol = Math.max(catchUp, 90000);
      const isInterval = (rule.type === 'interval');
      if (isInterval || late <= tol) {
        // 落在这个窗口里：交给发送队列，避免和别的发送抢键盘
        if (late > 15000) log('info', `[定时]「${rule.name || rule.id}」错过了 ${Math.round(late / 60000)} 分钟，正在补发`);
        rule.lastRunAt = slot;                        // 先占位，防止重复触发
        const jit = Math.max(0, Math.min(600, Number(rule.jitterSeconds) || 0));
        const delay = jit ? Math.floor(Math.random() * jit) * 1000 : 0;
        if (delay) log('info', `[定时]「${rule.name || rule.id}」随机延迟 ${Math.round(delay / 1000)} 秒后发送`);
        setTimeout(() => enqueueSend(() => runScheduleRule(rule).catch((e) => log('error', '[定时] 执行异常: ' + e.message))), delay);
      } else {
        rule.lastRunAt = slot;                        // 错过了就记下来，不再补
        if (late > 60000) log('info', `[定时]「${rule.name || rule.id}」已错过（晚 ${Math.round(late / 60000)} 分钟，超出补发窗口）`);
      }
    } catch (e) {
      log('warn', '[定时] 规则异常: ' + e.message);
    }
  }
}

function startSchedule() {
  // 重复调用时把旧的 interval 和启动补偿定时器都清掉，否则会出现多个调度器
  if (S.scheduleTimer) { clearInterval(S.scheduleTimer); S.scheduleTimer = null; }
  if (S.scheduleBootTimer) { clearTimeout(S.scheduleBootTimer); S.scheduleBootTimer = null; }
  const s = S.cfg.schedule || {};
  if (s.enabled === false) { log('info', '定时消息已关闭'); return; }
  const tick = Math.max(5, Math.min(300, Number(s.tick_seconds) || 30)) * 1000;
  S.scheduleTimer = setInterval(tickSchedule, tick);
  if (S.scheduleTimer.unref) S.scheduleTimer.unref();
  const n = schedRules().filter((r) => r.enabled !== false).length;
  log('info', `定时消息调度器已启动：${n} 条规则，每 ${tick / 1000} 秒检查一次`);
  S.scheduleBootTimer = setTimeout(tickSchedule, 4000);   // 启动后先跑一次（处理开机补发）
  if (S.scheduleBootTimer.unref) S.scheduleBootTimer.unref();
}

// ---------------------------------------------------------------------------
// 上下文预算：估算 token、滚动摘要、超限自动压缩并归档
// ---------------------------------------------------------------------------
function ctxCfg() {
  const c = S.cfg.context || {};
  return {
    enabled: c.enabled !== false,
    max_tokens: Math.max(8000, Math.min(4000000, Number(c.max_tokens) || 200000)),
    compress_at: Math.min(0.95, Math.max(0.3, Number(c.compress_at) || 0.75)),
    keep_recent: Math.max(2, Math.min(400, Number(c.keep_recent) || 20)),
    summary_max_chars: Math.max(120, Math.min(4000, Number(c.summary_max_chars) || 700)),
    archive_compressed: c.archive_compressed !== false,
  };
}

/** 粗估 token：中文约 1.5 字/token，英文约 4 字符/token */
function estimateTokens(text) {
  const s = String(text || '');
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

function ctxDir() {
  const d = path.join(PATHS.cfgDir, 'context');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

function ctxFile(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  return path.join(ctxDir(), `${safe}.json`);
}

function loadCtxState(sessionId) {
  if (S.ctx.has(sessionId)) return S.ctx.get(sessionId);
  let st = { text: '', tokens: 0, compressed: 0, lastAt: 0, turns: 0 };
  try {
    const p = ctxFile(sessionId);
    if (fs.existsSync(p)) st = { ...st, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
  } catch (_) {}
  S.ctx.set(sessionId, st);
  return st;
}

function saveCtxState(sessionId, st) {
  S.ctx.set(sessionId, st);
  try { fs.writeFileSync(ctxFile(sessionId), JSON.stringify(st, null, 1), 'utf8'); } catch (_) {}
}

/** 当前这个会话的上下文用量（含摘要 + 历史 + 系统提示） */
function ctxUsage(sessionId) {
  const arr = S.history.get(sessionId) || [];
  const st = loadCtxState(sessionId);
  const histTokens = arr.reduce((n, m) => n + estimateTokens(m.content), 0);
  const sumTokens = estimateTokens(st.text);
  const sysTokens = estimateTokens(S.cfg.system_prompt || '');
  const total = histTokens + sumTokens + sysTokens;
  const cfg = ctxCfg();
  return {
    sessionId,
    messages: arr.length,
    historyTokens: histTokens,
    summaryTokens: sumTokens,
    systemTokens: sysTokens,
    total,
    max: cfg.max_tokens,
    percent: Math.round((total / cfg.max_tokens) * 1000) / 10,
    summary: st.text,
    compressed: st.compressed || 0,
    lastAt: st.lastAt || 0,
  };
}

/** 把被压缩掉的几轮对话写进这个会话自己的归档文件 */
function archiveCompressed(sessionId, contact, group, turns, summary) {
  if (!ctxCfg().archive_compressed) return;
  try {
    const dir = archiveDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(sessionId).replace(/[\\/:*?"<>|]/g, '_');
    const file = path.join(dir, `${safe}.ndjson`);
    const rec = {
      type: 'context-compress',
      at: Date.now(),
      sessionId,
      contact,
      group,
      turns,
      summary,
    };
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    log('info', `上下文压缩内容已写入归档：${path.basename(file)}（${turns.length} 轮）`);
  } catch (e) {
    log('warn', '写压缩归档失败：' + e.message);
  }
}

/** 超限就压缩：老对话 -> 摘要，最近 N 条原样留着 */
async function maybeCompressContext(sessionId, meta) {
  const cfg = ctxCfg();
  if (!cfg.enabled) return null;
  const arr = S.history.get(sessionId) || [];
  const st = loadCtxState(sessionId);
  const usage = ctxUsage(sessionId);
  if (usage.total < cfg.max_tokens * cfg.compress_at) return null;
  if (arr.length <= cfg.keep_recent) return null;   // 没多少可压的

  const cut = arr.length - cfg.keep_recent;
  const dropping = arr.slice(0, cut);
  const keep = arr.slice(cut);
  const oldSummary = st.text;

  log('info', `上下文用量 ${usage.total}/${cfg.max_tokens}（${usage.percent}%），开始压缩 ${dropping.length} 条为摘要`);

  const dialog = dropping.map((m) => `${m.role === 'assistant' ? '我' : '对方'}：${String(m.content).slice(0, 500)}`).join('\n');
  const prompt = [
    '把下面的聊天记录压缩成一段中文摘要，供以后继续对话时使用。',
    '要求：',
    '1. 保留人物名字、身份关系、已经明确的事实和数据、做过的决定、还没做完的事；',
    '2. 丢掉寒暄、重复内容、无信息量的语气词；',
    `3. 总长度不超过 ${cfg.summary_max_chars} 字；`,
    '4. 只输出摘要本身，不要标题、不要解释、不要列表符号。',
    oldSummary ? `\n【之前的摘要】\n${oldSummary}\n` : '',
    `\n【待压缩的对话】\n${dialog}`,
  ].join('\n');

  let summary = '';
  try {
    summary = await aiReply('你是一个严谨的对话摘要器，只输出摘要正文。', [], prompt);
  } catch (e) {
    log('warn', '上下文压缩失败，保留原样：' + e.message);
    return null;
  }
  summary = sanitizeReply(summary || '').slice(0, cfg.summary_max_chars);
  if (!summary) {
    log('warn', '上下文压缩得到空摘要，保留原样');
    return null;
  }

  S.history.set(sessionId, keep);
  const next = {
    text: summary,
    tokens: estimateTokens(summary),
    compressed: (st.compressed || 0) + dropping.length,
    lastAt: Date.now(),
    turns: (st.turns || 0) + dropping.length,
  };
  saveCtxState(sessionId, next);
  archiveCompressed(sessionId, (meta && meta.contact) || sessionId, (meta && meta.group) || '', dropping, summary);

  const after = ctxUsage(sessionId);
  log('info', `上下文压缩完成：${usage.total} → ${after.total} tokens（${after.percent}%），累计压缩 ${next.compressed} 条`);
  return { before: usage.total, after: after.total, dropped: dropping.length, summary };
}

function rememberTurn(sessionId, role, content) {
  const arr = S.history.get(sessionId) || [];
  arr.push({ role, content });
  const keep = Math.max(2, S.cfg.max_history) * 2;
  const budget = ctxCfg().max_tokens;
  while (arr.length > keep && estimateTokens(arr.map((m) => m.content).join('\n')) > budget) arr.shift();
  S.history.set(sessionId, arr);
}

// ---------------------------------------------------------------------------
// local rule engine: keyword watching + @ mention (no LLM involved)
// ---------------------------------------------------------------------------
const RECENT_MAX = 80;

function rememberRecent(sessionId, item) {
  let arr = S.recent.get(sessionId);
  if (!arr) { arr = []; S.recent.set(sessionId, arr); }
  arr.push(item);
  if (arr.length > RECENT_MAX) arr.splice(0, arr.length - RECENT_MAX);
}

function localKeywordHits(text, extraKeywords) {
  const w = S.cfg.watch || {};
  const hits = [];
  for (const k of [...(w.keywords || []), ...(extraKeywords || [])]) {
    const s = String(k || '').trim();
    if (s && text.includes(s)) hits.push(s);
  }
  for (const r of (w.regex || [])) {
    const s = String(r || '').trim();
    if (!s) continue;
    try {
      if (new RegExp(s, 'i').test(text)) hits.push('/' + s + '/');
    } catch (_) { /* 用户写错正则就跳过，别拖垮整条链路 */ }
  }
  return hits;
}

/** 拍一拍：内容是 `"小明" 拍了拍 "我"` 这种，既没有 @ 也不是普通文本 */
function detectPoke(text) {
  const t = String(text || '');
  if (!t.includes('拍了拍')) return null;
  const cfgM = S.cfg.mention || {};
  if (cfgM.poke_enabled === false) return null;
  const names = (cfgM.aliases || []).map((x) => String(x || '').trim()).filter(Boolean);
  const quoted = t.match(/拍了拍\s*"([^"]+)"/) || t.match(/拍了拍\s*“([^”]+)”/);
  const target = quoted ? quoted[1].trim() : '';
  if (target) {
    if (target === '我' || target === 'me') return '我';
    if (names.some((n) => target.includes(n) || n.includes(target))) return target;
    return null;
  }
  // 兜底：没引号的写法 "X 拍了拍 我"
  if (/拍了拍\s*我/.test(t)) return '我';
  for (const n of names) {
    if (t.includes('拍了拍 ' + n) || t.includes('拍了拍' + n)) return n;
  }
  return null;
}

function detectMention(text) {
  const m = S.cfg.mention || {};
  for (const a of (m.aliases || [])) {
    const n = String(a || '').trim();
    if (n && text.includes('@' + n)) return n;
  }
  return null;
}

function cooled(key, seconds) {
  const ms = Math.max(0, Number(seconds) || 0) * 1000;
  if (ms <= 0) return true;
  const last = S.cooldown.get(key) || 0;
  if (Date.now() - last < ms) return false;
  S.cooldown.set(key, Date.now());
  if (S.cooldown.size > 500) {
    for (const [k, v] of S.cooldown) if (Date.now() - v > 3600e3) S.cooldown.delete(k);
  }
  return true;
}

function buildEvent(type, o) {
  const n = Math.max(0, Number(o.n) || 0);
  const context = n && Array.isArray(o.before) ? o.before.slice(-n).map((x) => ({ ts: x.ts, sender: x.sender, text: x.text })) : [];
  return {
    source: 'weflow-bot',
    type,
    at: Date.now(),
    atIso: new Date().toISOString(),
    sessionId: o.sessionId,
    contact: o.contact,
    isGroup: !!o.isGroup,
    sender: o.sender || '',
    keyword: o.keyword || '',
    alias: o.alias || '',
    message: { text: o.text, ts: Date.now() },
    contextCount: context.length,
    context,
  };
}

async function deliverWebhook(ev) {
  const p = S.cfg.push || {};
  if (!p.url) { ev.delivered = 'no-target'; log('warn', `触发 ${ev.type} 但没配置 Webhook 地址，只写了日志`); return; }
  try {
    const r = await requestJson(p.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(p.headers || {}) },
      body: ev,
      timeout: Number(p.timeout_ms) || 12000,
    });
    const okHttp = r.status >= 200 && r.status < 300;
    ev.delivered = okHttp ? 'ok' : `http ${r.status}`;
    if (okHttp) S.triggerStats.webhookOk++;
    else S.triggerStats.webhookFail++;
    log(okHttp ? 'info' : 'error', `Webhook ${ev.type} → HTTP ${r.status}${okHttp ? '' : ' ' + r.text.slice(0, 120)}`);
  } catch (e) {
    ev.delivered = 'error: ' + e.message;
    S.triggerStats.webhookFail++;
    log('error', 'Webhook 推送失败: ' + e.message);
  }
}

function triggerEvent(ev, action) {
  S.events.unshift(ev);
  if (S.events.length > 200) S.events.length = 200;
  const tag = ev.type === 'mention' ? `@${ev.alias}` : ev.keyword;
  log('info', `触发 ${ev.type}[${tag}] ${ev.contact}${ev.sender ? ' / ' + ev.sender : ''}：${ev.message.text.slice(0, 40)}（上下文 ${ev.contextCount} 条）`);
  let enqueued = false;
  if (action === 'webhook' || action === 'both') deliverWebhook(ev);
  if (action === 'ai' || action === 'both') {
    const rec = pushMessage({ id: `trig-${Date.now()}`, ts: Date.now(), sessionId: ev.sessionId, contact: ev.contact, group: ev.isGroup ? ev.contact : '', sender: ev.sender, text: ev.message.text, status: 'triggered' });
    bufferMessage({
      key: (ev.isGroup && (!S.cfg.group || S.cfg.group.per_sender !== false)) ? `${ev.sessionId}|${ev.sender || 'anon'}` : ev.sessionId,
      sessionId: ev.sessionId,
      contact: ev.contact,
      group: ev.isGroup ? ev.contact : '',
      isGroup: !!ev.isGroup,
      sender: ev.sender,
      text: ev.message.text,
      rec,
    });
    enqueued = true;
  }
  return enqueued;
}

function bufferMessage(opts) {
  const { key, sessionId, contact, group, isGroup, sender, text, rec } = opts;
  let b = S.buffers.get(key);
  if (!b) {
    b = { key, sessionId, contact, group, isGroup, items: [], timer: null, senders: new Set(), startedAt: Date.now() };
    S.buffers.set(key, b);
  }
  b.contact = contact;
  b.items.push({ rec, text, sender: sender || '' });
  if (sender) b.senders.add(sender);
  for (const it of b.items) it.rec.status = 'buffered';
  if (b.timer) clearTimeout(b.timer);
  const g = groupCfgFor(sessionId);
  const secs = isGroup && Number(g.buffer_seconds) > 0
    ? Number(g.buffer_seconds)
    : (Number(S.cfg.buffer_seconds) || 10);
  const wait = Math.max(1, secs) * 1000;
  b.timer = setTimeout(() => {
    flushBuffer(key).catch((e) => {
      log('error', `合并回复失败(${contact}): ${e && e.message}${e && e.stack ? '\n' + String(e.stack).slice(0, 500) : ''}`);
    });
  }, wait);
  log('info', `收到 ${contact}${isGroup && sender ? ' / ' + sender : ''}: ${text.slice(0, 40)}（${wait / 1000}s 内合并）`);
}

// ---------------------------------------------------------------------------
// 文件访问权限（Agent / 插件）
// ---------------------------------------------------------------------------
function workspaceDir() {
  const w = (S.cfg.access && S.cfg.access.workspace) || '';
  return w && String(w).trim() ? String(w).trim() : PATHS.workspace;
}

function withinDir(p, dir) {
  try {
    const a = path.resolve(p).toLowerCase();
    const b = path.resolve(dir).toLowerCase();
    return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  } catch (_) { return false; }
}

const PROTECTED_DIRS = () => [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  process.resourcesPath,
  path.join(app.getPath('userData'), '..'),
];

function accessMode() {
  return String((S.cfg.access && S.cfg.access.mode) || 'off');
}

function globalScope(mode) {
  return mode === 'full' || mode === 'readonly_all';
}

/** @returns {{ok:boolean, abs?:string, reason?:string}} */
function accessDecision(p, kind) {
  const mode = accessMode();
  if (!p || !String(p).trim()) return { ok: false, reason: '路径为空' };
  let abs;
  try { abs = path.resolve(String(p).trim().replace(/^["']|["']$/g, '')); } catch (_) { return { ok: false, reason: '路径非法' }; }

  // 机器人自己的输出目录永远可写
  if (withinDir(abs, PATHS.out)) return { ok: true, abs };
  if (mode === 'off') return { ok: false, reason: '当前是「不访问文件」模式，先在 Bot → 插件 → 权限里打开' };

  const ws = workspaceDir();
  if (!globalScope(mode) && !withinDir(abs, ws)) {
    return { ok: false, reason: `超出工作区（当前工作区：${ws}）。要访问整机请把权限设为「整机只读」或「完全访问」` };
  }
  if (kind === 'write') {
    if (mode === 'readonly' || mode === 'readonly_all') return { ok: false, reason: '当前是只读模式，不能写文件' };
    for (const bad of PROTECTED_DIRS()) {
      if (bad && withinDir(abs, bad)) return { ok: false, reason: '系统/程序目录受保护，拒绝写入' };
    }
  }
  return { ok: true, abs };
}

function listDir(p) {
  const d = accessDecision(p, 'read');
  if (!d.ok) return { ok: false, message: '拒绝：' + d.reason };
  try {
    const st = fs.statSync(d.abs);
    if (!st.isDirectory()) return { ok: false, message: '不是目录：' + d.abs };
    const items = fs.readdirSync(d.abs, { withFileTypes: true })
      .map((it) => {
        let size = '';
        try { if (it.isFile()) size = `${Math.round(fs.statSync(path.join(d.abs, it.name)).size / 1024)}K`; } catch (_) {}
        return { name: it.name, dir: it.isDirectory(), size };
      })
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
      .slice(0, 60);
    const lines = items.map((x) => `${x.dir ? '📁' : '📄'} ${x.name}${x.size ? '  ' + x.size : ''}`);
    return { ok: true, message: `${d.abs}\n${lines.join('\n')}${items.length >= 60 ? '\n…（只列前 60 项）' : ''}` };
  } catch (e) {
    return { ok: false, message: '读取目录失败：' + e.message };
  }
}

function readTextFile(p) {
  const d = accessDecision(p, 'read');
  if (!d.ok) return { ok: false, message: '拒绝：' + d.reason };
  try {
    const st = fs.statSync(d.abs);
    if (st.isDirectory()) return { ok: false, message: '这是目录，请用 /ls' };
    const cap = Math.max(1, Number(S.cfg.access.max_read_kb) || 512) * 1024;
    const fd = fs.openSync(d.abs, 'r');
    const buf = Buffer.alloc(Math.min(cap, st.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    return { ok: true, message: `📄 ${path.basename(d.abs)}（${Math.round(st.size / 1024)} KB${st.size > cap ? '，只取了前 ' + Math.round(cap / 1024) + ' KB' : ''}）\n---\n${text.slice(0, 3500)}` };
  } catch (e) {
    return { ok: false, message: '读取失败：' + e.message };
  }
}

function writeTextFile(p, content) {
  const d = accessDecision(p, 'write');
  if (!d.ok) return { ok: false, message: '拒绝：' + d.reason };
  try {
    const cap = Math.max(1, Number(S.cfg.access.max_write_mb) || 32) * 1024 * 1024;
    const buf = Buffer.from(String(content == null ? '' : content), 'utf8');
    if (buf.length > cap) return { ok: false, message: `内容超过 ${cap / 1024 / 1024} MB 上限` };
    fs.mkdirSync(path.dirname(d.abs), { recursive: true });
    fs.writeFileSync(d.abs, buf);
    return { ok: true, message: `已写入 ${d.abs}（${buf.length} 字节）` };
  } catch (e) {
    return { ok: false, message: '写入失败：' + e.message };
  }
}

// ---------------------------------------------------------------------------
// 插件系统
// ---------------------------------------------------------------------------
function isPluginDisabled(id) {
  const d = (S.cfg.plugins && S.cfg.plugins.disabled) || [];
  return Array.isArray(d) && d.includes(id);
}

function scanPlugins() {
  const seen = new Map();
  S_PLUGINS.lastError = null;
  for (const dir of PATHS.pluginDirs) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { continue; }
    for (const name of names) {
      const pdir = path.join(dir, name);
      const manifestPath = path.join(pdir, 'plugin.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const id = String(m.id || name).trim();
        if (!id || seen.has(id)) continue;
        const entry = path.join(pdir, 'index.js');
        seen.set(id, {
          id,
          name: String(m.name || id),
          version: String(m.version || '0.0.0'),
          description: String(m.description || ''),
          commands: Array.isArray(m.commands) ? m.commands.map(String) : [],
          usage: String(m.usage || ''),
          builtin: !!m.builtin || withinDir(pdir, path.join(process.resourcesPath, 'wfai')),
          dir: pdir,
          entry,
          ok: fs.existsSync(entry),
          error: fs.existsSync(entry) ? null : '缺少 index.js',
          enabled: !isPluginDisabled(id),
          source: withinDir(pdir, path.join(process.resourcesPath, 'wfai')) ? 'builtin' : 'user',
        });
      } catch (e) {
        S_PLUGINS.lastError = `${name}: ${e.message}`;
      }
    }
  }
  S_PLUGINS.list = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  S_PLUGINS.scannedAt = Date.now();
  log('info', `插件扫描完成：${S_PLUGINS.list.length} 个（${S_PLUGINS.list.filter((p) => p.enabled).length} 个启用）`);
  return S_PLUGINS.list;
}

function findPluginByCommand(cmd) {
  const c = String(cmd || '').toLowerCase();
  return S_PLUGINS.list.find((p) => p.enabled && p.ok && p.commands.some((x) => x.toLowerCase() === c)) || null;
}

function runPlugin(plugin, payload) {
  return new Promise((resolve) => {
    const host = path.join(PATHS.lib, 'plugin-host.js');
    const timeoutMs = Math.max(5, Number(S.cfg.agent.plugin_timeout_seconds) || 25) * 1000;
    let ps;
    try {
      ps = spawn(process.execPath, [host, plugin.entry], {
        cwd: plugin.dir,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } catch (e) {
      return resolve({ ok: false, message: '插件启动失败: ' + e.message, files: [] });
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    const timer = setTimeout(() => { try { ps.kill(); } catch (_) {} finish({ ok: false, message: `插件超时（${timeoutMs / 1000}s）`, files: [] }); }, timeoutMs);
    ps.stdout.on('data', (d) => { out += d.toString(); });
    ps.stderr.on('data', (d) => { err += d.toString(); });
    ps.on('error', (e) => finish({ ok: false, message: '插件进程错误: ' + e.message, files: [] }));
    ps.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      if (!line) return finish({ ok: false, message: '插件没有返回结果' + (err ? '：' + err.slice(0, 200) : ''), files: [] });
      try {
        const j = JSON.parse(line);
        if (!j.ok && j.message) log('warn', `插件 ${plugin.id} 失败：${j.message}`);
        finish({ ok: j.ok !== false, message: String(j.message || ''), files: Array.isArray(j.files) ? j.files : [] });
      } catch (e) {
        finish({ ok: false, message: '插件输出无法解析：' + line.slice(0, 200), files: [] });
      }
    });
    try {
      ps.stdin.write(JSON.stringify(payload));
      ps.stdin.end();
    } catch (e) {
      finish({ ok: false, message: '写入插件入参失败: ' + e.message, files: [] });
    }
  });
}

// ---------------------------------------------------------------------------
// 插件安装（zip / 文件夹 / GitHub URL）
// ---------------------------------------------------------------------------
function findPluginAnyState(id) {
  return S_PLUGINS.list.find((p) => p.id === id) || null;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

function downloadZip(url, depth = 0, allowInsecure = false) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 无效: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const opts = { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { 'User-Agent': 'WeFlowBot', Accept: '*/*' }, timeout: 60000 };
    if (allowInsecure) opts.rejectUnauthorized = false;
    const req = lib.get(
      opts,
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          return resolve(downloadZip(next, depth + 1, allowInsecure));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > 60 * 1024 * 1024) { req.destroy(); reject(new Error('文件超过 60MB')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => {
      // 本机装了自签/代理根证书时 Node 会报 first certificate；降级重试一次并留日志
      if (!allowInsecure && u.protocol === 'https:' && /certificate|self.signed|CERT_/i.test(e.message)) {
        log('warn', `TLS 校验失败（${e.message}），改用忽略证书方式重试：${u.hostname}`);
        return resolve(downloadZip(url, depth, true));
      }
      reject(e);
    });
  });
}

async function downloadZipSmart(rawUrl) {
  let url = String(rawUrl || '').trim();
  const gh = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)\/?$/i);
  if (gh) {
    // 只给了仓库主页 → 依次试 main / master 的 archive
    const base = `https://github.com/${gh[1]}/${gh[2]}`;
    let lastErr = null;
    for (const br of ['main', 'master']) {
      try { return await downloadZip(`${base}/archive/refs/heads/${br}.zip`); } catch (e) { lastErr = e; }
    }
    throw new Error(`仓库归档下载失败：${lastErr ? lastErr.message : '未知原因'}`);
  }
  return downloadZip(url);
}

function installPluginFromZip(buf, hint) {
  const { unzip } = require(path.join(PATHS.lib, 'unzip.js'));
  const files = unzip(buf).filter((f) => !f.dir);
  if (!files.length) throw new Error('压缩包是空的');
  const manifestEntry = files.find((f) => /(^|\/)plugin\.json$/i.test(f.name));
  if (!manifestEntry) {
    const sample = files.slice(0, 6).map((f) => f.name).join(', ');
    throw new Error(`压缩包里找不到 plugin.json。里面的文件：${sample}…\n需要的结构：<id>/plugin.json + <id>/index.js`);
  }
  const prefix = manifestEntry.name.replace(/plugin\.json$/i, '');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.data.toString('utf8')); } catch (e) { throw new Error('plugin.json 不是合法 JSON: ' + e.message); }
  const id = String(manifest.id || hint || 'plugin').replace(/[^\w.\-\u4e00-\u9fa5]/g, '-');
  if (!id) throw new Error('插件 id 无效');
  const target = path.join(PATHS.pluginDirs[PATHS.pluginDirs.length - 1], id);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  let n = 0;
  for (const f of files) {
    rememberSelfSent(meta.sessionId, '', true);
    if (prefix && !f.name.startsWith(prefix)) continue;
    const rel = prefix ? f.name.slice(prefix.length) : f.name;
    if (!rel || rel.startsWith('/') || rel.includes('..') || /^[A-Za-z]:/.test(rel)) continue;
    const dest = path.join(target, rel);
    if (!withinDir(dest, target)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
    n++;
  }
  if (!n) throw new Error('压缩包里没有解出任何文件');
  if (!fs.existsSync(path.join(target, 'index.js'))) {
    throw new Error('插件缺少 index.js（入口文件）');
  }
  return { id, target, files: n, name: String(manifest.name || id), version: String(manifest.version || ''), commands: manifest.commands || [] };
}

// ---------------------------------------------------------------------------
// Agent：把消息当命令解析（全部本地）
// ---------------------------------------------------------------------------
const HELP_TEXT = [
  '可用命令（前缀 /）：',
  '/ppt 标题 → 生成演示文稿（# 分页，- 要点）',
  '/word 标题 → 生成 Word（# 标题，- 列表，| 表格 |）',
  '/纪要 [会话名] [天数] → 从本地归档生成纪要到 Word',
  '/ls 路径 → 列目录',
  '/cat 路径 → 读文件',
  '/write 路径 → 写入（正文从下一行开始）',
  '/help → 这条帮助',
].join('\n');

function stripLeadingMentions(text) {
  const m = S.cfg.mention || {};
  let t = String(text || '');
  for (const a of (m.aliases || [])) {
    const n = String(a || '').trim();
    if (n) t = t.split('@' + n).join(' ');
  }
  return t.trim();
}

function parseCommand(rawText) {
  const text = stripLeadingMentions(rawText);
  if (!text) return null;
  const slash = text.match(/^\/([A-Za-z\u4e00-\u9fa5_-]+)\s*([\s\S]*)$/);
  if (slash) return { cmd: slash[1].toLowerCase(), rest: slash[2], text };
  const cjk = text.match(/^(查看|列出|读取|写入)\s+([\s\S]*)$/);
  if (cjk) return { cmd: { 查看: 'ls', 列出: 'ls', 读取: 'cat', 写入: 'write' }[cjk[1]], rest: cjk[2], text };
  return null;
}

async function runAgent(rawText, meta) {
  if (!(S.cfg.agent && S.cfg.agent.enabled)) return null;
  const parsed = parseCommand(rawText);
  if (!parsed) return null;
  const { cmd, rest, text } = parsed;

  const ctxBase = {
    sessionId: meta.sessionId,
    contact: meta.contact,
    sender: meta.sender,
    isGroup: meta.isGroup,
    libDir: PATHS.lib,
    outDir: PATHS.out,
    archiveDir: PATHS.archive,
    workspace: workspaceDir(),
    accessMode: accessMode(),
    now: Date.now(),
  };

  if (cmd === 'help' || cmd === '帮助') return { ok: true, message: HELP_TEXT, files: [] };

  if (cmd === 'ls') {
    const r = listDir(rest || workspaceDir());
    return { ok: r.ok, message: r.message, files: [] };
  }
  if (cmd === 'cat') {
    const r = readTextFile(rest.trim());
    return { ok: r.ok, message: r.message, files: [] };
  }
  if (cmd === 'write') {
    const nl = rest.indexOf('\n');
    const target = (nl < 0 ? rest : rest.slice(0, nl)).trim();
    const body = nl < 0 ? '' : rest.slice(nl + 1);
    const r = writeTextFile(target, body);
    return { ok: r.ok, message: r.message, files: [] };
  }

  const plugin = findPluginByCommand(cmd);
  if (!plugin) return { ok: false, message: `没有 /${cmd} 这个命令。发 /help 看清单。`, files: [] };
  const res = await runPlugin(plugin, { ...ctxBase, text, args: rest.trim(), context: meta.context || [] });
  log('info', `插件 ${plugin.id} 执行${res.ok ? '成功' : '失败'}：${String(res.message || '').slice(0, 80)}`);
  return res;
}

/** 是否允许回复里带 @对方（两个开关都开才允许） */
function atPersonEnabled() {
  const a = (S.cfg.reply || {}).at_person !== false;
  const b = (S.cfg.group || {}).reply_mention !== false;
  return a && b;
}

/** 开关关掉时，把模型自己加的「@某某 」从开头削掉 */
function stripAtPrefix(text) {
  let t = String(text || '');
  for (let i = 0; i < 6; i++) {
    const m = t.match(/^\s*@[^\s@，,：:、]{1,24}[\s，,：:、]+/);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t.trim();
}

async function replyWithResult(contact, result, meta) {
  const lines = [];
  const atPerson = atPersonEnabled();
  if (result.message) {
    let msg = sanitizeReply(result.message);
    if (meta && meta.isGroup && !atPerson) msg = stripAtPrefix(msg);
    if (atPerson && meta && meta.isGroup && meta.sender && msg && !msg.startsWith('@' + meta.sender)) {
      msg = '@' + meta.sender + ' ' + msg;
    }
    lines.push(msg);
  }
  const files = (result.files || []).filter(Boolean).slice(0, Math.max(1, Number(S.cfg.agent.max_files_per_reply) || 3));
  const rec = pushMessage({
    id: `agent-${Date.now()}`,
    ts: Date.now(),
    sessionId: meta.sessionId,
    contact,
    group: meta.isGroup ? contact : '',
    text: lines.join('\n') || '（无输出）',
    outbound: true,
    status: result.ok ? 'reply' : 'ai-error',
  });

  if (S.cfg.dry_run || !S.cfg.send.enabled) {
    rec.status = 'dry-run';
    S.stats.dryrun++;
    log('info', `干跑（未发送）给 ${contact}：${(lines.join(' ') || '').slice(0, 120)}${files.length ? ' + ' + files.length + ' 个文件' : ''}`);
    for (const f of files) log('info', `  附件：${f}`);
    return;
  }

  if (lines.length) {
    const r0 = await wechatSend(contact, lines.join('\n').slice(0, 900));
    if (!r0.ok) { rec.status = 'send-error'; S.stats.errors++; log('error', `发送失败(${contact}): ${r0.detail}`); return; }
    rememberSelfSent(meta.sessionId, lines.join('\n'), false);
  }
  if (S.cfg.agent.send_files && files.length) {
    for (const f of files) {
    rememberSelfSent(meta.sessionId, '', true);
      const r1 = await wechatSendFile(contact, f);
      if (r1.ok) log('info', `已发送文件给 ${contact}：${path.basename(f)}`);
      else { S.stats.errors++; log('error', `文件发送失败(${contact}): ${r1.detail}`); }
    }
  }
  rec.status = 'sent';
  S.stats.sent++;
  S.stats.replied++;
  log('info', `已回复 ${contact}：${(lines.join(' ') || '').slice(0, 80)}${files.length ? ' + ' + files.length + ' 个文件' : ''}`);
}

// ---------------------------------------------------------------------------
// 工具（function calling）：让模型自己决定调用哪个插件
// ---------------------------------------------------------------------------
function toolNameFor(plugin) {
  const safe = String(plugin.id).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40);
  return `plugin_${safe}`;
}

function toolListAllowed() {
  const mode = accessMode();
  return { canRead: mode !== 'off', canWrite: mode === 'workspace_rw' || mode === 'full' };
}

function buildToolSpecs() {
  const specs = [];
  const names = new Map();
  const allow = toolListAllowed();

  for (const p of S_PLUGINS.list) {
    if (!p.enabled || !p.ok) continue;
    const name = toolNameFor(p);
    names.set(name, { kind: 'plugin', plugin: p });
    specs.push({
      type: 'function',
      function: {
        name,
        description: `${p.name}：${p.description || ''}${p.usage ? '　用法参考：' + p.usage.replace(/\n/g, ' ').slice(0, 160) : ''}`.slice(0, 900),
        parameters: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              description: '工具的正文输入。必须严格按「用法参考」里的纯文本格式书写，不要写成说明性长文。例如生成 PPT 时：第一行是标题，之后每行以 # 开头表示新一页，以 - 开头表示一个要点。',
            },
          },
          required: ['input'],
        },
      },
    });
  }

  if (webCfg().enabled) {
  if (allow.canRead) {
    names.set('search_history', { kind: 'builtin', op: 'search_history' });
    specs.push({
      type: 'function',
      function: {
        name: 'search_history',
        description: '在本地归档的聊天记录里搜索（按关键词和时间范围）。用户问「之前谁说过什么」「上周群里聊了啥」「上次那个链接」这类历史问题时用它。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '关键词；留空则按时间倒序取最近的' },
            session: { type: 'string', description: '只搜某个群名或备注，留空=搜全部会话' },
            days: { type: 'number', description: '只搜最近多少天，默认 30' },
            limit: { type: 'number', description: '返回条数，默认 20' },
          },
          required: [],
        },
      },
    });
  }

    names.set('web_search', { kind: 'builtin', op: 'web_search' });
    specs.push({ type: 'function', function: { name: 'web_search', description: '联网搜索。当需要最新信息、新闻、天气、价格、汇率、你不确定的事实，或用户明确让你上网查时使用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } });
    names.set('web_fetch', { kind: 'builtin', op: 'web_fetch' });
    specs.push({ type: 'function', function: { name: 'web_fetch', description: '打开一个网页并读取正文（纯文本）。搜索结果里的链接可以用它读全文。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整 http/https 链接' } }, required: ['url'] } } });
  }

  if (allow.canRead) {
    names.set('send_file', { kind: 'builtin', op: 'send_file' });
    specs.push({ type: 'function', function: { name: 'send_file', description: '把本机上的一个文件发给对方（图片会作为图片发送，其它文件作为文件发送）。用户让你"把某张图/某个文件发给我"时用它。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, caption: { type: 'string', description: '可选，附带一句话' } }, required: ['path'] } } });
    names.set('list_dir', { kind: 'builtin', op: 'ls' });
    specs.push({ type: 'function', function: { name: 'list_dir', description: '列出某个目录下的文件（受文件权限限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '目录绝对路径，留空则用工作区' } }, required: [] } } });
    names.set('read_file', { kind: 'builtin', op: 'cat' });
    specs.push({ type: 'function', function: { name: 'read_file', description: '读取一个文本文件的内容（受文件权限限制）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' } }, required: ['path'] } } });
  }
  if (allow.canWrite) {
    names.set('write_file', { kind: 'builtin', op: 'write' });
    specs.push({ type: 'function', function: { name: 'write_file', description: '把文本写入文件（受文件权限限制，系统目录会被拒绝）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, content: { type: 'string', description: '要写入的内容' } }, required: ['path', 'content'] } } });
  }
  return { specs, names };
}

async function aiChatWithTools(messages, tools) {
  const ai = S.cfg.ai;
  if (ai.type === 'ollama') throw Object.assign(new Error('Ollama 模式暂不支持工具调用'), { noTools: true });
  const base = ai.base_url.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const body = { model: ai.model, messages, temperature: ai.temperature, max_tokens: 1600, stream: false };
  if (tools && tools.length) body.tools = tools;
  // 百炼的 enable_search 是请求参数，可以和 function tools 共存；
  // DeepSeek 的服务端联网工具不能和普通 tools 同时出现，所以工具模式下不启用
  if (aiNativeSearchMode() === 'dashscope-param') {
    body.enable_search = true;
    const strat = String(ai.search_strategy || 'agent');
    body.search_options = { search_strategy: strat === 'turbo' || strat === 'max' ? strat : 'agent' };
  }
  const r = await requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ai.api_key}` },
    body,
    timeout: Math.max(30, Number(ai.timeout) || 40) * 1000,
  });
  if (r.status < 200 || r.status >= 300) {
    const err = new Error(`AI HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    err.httpStatus = r.status;
    err.body = r.text;
    throw err;
  }
  let j;
  try { j = JSON.parse(r.text); } catch (e) { throw new Error('AI 返回不是 JSON: ' + r.text.slice(0, 200)); }
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  const nativeMeta = extractNativeMeta(msg, j.usage);
  if (nativeMeta.citations.length || nativeMeta.toolSearch) S.lastAiMeta.set(String(S._aiSession || ''), nativeMeta);
  return {
    content: String(msg.content || ''),
    toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
    meta: nativeMeta,
  };
}

async function executeToolCall(name, args, meta) {
  const built = buildToolSpecs();
  const target = built.names.get(name);
  if (!target) return { ok: false, text: `没有名为 ${name} 的工具` };
  try {
    if (target.kind === 'builtin') {
      if (target.op === 'ls') {
        const r = listDir(args.path || workspaceDir());
        return { ok: r.ok, text: r.message };
      }
      if (target.op === 'cat') {
        const r = readTextFile(args.path || '');
        return { ok: r.ok, text: r.message };
      }
      if (target.op === 'write') {
        const r = writeTextFile(args.path || '', args.content == null ? '' : args.content);
        return { ok: r.ok, text: r.message };
      }
      if (target.op === 'search_history') {
        const days = Math.max(0, Number(args.days) || 30);
        const since = days ? Date.now() - days * 86400000 : 0;
        const all = archiveFiles();
        let sid = '';
        const want = String(args.session || '').trim().toLowerCase();
        if (want) {
          const hit = all.find((x) => String(x.name || '').toLowerCase() === want || String(x.sessionId || '').toLowerCase() === want)
            || all.find((x) => String(x.name || '').toLowerCase().includes(want));
          if (hit) sid = hit.sessionId;
        }
        const r = searchArchive({ query: args.query || '', sessionId: sid, since, limit: Math.min(40, Number(args.limit) || 20) });
        if (!r.items.length) return { ok: true, text: `本地归档里没搜到${r.query ? '「' + r.query + '」' : ''}的相关记录（近 ${days} 天，扫了 ${r.scanned} 个会话）` };
        const lines = r.items.map((x) => {
          const d = new Date(x.ts * 1000);
          const pad = (n) => String(n).padStart(2, '0');
          return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${x.name || x.sessionId} / ${x.sender || '我'}${x.isSend ? '（我发的）' : ''}：${x.text}`;
        }).join('\n');
        return { ok: true, text: `本地归档匹配到 ${r.matched} 条（显示最近 ${r.items.length} 条）：\n${lines}` };
      }
      if (target.op === 'web_search') {
        const r = await webSearch(args.query || args.q || '');
        return { ok: r.ok, text: r.text };
      }
      if (target.op === 'web_fetch') {
        const r = await webFetch(args.url || '', Number(args.limit_kb) || 0);
        return { ok: r.ok, text: r.text };
      }
      if (target.op === 'send_file') {
        const p = String(args.path || '').trim().replace(/^["']|["']$/g, '');
        const d = accessDecision(p, 'read');
        if (!d.ok) return { ok: false, text: '拒绝：' + d.reason };
        let st;
        try { st = fs.statSync(d.abs); } catch (_) { return { ok: false, text: '文件不存在：' + d.abs }; }
        if (st.isDirectory()) {
          // 传目录就自动把里面的图片都带上
          const imgs = fs.readdirSync(d.abs).filter((n) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(n)).slice(0, 9)
            .map((n) => path.join(d.abs, n));
          if (!imgs.length) return { ok: false, text: '这个目录里没有图片：' + d.abs };
          const bucket = S.attach.get(meta && meta.sessionId) || [];
          for (const f2 of imgs) bucket.push(f2);
          S.attach.set(meta && meta.sessionId, bucket);
          return { ok: true, text: `已把 ${d.abs} 里的 ${imgs.length} 张图片加入待发附件：${imgs.map((x) => path.basename(x)).join('、')}` };
        }
        if (st.size > 200 * 1024 * 1024) return { ok: false, text: '文件过大（>200MB），微信发不了' };
        const bucket2 = S.attach.get(meta && meta.sessionId) || [];
        bucket2.push(d.abs);
        S.attach.set(meta && meta.sessionId, bucket2);
        const isImg = /\.(png|jpe?g|gif|webp|bmp)$/i.test(d.abs);
        return { ok: true, text: `已加入待发附件：${path.basename(d.abs)}（${Math.round(st.size / 1024)}KB）${isImg ? '，会作为图片发送' : ''}` };
      }
      return { ok: false, text: '未知内置工具' };
    }
    const plugin = target.plugin;
    const payload = {
      text: `/x ${args.input || ''}`,
      args: String(args.input || ''),
      context: meta.context || [],
      sessionId: meta.sessionId,
      contact: meta.contact,
      sender: meta.sender,
      isGroup: meta.isGroup,
      libDir: PATHS.lib,
      outDir: PATHS.out,
      archiveDir: PATHS.archive,
      workspace: workspaceDir(),
      accessMode: accessMode(),
      now: Date.now(),
    };
    const res = await runPlugin(plugin, payload);
    return {
      ok: res.ok,
      text: [res.message || '', (res.files || []).length ? `（已生成文件：${res.files.map((f) => path.basename(f)).join('、')}）` : ''].filter(Boolean).join('\n'),
      files: res.files || [],
    };
  } catch (e) {
    return { ok: false, text: '工具执行失败：' + e.message };
  }
}

/**
 * 让模型自己挑工具：OpenAI 兼容的 function calling 循环。
 * 返回 { text, files }
 */
async function runToolLoop(meta, userText, history, systemPromptOverride) {
  const { specs, names } = buildToolSpecs();
  if (!specs.length) return null;

  const sys = `${systemPromptOverride || S.cfg.system_prompt}

你可以调用工具来真正完成任务，而不是只描述。
- 用户要 PPT/Word/纪要/导出这类文件时，直接调用对应工具，拿到文件后再用一两句话告诉用户结果。
- 调用生成类工具时，input 必须严格使用工具说明里的纯文本格式（# 分页、- 要点、| 表格 |），不要写成长篇设计说明或要求清单。
- 需要看本机文件时，先 list_dir 看清目录，再 read_file 读具体文件；不要猜路径。
- 不要编造工具没有返回的内容。
- 最终回复要简短、口语化，不要再罗列工具名。`;

  const messages = [{ role: 'system', content: sys }];
  for (const h of (history || [])) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: userText });

  const rounds = Math.max(1, Math.min(8, Number(S.cfg.agent.max_tool_rounds) || 4));
  const files = [];
  let lastText = '';
  let toolTried = false;

  for (let i = 0; i < rounds; i++) {
    let res;
    try {
      res = await aiChatWithTools(messages, specs);
    } catch (e) {
      if (e.noTools || /tool|function/i.test(String(e.body || e.message))) {
        log('warn', `模型不支持工具调用，回退到纯对话：${e.message.slice(0, 120)}`);
        return null;
      }
      throw e;
    }
    lastText = res.content || lastText;
    if (!res.toolCalls.length) return { text: res.content || lastText, files };

    const assistantMsg = { role: 'assistant', content: res.content || null, tool_calls: res.toolCalls };
    if (res.reasoningContent) assistantMsg.reasoning_content = res.reasoningContent;   // DeepSeek：带 tools 时必须回传
    messages.push(assistantMsg);
    for (const call of res.toolCalls) {
      const name = (call.function && call.function.name) || '';
      let args = {};
      try { args = JSON.parse((call.function && call.function.arguments) || '{}'); } catch (_) {}
      toolTried = true;
      S.toolStats.calls++;
      pushMessage({
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ts: Date.now(),
        sessionId: meta.sessionId,
        contact: meta.contact,
        group: meta.isGroup ? meta.contact : '',
        text: `🔧 ${name}(${JSON.stringify(args).slice(0, 160)})`,
        status: 'tool',
      });
      log('info', `模型调用工具 ${name}：${JSON.stringify(args).slice(0, 120)}`);
      const r = await executeToolCall(name, args, meta);
      if (r.ok) S.toolStats.ok++; else S.toolStats.fail++;
      if (r.files && r.files.length) files.push(...r.files);
      log(r.ok ? 'info' : 'warn', `工具 ${name} ${r.ok ? '成功' : '失败'}：${String(r.text).slice(0, 120)}`);
      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${i}_${Math.random().toString(36).slice(2, 6)}`,
        content: String(r.text || (r.ok ? 'ok' : 'failed')).slice(0, 3500),
      });
    }
  }
  if (!toolTried) return null;
  return { text: lastText || '（工具调用轮次已达上限，先给你这些）', files };
}

async function handleAgent(text, meta) {
  let res;
  try {
    res = await runAgent(text, meta);
  } catch (e) {
    res = { ok: false, message: '命令执行出错：' + (e && e.message ? e.message : String(e)), files: [] };
  }
  if (!res) return;
  try {
    await replyWithResult(meta.contact, res, meta);
  } catch (e) {
    S.stats.errors++;
    log('error', 'Agent 回复失败：' + (e && e.message ? e.message : String(e)));
  }
}

// 微信的文字表情是混在正文里的 `[破涕为笑]` 这种方括号 token，还有真 unicode emoji
const EMOJI_TOKEN_RE = /\[[^\[\]\r\n]{1,12}\]/g;
const EMOJI_UNICODE_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;

function stripEmojiTokens(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(EMOJI_TOKEN_RE, ' ');
  try { t = t.replace(EMOJI_UNICODE_RE, ' '); } catch (_) {}
  return t.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 微信有时候把引用消息的原始发送人拼在正文里（wxid_xxx: 或者纯字母数字 id: ），去掉 */
function cleanIncomingText(raw) {
  let s = String(raw == null ? '' : raw);
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^\s*wxid_[A-Za-z0-9_-]{3,}\s*[:：]\s*/i, '');
    s = s.replace(/^\s*([A-Za-z0-9_-]{6,26})\s*[:：]\s*(?=[\[@（(])/, '');
    s = s.replace(/^\s*\n+/, '');
    if (s === before) break;
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// 自己的回声过滤：WeFlow 有时会把本账号发出的消息也推过来，不能回自己
// ---------------------------------------------------------------------------
function selfNames() {
  const m = S.cfg.mention || {};
  const extra = Array.isArray(m.self_names) ? m.self_names : [];
  const aliases = Array.isArray(m.aliases) ? m.aliases : [];
  const all = [...aliases, ...extra].map((x) => String(x || '').trim()).filter(Boolean);
  const own = String((S.cfg.self && S.cfg.self.display_name) || '').trim();
  if (own) all.push(own);
  return all;
}

function isSelfSender(sender) {
  const s = String(sender || '').trim();
  if (!s) return false;
  return selfNames().some((n) => n === s);
}

function rememberSelfSent(sessionId, text, isMedia) {
  S.selfSent.push({ sessionId, text: String(text || '').trim(), isMedia: !!isMedia, at: Date.now() });
  while (S.selfSent.length > 60) S.selfSent.shift();
}

/** 这条推送是不是我们自己刚发出去的（文本或图片/表情） */
function isSelfEcho(sessionId, text, mediaKind) {
  const now = Date.now();
  S.selfSent = S.selfSent.filter((x) => now - x.at < 300000);
  const t = String(text || '').trim();
  // 图片/表情：刚发过图就吃掉一条对应的媒体推送
  if (mediaKind) {
    const idx = S.selfSent.findIndex((x) => x.sessionId === sessionId && x.isMedia && now - x.at < 120000);
    if (idx >= 0) { S.selfSent.splice(idx, 1); return true; }
    return false;
  }
  // 文本：内容一致且是近期的
  const idx = S.selfSent.findIndex((x) => x.sessionId === sessionId && !x.isMedia && x.text === t && now - x.at < 300000);
  if (idx >= 0) { S.selfSent.splice(idx, 1); return true; }
  return false;
}

function handlePush(payload) {
  if (!payload || payload.event !== 'message.new') return;
  const sessionId = String(payload.sessionId || payload.sourceName || 'unknown');
  const isGroup = sessionId.endsWith('@chatroom');
  const groupName = String(payload.groupName || '');
  const contact = groupName || String(payload.sourceName || sessionId);
  const sender = String(payload.sourceName || '');
  let text = cleanIncomingText(typeof payload.content === 'string' ? payload.content : String(payload.content ?? ''));
  const rec = pushMessage({
    id: payload.messageKey || `${sessionId}-${Date.now()}`,
    ts: Date.now(),
    sessionId,
    contact,
    group: groupName,
    sender,
    text,
    status: 'pending',
  });
  S.stats.received++;

  if (!text.trim()) { rec.status = 'empty'; return; }

  // ---- 先把自己发出去的消息挡掉 ----
  const cfgF = S.cfg.filter || {};
  if (cfgF.drop_self !== false) {
    const mediaKindNow = classifyMedia(text);
    if (isSelfSender(sender)) {
      rec.status = 'self';
      rememberSelfSent(sessionId, text, !!mediaKindNow);
      log('info', `忽略自己发的消息（${sender}）：${text.slice(0, 40)}`);
      return;
    }
    if (isSelfEcho(sessionId, text, mediaKindNow)) {
      rec.status = 'self';
      log('info', `忽略自己刚发出的回声：${text.slice(0, 40)}`);
      return;
    }
  }

  // ---- 别人发的表情：默认只忽略"纯表情"，也可以把表情从文字里剥掉 ----
  const emojiMode = String(cfgF.emoji_mode || 'pure');
  if (cfgF.drop_other_emoji !== false) {
    const kindNow = classifyMedia(text);
    if (!kindNow) {
      const stripped = stripEmojiTokens(text);
      if (!stripped) {
        rec.status = 'emoji';
        log('info', `忽略纯表情消息（${sender || contact}）：${text.slice(0, 30)}`);
        return;
      }
      if (emojiMode === 'strip' && stripped !== text) {
        log('info', `去掉表情字符：${text.slice(0, 30)} → ${stripped.slice(0, 30)}`);
        text = stripped;
        rec.text = stripped;
      }
    }
  }

  // 纯本地：问时间/日期就别浪费一次大模型调用，也别让它乱答
  if (/^(现在)?几点(了|啦|呀)?[?？!！。]*$/.test(text.replace(/\s+/g, '')) || /^(今天|现在)(是)?(几号|什么日子|周几|星期几)[?？!！。]*$/.test(text.replace(/\s+/g, ''))) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const wd = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()];
    const ans = `现在是 ${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${wd} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    rec.status = 'local-answer';
    log('info', `本地直答(${contact}): ${ans}`);
    void replyWithResult(contact, { ok: true, message: ans, files: [] }, { sessionId, contact, sender, isGroup });
    return;
  }

  const w = S.cfg.watch || {};
  const mm = S.cfg.mention || {};
  const g = groupCfgFor(sessionId);

  // ---- 图片 / 表情包：先分类，再决定怎么处理 ----
  const before = (S.recent.get(sessionId) || []).slice();
  const inScope = filterVerdict(sessionId, contact);
  const watchScope = inScope || !w.respect_filter;
  const mentionScope = inScope || !mm.respect_filter;

  const mediaKind = classifyMedia(text);
  if (mediaKind) {
    const mc = S.cfg.media || {};
    if (!mc.enabled || mc.action === 'ignore') { rec.status = 'media-ignored'; return; }
    if (mc.action === 'ack') {
      // 固定回执也要讲场合：私聊必回；群里只在这个会话本来就在聊（或开了自动回复/在名单内）时回
      const talking = !isGroup
        || inScope
        || g.auto_reply === true
        || S.buffers.has(`${sessionId}|${sender || 'anon'}`)
        || S.buffers.has(sessionId);
      if (talking) {
        rec.status = 'media-ack';
        log('info', `${sender || contact} 发了${mediaKind}，直接回执`);
        void replyWithResult(contact, { ok: true, message: mc.ack_text || '收到图片了', files: [] }, { sessionId, contact, sender, isGroup });
        return;
      }
    }
    // note / vision：转成一句文字，交给模型知道"有人发了图"
    text = `[${sender || '对方'}发了一张${mediaKind}]`;
    rec.media = mediaKind;
  }
  let enqueuedForAi = false;

  // ---- Agent 命令优先：/ppt /word /纪要 /ls /cat /write ----
  // 群里是否在叫我，取决于 mention.aliases（即使 @ 规则没启用也要能认出）
  const poked = detectPoke(text);
  const mentioned = detectMention(text) || poked;
  const agentAllowed = S.cfg.agent && S.cfg.agent.enabled
    && (S.cfg.agent.where === 'all' || !isGroup || !!mentioned);
  if (agentAllowed && parseCommand(text)) {
    rec.status = 'agent';
    rememberRecent(sessionId, { ts: Date.now(), sender: sender || contact, text, isGroup, contact });
    void handleAgent(text, { sessionId, contact, sender, isGroup, groupName, before });
    return;
  }

  // @ 触发（只认群里的 @，纯本地字符串匹配）
  if (mm.enabled && mentionScope && isGroup && g.at_enabled !== false) {
    const alias = mentioned;
    if (alias) {
      if (cooled(`mention:${sessionId}`, mm.cooldown_seconds)) {
        const ev = buildEvent(poked ? 'poke' : 'mention', { sessionId, contact, sender, text, isGroup, alias: poked ? '拍了拍' : alias, before, n: mm.context_count });
        S.triggerStats.mention++;
        enqueuedForAi = triggerEvent(ev, mm.action || 'both') || enqueuedForAi;
        activateSession(sessionId, contact, poked ? 'poke' : 'mention');
      } else {
        log('info', `@ 触发冷却中(${contact})`);
      }
    }
  }

  // 关键词被动监听
  const groupKwOn = !isGroup || g.keyword_enabled === true;
  if (w.enabled && watchScope && (!w.groups_only || isGroup) && groupKwOn) {
    const extraKw = isGroup ? (g.keywords || []) : [];
    const hits = localKeywordHits(text, extraKw);
    if (hits.length) {
      if (cooled(`kw:${sessionId}:${hits[0]}`, w.cooldown_seconds)) {
        const ev = buildEvent('keyword', { sessionId, contact, sender, text, isGroup, keyword: hits.join('、'), before, n: w.context_count });
        S.triggerStats.keyword++;
        enqueuedForAi = triggerEvent(ev, w.also_ai ? 'both' : 'webhook') || enqueuedForAi;
      } else {
        log('info', `关键词冷却中(${contact})`);
      }
    }
  }

  rememberRecent(sessionId, { ts: Date.now(), sender: sender || contact, text, isGroup, contact });

  // 已经因为 @ / 关键词进了 AI 管线，就别再标成"被过滤"了
  if (enqueuedForAi) { rec.status = 'triggered'; return; }

  const perSender = (S.cfg.group && S.cfg.group.per_sender !== false);
  const key = (isGroup && perSender) ? `${sessionId}|${sender || 'anon'}` : sessionId;
  const push = () => bufferMessage({ key, sessionId, contact, group: groupName, isGroup, sender, text, rec });

  if (isGroup) {
    // 1) 这个发言人正在跟 Bot 对话（刚 @ 过我）——后续消息/图片直接并进同一条
    if (S.buffers.has(key)) { push(); return; }
    // 2) 会话处于「持续激活」窗口内——群里的消息照常进管线
    const act = consumeActivation(sessionId);
    if (act) {
      log('info', `【持续激活】${act.contact} 第 ${act.used} 条：${(sender || '某人')} ${text.slice(0, 30)}（剩余 ${act.remaining}）`);
      if (activeCfg().push_webhook) {
        const ev = buildEvent('active', {
          sessionId, contact, sender, text, isGroup, keyword: '',
          before: (S.recent.get(sessionId) || []).slice(),
          n: Number((S.cfg.group || {}).context_count) || 5,
        });
        ev.activation = { used: act.used, remaining: act.remaining, until: act.until };
        S.events.unshift(ev);
        if (S.events.length > 200) S.events.length = 200;
        deliverWebhook(ev);
      }
      push();
      return;
    }
    // 3) 普通消息：不在名单就不理，group.auto_reply 打开才回
    if (!inScope) { rec.status = 'filtered'; S.stats.filtered++; log('info', `过滤 ${contact}: ${text.slice(0, 30)}`); return; }
    if (g.auto_reply === true) { push(); return; }
    rec.status = 'group-idle';
    return;
  }
  if (!inScope) { rec.status = 'filtered'; S.stats.filtered++; log('info', `过滤 ${contact}: ${text.slice(0, 30)}`); return; }
  if (!S.cfg.auto_reply) { rec.status = 'paused'; return; }
  push();
}

async function flushBuffer(key) {
  const b = S.buffers.get(key);
  if (!b || b.items.length === 0) return;
  S.buffers.delete(key);
  if (b.timer) clearTimeout(b.timer);

  const sessionId = b.sessionId;
  const contact = b.contact;
  const isGroup = !!b.isGroup;
  const g = groupCfgFor(sessionId);

  // 群聊限流：同一个群每分钟别刷太多
  if (isGroup && !groupRateOk(sessionId)) {
    for (const it of b.items) it.rec.status = 'throttled';
    log('warn', `群「${contact}」达到每分钟回复上限（${g.max_replies_per_minute || 6}），这条先不回`);
    return;
  }

  // 合并文本：群聊必须带上发言人，否则模型分不清谁说的
  const combined = b.items
    .map((i) => (isGroup && i.sender ? `${i.sender}：${i.text}` : i.text))
    .join('\n');
  const history = (S.history.get(sessionId) || []).slice(-Math.max(2, S.cfg.max_history) * 2);

  const globalPrompt = String(S.cfg.system_prompt || '').trim();
  const groupPrompt = isGroup ? String(g.system_prompt || '').trim() : '';
  let basePrompt = globalPrompt;
  if (groupPrompt) {
    basePrompt = g.ignore_global_prompt === false
      ? [globalPrompt, groupPrompt].filter(Boolean).join('\n\n')
      : groupPrompt;
  }
  const atEnabled = atPersonEnabled();
  if (isGroup) {
    const atLine = atEnabled
      ? '- 需要点名时，可以用「@某人」开头。'
      : '- 不要 @ 任何人，也不要写"@某某"，直接说话。';
    basePrompt += `\n\n【群聊规则】下面每条消息的格式是「发言人：内容」，可能有多个成员同时找你。
- 请针对每个人分别回应。
${atLine}
- 回复要短，不要复述别人的话，不要输出 emoji 表情符号。`;
  }
  const ctxSt = loadCtxState(sessionId);
  if (ctxSt && ctxSt.text) {
    basePrompt += `\n\n【前情提要（更早的对话已压缩）】\n${ctxSt.text}`;
  }
  basePrompt += '\n\n' + environmentPrompt({ contact, isGroup });

  let reply = '';
  let files = [];
  let visionUsed = false;

  // 0) 带图片的消息：优先把真图喂给视觉模型
  const hasMedia = b.items.some((it) => it.rec && it.rec.media);
  const mediaAction = (S.cfg.media || {}).action || 'vision';
  if (hasMedia && mediaAction === 'vision' && visionCfg().enabled) {
    try {
      const vmax = Math.max(1, Math.min(20, Number((S.cfg.vision || {}).max_images) || 4));
      const mediaCount = b.items.filter((it) => it.rec && it.rec.media).length || 1;
      // 只取"这批消息之后"的图，别把一堆旧图塞给模型
      const sinceTs = Math.floor((b.startedAt || Date.now() - 120000) / 1000) - 60;
      const imgs = await findRecentImages(sessionId, 900, Math.min(vmax, mediaCount + 1), sinceTs);
      if (imgs.length) {
        // 文本里别再说"某人发了一张图片"这种东西，否则模型会顺着说"我看不到"
        const plain = b.items.filter((it) => !(it.rec && it.rec.media))
          .map((it) => `${it.sender}：${it.text}`).join('\n');
        const who = [...b.senders].filter(Boolean).join('、') || '对方';
        const visionText = `${plain ? plain + '\n\n' : ''}（${who} 一共发了 ${imgs.length} 张图片，已经附在下面，请直接看着图回答，不要说看不到图）`;
        reply = await aiVision(basePrompt, history, visionText, imgs, sessionId);
        visionUsed = true;
        log('info', `视觉模型看了 ${imgs.length} 张图：${imgs.map((x) => path.basename(x.path)).join('、')}`);
      } else {
        log('info', '没取到图片文件（可能还没解密好），退回普通对话');
      }
    } catch (e) {
      log('warn', '视觉识别失败，退回普通对话：' + e.message);
    }
  }

  // 1) 先让模型自己判断要不要调工具（PPT/Word/纪要/读文件…）
  const nativeMode = aiNativeSearchMode();
  const wantsHistory = /(之前|上次|上回|历史|记录|说过|聊过|谁说的|那天|昨天|前天|上周|这个月|归档|查一下聊天)/.test(combined || '');
  const preferNative = !!nativeMode && (S.cfg.ai.search_priority || 'native') !== 'tools' && !needsLocalTools(combined) && !wantsHistory;
  if (preferNative) log('info', `走服务商自带联网（${nativeMode}），跳过多轮工具调用`);
  if (!visionUsed && !preferNative && S.cfg.agent && S.cfg.agent.enabled && S.cfg.agent.auto_tools && S.cfg.ai.type !== 'ollama') {
    try {
      const res = await runToolLoop(
        { sessionId, contact, sender: b.items[0].sender, isGroup, context: [] },
        combined,
        history,
        basePrompt,
      );
      if (res && (res.text || (res.files && res.files.length))) {
        reply = res.text || '';
        files = res.files || [];
      }
    } catch (e) {
      log('warn', `工具循环失败，回退到普通对话：${e.message}`);
    }
  }

  // 2) 没有用工具 / 工具没给出文字 -> 普通对话
  if (!reply) {
    try {
      reply = await aiReply(basePrompt, history, combined, sessionId);
    } catch (e) {
      S.stats.errors++;
      for (const it of b.items) it.rec.status = 'ai-error';
      log('error', `AI 调用失败(${contact}): ${e.message}`);
      return;
    }
  }
  // send_file 工具攒下来的本地文件
  const attachList = S.attach.get(sessionId) || [];
  if (attachList.length) {
    const extra = attachList.splice(0);
    S.attach.delete(sessionId);
    files = files.concat(extra);
    log('info', `本次附带 ${extra.length} 个本地文件：${extra.map((x) => path.basename(x)).join('、')}`);
  }
  if (!reply && !files.length) {
    for (const it of b.items) it.rec.status = 'ai-empty';
    log('warn', `AI 返回空内容(${contact})`);
    return;
  }

  // 3) 清洗 emoji + 限长
  if (reply) {
    reply = sanitizeReply(reply);
    const limit = isGroup
      ? Math.max(20, Number(S.cfg.reply && S.cfg.reply.max_chars_group) || 160)
      : Math.max(10, Number(S.cfg.max_reply_chars) || 120);
    if (reply.length > limit) reply = reply.slice(0, limit);
  }

  // 4) 群里点名回应，避免别人以为在跟自己说话
  if (reply && isGroup && !atEnabled) {
    const before = reply;
    reply = stripAtPrefix(reply);
    if (before !== reply) log('info', `开关关闭，已去掉模型自带的 @${before.slice(0, 20)}`);
  }
  const atPerson = atEnabled;
  if (reply && isGroup && atPerson && b.senders.size) {
    const names = [...b.senders].filter(Boolean).slice(0, 2);
    if (names.length && !names.some((n) => reply.startsWith('@' + n))) {
      reply = names.map((n) => '@' + n).join(' ') + ' ' + reply;
    }
  }

  S.stats.replied++;
  if (reply) rememberTurn(sessionId, 'user', combined);
  if (reply) rememberTurn(sessionId, 'assistant', reply);
  // 每轮结束后看看上下文有没有超标，超了就压缩并归档
  void maybeCompressContext(sessionId, { contact, group: b.group || (isGroup ? contact : ''), isGroup }).catch((e) => log('warn', '上下文压缩异常: ' + e.message));

  const out = pushMessage({ id: `out-${Date.now()}`, ts: Date.now(), sessionId, contact, group: b.group || '', text: reply || '（文件）', status: 'reply', outbound: true });
  for (const it of b.items) it.rec.status = 'answered';

  if (S.cfg.dry_run || !S.cfg.send.enabled) {
    out.status = 'dry-run';
    S.stats.dryrun++;
    log('info', `干跑（未发送）给 ${contact}: ${reply}${files.length ? ' + ' + files.length + ' 个文件' : ''}`);
    for (const f of files) log('info', `  附件：${f}`);
    return;
  }
  let anySent = false;
  if (reply) {
    const r = await wechatSend(contact, reply);
    if (r.ok) { anySent = true; S.stats.sent++; log('info', `已发送给 ${contact}: ${reply}`); }
    else { out.status = 'send-error'; S.stats.errors++; log('error', `发送失败(${contact}): ${r.detail}`); return; }
  }
  if (files.length && S.cfg.agent.send_files) {
    const cap = Math.max(1, Number(S.cfg.agent.max_files_per_reply) || 3);
    for (const f of files.slice(0, cap)) {
      const r1 = await wechatSendFile(contact, f);
      if (r1.ok) { anySent = true; log('info', `已发送文件给 ${contact}：${path.basename(f)}`); }
      else { S.stats.errors++; log('error', `文件发送失败(${contact}): ${r1.detail}`); }
    }
  }
  if (anySent) {
    out.status = 'sent';
    out.citations = (((S.lastAiMeta.get(sessionId) || {}).citations) || []).map((c) => c.url).slice(0, 5);
    rememberSelfSent(sessionId, reply, false);
  }

  // 5) 本地表情包：按回复内容挑一个附上
  if (anySent && reply && (S.cfg.sticker || {}).enabled === true) {
    try {
      const sp = await pickSticker(reply);
      if (sp) {
        const r2 = await wechatSendSticker(contact, sp);
        if (r2.ok) { log('info', `已补发表情包：${path.basename(sp)}`); rememberSelfSent(sessionId, '', true); }
        else log('warn', `表情包发送失败：${r2.detail}`);
      }
    } catch (e) {
      log('warn', '表情包流程出错：' + e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// local archiver: WeFlow's own local API -> NDJSON on disk (no cloud, no LLM)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 本地归档管理 + 检索（每个会话一个 ndjson，天然隔离）
// ---------------------------------------------------------------------------
// 归档目录扫描很贵（几百个文件夹 + 读首尾），加个带 TTL 的缓存，
// 归档写入 / 删除 / 压缩后主动失效
const _arcCache = { at: 0, items: null, dir: '' };
function invalidateArchiveCache() { _arcCache.at = 0; _arcCache.items = null; }
function archiveFilesCached() {
  const dir = archiveDir();
  const ttl = 90000;   // 90 秒
  if (_arcCache.items && _arcCache.dir === dir && Date.now() - _arcCache.at < ttl) return _arcCache.items;
  const items = archiveFiles();
  _arcCache.dir = dir;
  _arcCache.at = Date.now();
  _arcCache.items = items;
  return items;
}

function archiveFiles() {
  const dir = archiveDir();
  const out = [];
  const push = (sessionId, name, file, st, packedCount) => {
    let lines = 0;
    let lastTs = 0;
    let shownName = name || sessionId;
    try {
      // 只读头 4KB + 尾 8KB，避免把 231 个文件整个读两遍（会卡好几秒）
      const fd = fs.openSync(file, 'r');
      try {
        const size = st.size;
        const headLen = Math.min(4096, size);
        if (headLen > 0) {
          const head = Buffer.alloc(headLen);
          fs.readSync(fd, head, 0, headLen, 0);
          for (const line of head.toString('utf8').split('\n').slice(0, 5)) {
            if (!line.trim()) continue;
            try { const j = JSON.parse(line); if (j.session) { shownName = j.session; break; } } catch (_) {}
          }
        }
        const tailLen = Math.min(8192, size);
        let tailLines = 0;
        if (tailLen > 0) {
          const tail = Buffer.alloc(tailLen);
          fs.readSync(fd, tail, 0, tailLen, size - tailLen);
          const arr = tail.toString('utf8').split('\n').filter((x) => x.trim());
          tailLines = arr.length;
          for (let i = arr.length - 1; i >= Math.max(0, arr.length - 6); i--) {
            try { const j = JSON.parse(arr[i]); if (j.ts) { lastTs = Number(j.ts) * 1000; break; } } catch (_) {}
          }
        }
        // 条数用大小粗估（平均 ~180 字节/行），精确条数在"编辑"里能看到
        lines = Math.max(tailLines, Math.round(size / 180));
      } finally { try { fs.closeSync(fd); } catch (_) {} }
    } catch (_) {}
    out.push({
      sessionId, name: shownName, file, dir: path.dirname(file),
      sizeKb: Math.round(st.size / 1024), lines, mtime: st.mtimeMs, lastTs, packed: packedCount || 0,
    });
  };

  // ① 新布局：archive/<名字>__<id>/messages.ndjson
  try {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name === 'packed') continue;
      const folder = path.join(dir, d.name);
      const file = path.join(folder, 'messages.ndjson');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      const sid = d.name.includes('__') ? d.name.slice(d.name.lastIndexOf('__') + 2) : d.name;
      let packed = 0;
      try { const pd = path.join(folder, 'packed'); if (fs.existsSync(pd)) packed = fs.readdirSync(pd).filter((x) => x.endsWith('.zip')).length; } catch (_) {}
      push(sid, d.name.split('__')[0], file, st, packed);
    }
  } catch (_) {}

  // ② 旧布局：archive/<id>.ndjson（迁移前的，仍然列出来）
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.ndjson')) continue;
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      push(n.replace(/\.ndjson$/, ''), '', file, st, 0);
    }
  } catch (_) {}

  out.sort((a, b) => b.sizeKb - a.sizeKb);
  return out;
}
function archiveTotals(list) {
  const total = list.reduce((n, x) => n + x.sizeKb, 0);
  const lines = list.reduce((n, x) => n + x.lines, 0);
  return { sessions: list.length, sizeKb: total, lines };
}

/** 在一个/全部归档里按关键词和时间段搜索 */
function searchArchive(opts) {
  const q = String((opts && opts.query) || '').trim().toLowerCase();
  const sid = String((opts && opts.sessionId) || '').trim();
  const limit = Math.max(1, Math.min(200, Number(opts && opts.limit) || 30));
  const since = Number((opts && opts.since) || 0) / 1000;   // 秒
  const until = Number((opts && opts.until) || 0) / 1000;
  const list = sid ? archiveFiles().filter((x) => x.sessionId === sid) : archiveFiles();
  const hits = [];
  for (const f of list) {
    let txt = '';
    try { txt = fs.readFileSync(f.file, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n')) {
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j.type === 'context-compress') continue;
      const ts = Number(j.ts || 0);
      if (since && ts < since) continue;
      if (until && ts > until) continue;
      const text = String(j.text || '');
      if (q && !text.toLowerCase().includes(q) && !String(j.sender || '').toLowerCase().includes(q)) continue;
      hits.push({ sessionId: f.sessionId, name: f.name, ts, sender: j.sender || '', isSend: j.isSend, text: text.slice(0, 500) });
      if (hits.length > 4000) break;
    }
  }
  hits.sort((a, b) => b.ts - a.ts);
  return { query: q, scanned: list.length, matched: hits.length, items: hits.slice(0, limit) };
}

/** 某个会话的归档目录：archive/<可读名>__<短id>/ */
function archiveSessionDir(sessionId, name) {
  const base = archiveDir();
  const sid = String(sessionId || 'unknown');
  const short = sid.replace(/[\\/:*?"<>|]/g, '_');
  // 已经存在就直接用（避免改名导致分裂）
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (d.name.endsWith('__' + short)) return path.join(base, d.name);
    }
  } catch (_) {}
  const disp = safeName(name || sid).slice(0, 40) || '会话';
  const full = path.join(base, `${disp}__${short}`);
  try { fs.mkdirSync(full, { recursive: true }); } catch (_) {}
  try {
    const meta = path.join(full, 'meta.json');
    if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ sessionId: sid, name: name || sid, createdAt: Date.now() }, null, 1), 'utf8');
  } catch (_) {}
  return full;
}

/** 会话的聊天记录文件路径（新布局：文件夹里的 messages.ndjson） */
function archiveSessionFile(sessionId, name) {
  return path.join(archiveSessionDir(sessionId, name), 'messages.ndjson');
}

/** 一次性迁移：archive/<id>.ndjson -> archive/<名字>__<id>/messages.ndjson */
// ---------------------------------------------------------------------------
// 关掉 WeFlow 自带的数据收集与本地统计
//   cloud:*           = CloudControl 上报（页面、平台版本，带重试与熔断）
//   analytics:*        = 本地统计聚合（全库扫消息，吃内存）
//   groupAnalytics:*   = 群成员统计聚合（同上）
//   annualReport:*     = 年度报告（一次性大聚合）
// 做法：劫持 ipcMain.handle，凡是这些通道一律返回空结果，
//       既不发网络请求，也不让聚合跑起来。
// ---------------------------------------------------------------------------
function killTelemetry() {
  const blocked = new Map();
  const empty = (data) => ({ success: true, disabled: true, data });
  blocked.set('cloud:init', { success: true, disabled: true });
  blocked.set('cloud:recordPage', { success: true, disabled: true });
  blocked.set('cloud:getLogs', []);
  blocked.set('analytics:getOverallStatistics', empty(null));
  blocked.set('analytics:getContactRankings', empty([]));
  blocked.set('analytics:getTimeDistribution', empty([]));
  blocked.set('analytics:getExcludedUsernames', empty([]));
  blocked.set('analytics:getExcludeCandidates', empty([]));
  blocked.set('analytics:setExcludedUsernames', empty([]));
  blocked.set('cache:clearAnalytics', empty(null));
  for (const n of [
    'getGroupChats', 'getGroupMembers', 'getGroupMembersPanelData', 'getGroupMessageRanking',
    'getGroupActiveHours', 'getGroupMediaStats', 'getGroupMemberAnalytics', 'getGroupMemberMessages',
    'exportGroupMembers', 'exportGroupMemberMessages',
  ]) blocked.set('groupAnalytics:' + n, empty([]));
  for (const n of ['generateReport', 'getAvailableYears', 'startAvailableYearsLoad', 'cancelAvailableYearsLoad', 'exportImages']) {
    blocked.set('annualReport:' + n, empty(null));
  }

  const { ipcMain } = require('electron');
  const origHandle = ipcMain.handle.bind(ipcMain);
  // 只拦截"之后"的注册。千万不能在这里抢先注册 stub ——
  // app 自己随后再注册同一通道时 Electron 会抛 "second handler"，启动直接卡住。
  ipcMain.handle = function (channel, fn) {
    if (blocked.has(channel)) {
      const val = blocked.get(channel);
      try { ipcMain.removeHandler(channel); } catch (_) {}
      return origHandle(channel, async () => val);
    }
    return origHandle(channel, fn);
  };

  // 已经开始跑的统计聚合，等 app 启动完再统一换掉（那时不会再有新注册）
  const swap = () => {
    let n = 0;
    for (const entry of blocked) {
      try {
        ipcMain.removeHandler(entry[0]);
        origHandle(entry[0], async () => entry[1]);
        n++;
      } catch (_) {}
    }
    log('info', '已关闭 WeFlow 自带数据收集与本地统计（' + n + ' 个通道）');
    try {
      const cache = path.join(app.getPath('documents'), 'WeFlow', 'analytics_cache.json');
      if (fs.existsSync(cache)) { fs.unlinkSync(cache); log('info', '已删除本地统计缓存 analytics_cache.json'); }
    } catch (_) {}
  };
  setTimeout(swap, 6000);
}

function migrateArchiveToFolders() {
  const dir = archiveDir();
  const marker = path.join(dir, '_layout-v2.json');
  if (fs.existsSync(marker)) return { skipped: true };
  let moved = 0;
  const detail = [];
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.ndjson')) continue;
      const sid = n.replace(/\.ndjson$/, '');
      const from = path.join(dir, n);
      // 找首行里的会话名
      let name = sid;
      try {
        const first = fs.readFileSync(from, 'utf8').split('\n').find(Boolean);
        const j = JSON.parse(first);
        if (j && j.session) name = j.session;
      } catch (_) {}
      const folder = archiveSessionDir(sid, name);
      const to = path.join(folder, 'messages.ndjson');
      if (fs.existsSync(to)) {
        // 目标已存在：把旧内容追加进去，再删旧文件
        try {
          const old = fs.readFileSync(from, 'utf8');
          fs.appendFileSync(to, old, 'utf8');
          fs.unlinkSync(from);
          moved++;
          detail.push(`${n} → ${path.basename(folder)}/messages.ndjson（合并）`);
        } catch (e) { detail.push(`${n} 合并失败: ${e.message}`); }
      } else {
        try { fs.renameSync(from, to); moved++; detail.push(`${n} → ${path.basename(folder)}/messages.ndjson`); }
        catch (e) { detail.push(`${n} 移动失败: ${e.message}`); }
      }
    }
    // 旧的 packed 目录里按会话前缀的 zip 也挪进去
    const oldPacked = path.join(dir, 'packed');
    if (fs.existsSync(oldPacked)) {
      for (const z of fs.readdirSync(oldPacked)) {
        if (!z.endsWith('.zip')) continue;
        const sid = z.split('-').slice(0, -1).join('-');
        const hitDir = fs.readdirSync(dir).find((d) => d.endsWith('__' + sid));
        if (!hitDir) continue;
        const target = path.join(dir, hitDir, 'packed');
        try { fs.mkdirSync(target, { recursive: true }); fs.renameSync(path.join(oldPacked, z), path.join(target, z)); } catch (_) {}
      }
    }
    fs.writeFileSync(marker, JSON.stringify({ at: Date.now(), moved, detail }, null, 1), 'utf8');
  } catch (e) {
    log('error', '归档目录迁移失败: ' + e.message);
  }
  if (moved) log('info', `归档目录已按人分文件夹：迁移 ${moved} 个会话`);
  return { moved, detail };
}

function archiveDir() {
  const a = S.cfg.archive || {};
  const d = a.dir && String(a.dir).trim() ? String(a.dir).trim() : PATHS.archive;
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

function safeName(s) {
  return String(s || 'unknown').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120) || 'unknown';
}

function cursorsFile() { return path.join(archiveDir(), '_cursors.json'); }

function loadCursors() {
  try {
    if (fs.existsSync(cursorsFile())) return JSON.parse(fs.readFileSync(cursorsFile(), 'utf8'));
  } catch (_) {}
  return {};
}

function cursorOf(cursors, id) {
  const v = cursors[id];
  if (typeof v === 'number') return { ts: v, lastRun: 0, pending: 0, rotations: 0 };
  if (v && typeof v === 'object') {
    return {
      ts: Number(v.ts || 0),
      lastRun: Number(v.lastRun || 0),
      pending: Number(v.pending || 0),
      rotations: Number(v.rotations || 0),
    };
  }
  return { ts: 0, lastRun: 0, pending: 0, rotations: 0 };
}

function packedDir() {
  const d = path.join(archiveDir(), 'packed');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

/** 把某个会话的热数据压缩成 zip 包，然后清空热文件 */
function rotateSession(sessionId, displayName) {
  const safe = safeName(sessionId);
  const hot = path.join(archiveDir(), safe + '.ndjson');
  if (!fs.existsSync(hot)) return { ok: false, message: '没有可压缩的归档文件' };
  let size = 0;
  try { size = fs.statSync(hot).size; } catch (_) {}
  if (!size) return { ok: false, message: '归档文件是空的' };
  try {
    const { zip } = require(path.join(PATHS.lib, 'zip.js'));
    const buf = fs.readFileSync(hot);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '');
    const out = path.join(packedDir(), `${safe}-${stamp}.zip`);
    fs.writeFileSync(out, zip([{ name: `${safe}.ndjson`, data: buf }]));
    fs.writeFileSync(hot, '', 'utf8');
    const cursors = loadCursors();
    const c = cursorOf(cursors, sessionId);
    c.pending = 0;
    c.rotations += 1;
    cursors[sessionId] = c;
    saveCursors(cursors);
    S.archive.cursors = cursors;
    log('info', `已压缩归档 ${displayName || sessionId}：${Math.round(size / 1024)} KB → ${path.basename(out)}（第 ${c.rotations} 次）`);
    return { ok: true, message: `已压缩 ${Math.round(size / 1024)} KB → ${path.basename(out)}`, file: out };
  } catch (e) {
    log('error', `压缩失败 ${sessionId}: ${e.message}`);
    return { ok: false, message: e.message };
  }
}

function effectiveArchiveRule(sessionId, name) {
  const a = S.cfg.archive || {};
  const rules = Array.isArray(a.rules) ? a.rules : [];
  const r = rules.find((x) => x && String(x.id) === String(sessionId));
  if (r) {
    return {
      id: sessionId,
      name: r.name || name,
      enabled: r.enabled !== false,
      interval_hours: Number(r.interval_hours || 0),
      max_records: Number(r.max_records || 0),
      explicit: true,
    };
  }
  return {
    id: sessionId,
    name,
    enabled: true,
    interval_hours: Number(a.default_interval_hours || 0),
    max_records: Number(a.default_max_records || 0),
    explicit: false,
  };
}

function saveCursors(c) {
  try { fs.writeFileSync(cursorsFile(), JSON.stringify(c), 'utf8'); } catch (_) {}
}

async function wfGet(p) {
  const base = String(S.cfg.weflow.base_url || '').replace(/\/+$/, '');
  const tok = S.cfg.weflow.access_token || '';
  const sep = p.includes('?') ? '&' : '?';
  const r = await requestJson(`${base}${p}${sep}access_token=${encodeURIComponent(tok)}`, { timeout: 30000 });
  if (r.status !== 200) throw new Error(`WeFlow API ${r.status}: ${r.text.slice(0, 160)}`);
  return JSON.parse(r.text);
}

async function runArchive(reason, onlySessionId) {
  const a = S.cfg.archive || {};
  if (reason !== 'manual' && reason !== '单聊规则' && !a.enabled) return { skipped: 'disabled' };
  if (S.archive.running) return { skipped: 'running' };
  if (!S.cfg.weflow.access_token) { log('warn', '归档跳过：没有 access_token'); return { skipped: 'no-token' }; }

  S.archive.running = true;
  const t0 = Date.now();
  const stats = { reason, at: Date.now(), sessions: 0, fetched: 0, appended: 0, skipped: 0, errors: 0, rotated: 0 };
  try {
    const dir = archiveDir();
    S.archive.dir = dir;
    const cursors = loadCursors();
    const ses = await wfGet('/api/v1/sessions?limit=1000');
    const all = ses.sessions || [];
    const byId = new Map(all.map((s) => [String(s.username), s]));
    const rules = (Array.isArray(a.rules) ? a.rules : []).filter((r) => r && r.id);

    let list;
    if (onlySessionId) {
      const s = byId.get(String(onlySessionId)) || { username: onlySessionId, displayName: onlySessionId, lastTimestamp: 0 };
      list = [s];
    } else if (reason === '单聊规则') {
      // 只跑「到点」的单独归档规则
      list = [];
      for (const r of rules) {
        if (r.enabled === false) continue;
        const c = cursorOf(cursors, r.id);
        const hours = Number(r.interval_hours || 0);
        if (!hours) continue;
        if (Date.now() - (c.lastRun || 0) < hours * 3600e3) continue;
        list.push(byId.get(String(r.id)) || { username: r.id, displayName: r.name || r.id, lastTimestamp: 0 });
      }
      if (!list.length) { S.archive.running = false; return { skipped: 'no-due-rule' }; }
    } else {
      list = all.slice();
      if ((a.scope || 'whitelist') === 'whitelist' && S.cfg.filter.mode === 'whitelist' && (S.cfg.filter.list || []).length) {
        list = list.filter((s) => filterVerdict(s.username, s.displayName));
      }
      // 单独规则的会话即使不在名单里也要归档
      for (const r of rules) {
        if (r.enabled === false) continue;
        const id = String(r.id);
        if (!list.some((s) => String(s.username) === id)) {
          list.push(byId.get(id) || { username: id, displayName: r.name || id, lastTimestamp: 0 });
        }
      }
      list = list.slice(0, Math.max(1, Number(a.max_sessions_per_run) || 400));
    }
    const limit = Math.min(1000, Math.max(20, Number(a.limit_per_session) || 200));

    for (const s of list) {
      const rule = effectiveArchiveRule(s.username, s.displayName);
      if (!rule.enabled) { stats.skipped++; continue; }
      stats.sessions++;
      const cur = cursorOf(cursors, s.username);
      if (cur.ts && Number(s.lastTimestamp || 0) <= cur.ts) {
        stats.skipped++;
        cur.lastRun = cur.lastRun || Date.now();
        cursors[s.username] = cur;
        continue;
      }
      try {
        const r = await wfGet(`/api/v1/messages?talker=${encodeURIComponent(s.username)}&limit=${limit}&start=${cur.ts}`);
        const msgList = r.messages || [];
        stats.fetched += msgList.length;
        const rows = msgList.filter((m) => Number(m.createTime || 0) > cur.ts);
        if (rows.length) {
          const lines = rows.map((m) => JSON.stringify({
            ts: Number(m.createTime || 0),
            sessionId: s.username,
            session: s.displayName || s.username,
            sender: m.senderUsername || '',
            isSend: m.isSend === 1 ? 1 : 0,
            type: m.localType,
            id: m.localId,
            text: m.content,
          })).join('\n') + '\n';
          fs.appendFileSync(archiveSessionFile(s.username, s.displayName || s.username), lines, 'utf8');
          cur.ts = rows.reduce((mx, m) => Math.max(mx, Number(m.createTime || 0)), cur.ts);
          cur.pending += rows.length;
          stats.appended += rows.length;
          invalidateArchiveCache();
        }
        cur.lastRun = Date.now();
        cursors[s.username] = cur;
        // 到达缓存上限 -> 自动压缩归档
        if (rule.max_records > 0 && cur.pending >= rule.max_records) {
          const rr = rotateSession(s.username, s.displayName);
          if (rr.ok) stats.rotated++;
          S.archive.cursors = cursors;
        }
      } catch (e) {
        stats.errors++;
        log('error', `归档失败 ${s.displayName || s.username}: ${e.message}`);
      }
    }
    saveCursors(cursors);
    S.archive.cursors = cursors;
    S.archive.totalRows += stats.appended;
    S.archive.lastRun = Date.now();
    S.archive.lastStats = stats;
    S.archive.error = null;
    log('info', `归档完成(${reason}${onlySessionId ? ':' + onlySessionId : ''})：会话 ${stats.sessions}，新写入 ${stats.appended} 条，压缩 ${stats.rotated} 个，跳过 ${stats.skipped}，错误 ${stats.errors}，用时 ${Date.now() - t0}ms`);
  } catch (e) {
    S.archive.error = e.message;
    log('error', '归档任务失败: ' + e.message);
  } finally {
    S.archive.running = false;
  }
  return S.archive.lastStats;
}

function scheduleArchive() {
  for (const t of ['archiveTimer', 'archiveRuleTimer', 'archiveBootTimer']) {
    if (S[t]) { try { clearInterval(S[t]); clearTimeout(S[t]); } catch (_) {} S[t] = null; }
  }
  const a = S.cfg.archive || {};
  if (!a.enabled) return;
  const ms = Math.max(1, Number(a.interval_minutes) || 30) * 60000;
  S.archiveTimer = setInterval(() => runArchive('定时'), ms);
  if (S.archiveTimer.unref) S.archiveTimer.unref();
  // 每 60 秒检查一次「单独归档」规则有没有到点
  S.archiveRuleTimer = setInterval(() => runArchive('单聊规则'), 60000);
  if (S.archiveRuleTimer.unref) S.archiveRuleTimer.unref();
  S.archiveBootTimer = setTimeout(() => runArchive('启动'), 20000);
  if (S.archiveBootTimer.unref) S.archiveBootTimer.unref();
  log('info', `归档计划已启用：主任务每 ${Math.round(ms / 60000)} 分钟，单独规则 ${(a.rules || []).length} 条，目录=${archiveDir()}`);
}

// ---------------------------------------------------------------------------
// SSE client
// ---------------------------------------------------------------------------
function stopSse(clearBuffers) {
  S.sseGen = (S.sseGen || 0) + 1;          // 让旧连接的回调全部失效
  if (S.sse) {
    const old = S.sse;
    S.sse = null;
    try { old.removeAllListeners('error'); } catch (_) {}
    try { old.removeAllListeners('close'); } catch (_) {}
    try { old.destroy(); } catch (_) {}
  }
  S.conn.connected = false;
  // 只有用户主动"停止监听"才丢弃待合并的消息；
  // 断线重连时必须保留，否则网络抖一下这条 @ 就永远丢了
  if (clearBuffers) {
    for (const [k, b] of S.buffers) { if (b.timer) clearTimeout(b.timer); S.buffers.delete(k); }
    S.buffers.clear();
  }
}

function startSse() {
  stopSse(false);
  const gen = S.sseGen || 0;
  const stale = () => gen !== (S.sseGen || 0);
  const { base_url, access_token } = S.cfg.weflow;
  if (!/^https?:\/\//.test(base_url || '')) { log('error', 'WeFlow 地址无效: ' + base_url); return; }
  const url = `${base_url.replace(/\/+$/, '')}/api/v1/push/messages?access_token=${encodeURIComponent(access_token || '')}`;
  let u;
  try { u = new URL(url); } catch (e) { log('error', '推送地址无效: ' + e.message); return; }
  const lib = u.protocol === 'https:' ? https : http;
  S.conn.attempts++;
  log('info', `连接 WeFlow 推送流 (第 ${S.conn.attempts} 次) ...`);

  const req = lib.request(
    { method: 'GET', hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' } },
    (res) => {
      if (res.statusCode !== 200) {
        S.conn.lastError = `HTTP ${res.statusCode}`;
        log('error', `推送流握手失败: HTTP ${res.statusCode}（请检查 access_token / 端口）`);
        res.resume();
        scheduleReconnect();
        return;
      }
      S.conn.connected = true;
      S.conn.since = Date.now();
      S.conn.lastError = null;
      log('info', '推送流已连接，等待消息');
      res.setEncoding('utf8');
      let buf = '';
      let evt = null;
      let data = [];
      res.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line === '') {
            if (data.length) {
              const raw = data.join('\n');
              S.conn.lastEventAt = Date.now();
              try {
                const j = JSON.parse(raw);
                try { handlePush(j); } catch (e) { log('error', '处理推送失败: ' + e.message); }
              } catch (e) {
                log('warn', '无法解析推送数据: ' + raw.slice(0, 120));
              }
            }
            evt = null;
            data = [];
            continue;
          }
          if (line.startsWith(':')) { S.conn.lastPingAt = Date.now(); continue; }
          if (line.startsWith('event:')) evt = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
      });
      res.on('end', () => { if (stale()) return; log('warn', '推送流被服务端关闭'); scheduleReconnect(); });
      res.on('error', (e) => { if (stale()) return; log('error', '推送流出错: ' + e.message); scheduleReconnect(); });
    }
  );
  req.on('error', (e) => {
    if (stale()) return;                    // 我们自己销毁旧连接时不要再排重连
    S.conn.connected = false;
    S.conn.lastError = e.message;
    log('error', `推送连接失败: ${e.message}`);
    scheduleReconnect();
  });
  req.end();
  S.sse = req;
}

let reconnectTimer = null;
function scheduleReconnect() {
  S.conn.connected = false;
  if (reconnectTimer) return;
  const delay = Math.min(3000 * Math.max(1, S.conn.attempts), 15000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; if (S.started) startSse(); }, delay);
}

// ---------------------------------------------------------------------------
// local API for the injected panel
// ---------------------------------------------------------------------------
function stateSnapshot() {
  return {
    conn: S.conn,
    cfg: S.cfg,
    stats: S.stats,
    started: S.started,
    messages: S.messages.slice(0, 120),
    logs: S.logs.slice(-160),
    events: S.events.slice(0, 60),
    triggerStats: S.triggerStats,
    toolStats: S.toolStats,
    stickerScan: S.stickerScan,
    contexts: (function () {
      const out = [];
      for (const sid of S.history.keys()) {
        try {
          const u = ctxUsage(sid);
          out.push({
            sessionId: sid,
            messages: u.messages,
            total: u.total,
            max: u.max,
            percent: u.percent,
            compressed: u.compressed,
            summaryLen: (u.summary || '').length,
          });
        } catch (_) {}
      }
      out.sort((a, b) => b.total - a.total);
      return out.slice(0, 8);
    })(),
    contextCfg: ctxCfg(),
    schedule: {
      enabled: (S.cfg.schedule || {}).enabled !== false,
      rules: schedRules().map((r) => ({
        id: r.id, name: r.name, enabled: r.enabled !== false, contact: r.contact,
        type: r.type || 'daily', at: r.at || '', days: r.days || [], day: r.day || 1,
        atISO: r.atISO || '', everyMinutes: r.everyMinutes || 60,
        mode: r.mode || 'text', text: r.text || '', prompt: r.prompt || '',
        atPerson: !!r.atPerson, jitterSeconds: Number(r.jitterSeconds) || 0,
        catchUpMinutes: Number(r.catchUpMinutes) || 0, endAt: Number(r.endAt) || 0,
        dryRun: !!r.dryRun, runs: Number(r.runs) || 0, maxRuns: Number(r.maxRuns) || 0,
        lastRunAt: Number(r.lastRunAt) || 0, nextAt: nextSlot(r, Date.now()),
      })),
      history: S.scheduleHistory.slice(0, 12),
    },
    activeSessions: activeSnapshot(),
    archive: {
      running: S.archive.running,
      lastRun: S.archive.lastRun,
      lastStats: S.archive.lastStats,
      totalRows: S.archive.totalRows,
      error: S.archive.error,
      dir: S.archive.dir || PATHS.archive,
      sessionCursors: Object.keys(S.archive.cursors || {}).length,
    },
    recentSessions: S.recent.size,
    plugins: S_PLUGINS.list,
    pluginsScannedAt: S_PLUGINS.scannedAt,
    pluginsError: S_PLUGINS.lastError,
    workspace: workspaceDir(),
    port: S.port,
    version: app.getVersion ? app.getVersion() : '',
    paths: { config: PATHS.cfgFile, logs: PATHS.logs, archive: PATHS.archive, out: PATHS.out, workspace: workspaceDir(), plugins: PATHS.pluginDirs },
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function startApiServer() {
  const server = http.createServer(async (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'content-type,x-wfai',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.headers['x-wfai'] !== S.apiToken) { res.writeHead(401, cors); return res.end(JSON.stringify({ ok: false, error: 'unauthorized' })); }
    const url = new URL(req.url, `http://127.0.0.1:${S.port}`);
    try {
      if (req.method === 'GET' && url.pathname === '/state') {
        res.writeHead(200, cors);
        return res.end(JSON.stringify(stateSnapshot()));
      }
      if (req.method === 'POST' && url.pathname === '/api') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const result = await handleUiOp(body);
        res.writeHead(200, cors);
        return res.end(JSON.stringify({ ok: true, result, state: stateSnapshot() }));
      }
      res.writeHead(404, cors);
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    } catch (e) {
      log('error', '面板请求失败: ' + e.message);
      try { res.writeHead(500, cors); res.end(JSON.stringify({ ok: false, error: e.message })); } catch (_) {}
    }
  });
  server.on('error', (e) => log('error', '本地面板服务启动失败: ' + e.message));
  server.listen(0, '127.0.0.1', () => {
    S.port = server.address().port;
    S.server = server;
    log('info', `面板服务已启动 127.0.0.1:${S.port}`);
    try {
      fs.writeFileSync(path.join(PATHS.cfgDir, 'api.json'), JSON.stringify({ port: S.port, token: S.apiToken, pid: process.pid }, null, 2), 'utf8');
    } catch (_) {}
  });
}

async function handleUiOp(body) {
  switch (body.op) {
    case 'save':
      saveConfig(body.cfg || {});
      scheduleArchive();
  startSchedule();
      return { saved: true };
    case 'start':
      S.started = true;
      saveConfig({ ...(body.cfg || {}), listen: true });
      startSse();
      return { started: true };
    case 'stop':
      S.started = false;
      saveConfig({ listen: false });
      stopSse(true);
      log('info', '已停止监听');
      return { started: false };
    case 'reconnect':
      S.started = true;
      saveConfig({ listen: true });
      startSse();
      return { started: true };
    case 'clear':
      S.messages.length = 0;
      S.logs.length = 0;
      return { cleared: true };
    case 'clearStats':
      S.stats = { received: 0, replied: 0, sent: 0, dryrun: 0, filtered: 0, errors: 0 };
      return S.stats;
    case 'simulate': {
      const payload = body.payload || {
        event: 'message.new',
        sessionId: body.sessionId || 'sim-' + Date.now(),
        messageKey: 'sim-' + Date.now(),
        sourceName: body.contact || '模拟联系人',
        groupName: body.group || '',
        content: body.text || '这是一条模拟消息',
      };
      handlePush(payload);
      return { injected: true, payload };
    }
    case 'testAi': {
      const t0 = Date.now();
      const reply = await aiReply(S.cfg.system_prompt + '\n\n' + environmentPrompt({ contact: '本地自测', isGroup: false }), [], body.text || '你好，在吗？');
      return { reply, ms: Date.now() - t0 };
    }
    case 'testSend': {
      const contact = body.contact || '';
      const text = body.text || `测试消息 ${new Date().toLocaleTimeString()}`;
      if (!contact) throw new Error('请填写微信联系人/群名');
      const r = await wechatSend(contact, text);
      return r;
    }
    case 'openConfig': {
      const { shell } = require('electron');
      shell.showItemInFolder(PATHS.cfgFile);
      return { path: PATHS.cfgFile };
    }
    case 'openArchive': {
      const { shell } = require('electron');
      const dir = archiveDir();
      const r = await shell.openPath(dir);
      return { path: dir, error: r || null };
    }
    case 'openPath': {
      const { shell } = require('electron');
      const target = String(body.path || '');
      const d = body.allowOutside ? { ok: true, abs: target } : accessDecision(target, 'read');
      if (!d.ok) throw new Error(d.reason);
      const r = await shell.openPath(d.abs);
      return { path: d.abs, error: r || null };
    }
    case 'scanPlugins':
      return { plugins: scanPlugins() };
    case 'setPlugin': {
      const id = String(body.id || '');
      if (!id) throw new Error('缺少插件 id');
      const disabled = new Set((S.cfg.plugins && S.cfg.plugins.disabled) || []);
      if (body.enabled) disabled.delete(id); else disabled.add(id);
      saveConfig({ plugins: { disabled: [...disabled] } });
      scanPlugins();
      return { plugins: S_PLUGINS.list };
    }
    case 'openPlugins': {
      const { shell } = require('electron');
      const dir = PATHS.pluginDirs[PATHS.pluginDirs.length - 1];
      fs.mkdirSync(dir, { recursive: true });
      const r = await shell.openPath(dir);
      return { path: dir, error: r || null };
    }
    case 'detectAliases': {
      // 自动找出「我在各群里的昵称」——群消息里 @ 的就是这个名字
      const wfCfgPath = path.join(app.getPath('userData'), 'WeFlow-config.json');
      let myWxid = '';
      try {
        const wf = JSON.parse(fs.readFileSync(wfCfgPath, 'utf8'));
        myWxid = String(wf.myWxid || '');
      } catch (_) {}
      if (!myWxid) throw new Error('读不到 WeFlow 的 myWxid');
      const bare = myWxid.startsWith('wxid_') ? (myWxid.match(/^(wxid_[^_]+)/i) || [myWxid])[1] : myWxid;
      const ses = await wfGet('/api/v1/sessions?limit=400');
      const groups = (ses.sessions || []).filter((s) => String(s.username).endsWith('@chatroom')).slice(0, 40);
      const found = new Map();
      let scanned = 0;
      for (const g of groups) {
        if (body.sessionId && body.sessionId !== g.username) continue;
        try {
          const r = await wfGet(`/api/v1/group-members?chatroomId=${encodeURIComponent(g.username)}`);
          scanned++;
          const me = (r.members || []).find((m) => String(m.wxid || '').toLowerCase().startsWith(bare.toLowerCase()));
          if (!me) continue;
          for (const v of [me.groupNickname, me.displayName, me.nickname, me.remark]) {
            const s = String(v || '').trim();
            if (s) found.set(s, (found.get(s) || 0) + 1);
          }
        } catch (_) {}
      }
      const aliases = [...found.keys()].sort((a, b) => (found.get(b) - found.get(a)));
      if (aliases.length) {
        const cur = new Set((S.cfg.mention.aliases || []).map((x) => String(x).trim()).filter(Boolean));
        for (const a of aliases) cur.add(a);
        saveConfig({ mention: { aliases: [...cur] } });
      }
      log('info', `自动识别群昵称：扫描 ${scanned} 个群，候选 ${aliases.length} 个（${aliases.join('、') || '无'}）`);
      return { myWxid: bare, scanned, aliases, saved: S.cfg.mention.aliases };
    }
    case 'pickFile': {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({
        title: body.title || '选择文件',
        properties: ['openFile'],
        filters: body.filters || [{ name: '所有文件', extensions: ['*'] }],
      });
      return { path: (r.filePaths || [])[0] || null, canceled: r.canceled };
    }
    case 'pickDir': {
      const { dialog } = require('electron');
      // defaultPath 决定对话框从哪儿打开；不传就会永远停在系统默认位置
      const opts = { title: body.title || '选择文件夹', properties: ['openDirectory'] };
      let def = String(body.defaultPath || '').trim();
      if (!def) {
        const sd = S.cfg.sticker || {};
        if (body.kind === 'sticker') def = String(sd.dir || '').trim();
      }
      if (def) {
        try { if (fs.existsSync(def)) opts.defaultPath = def; } catch (_) {}
      }
      const r = await dialog.showOpenDialog(opts);
      return { path: (r.filePaths || [])[0] || null, canceled: r.canceled };
    }
    case 'installPlugin': {
      const source = String(body.source || 'zip');
      let buf = null;
      let hint = '';
      if (source === 'zip') {
        if (!body.path) throw new Error('没有选择 zip 文件');
        buf = fs.readFileSync(body.path);
        hint = path.basename(body.path, path.extname(body.path));
      } else if (source === 'url') {
        const url = String(body.url || '').trim();
        if (!url) throw new Error('没有填 URL');
        buf = await downloadZipSmart(url);
        hint = (url.split('/').filter(Boolean).pop() || 'plugin').replace(/\.zip$/i, '');
      } else if (source === 'dir') {
        if (!body.path) throw new Error('没有选择文件夹');
        const srcDir = String(body.path);
        const mp = path.join(srcDir, 'plugin.json');
        if (!fs.existsSync(mp)) throw new Error(`文件夹里没有 plugin.json：${srcDir}`);
        const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
        const id = String(manifest.id || path.basename(srcDir)).replace(/[^\w.\-\u4e00-\u9fa5]/g, '-');
        const target = path.join(PATHS.pluginDirs[PATHS.pluginDirs.length - 1], id);
        if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
        copyDir(srcDir, target);
        scanPlugins();
        log('info', `已从文件夹安装插件 ${id} → ${target}`);
        return { id, target, name: String(manifest.name || id), commands: manifest.commands || [], files: -1 };
      } else {
        throw new Error('未知来源: ' + source);
      }
      const res = installPluginFromZip(buf, hint);
      scanPlugins();
      log('info', `已安装插件 ${res.id}（${res.files} 个文件）→ ${res.target}`);
      return res;
    }
    case 'uninstallPlugin': {
      const id = String(body.id || '').trim();
      if (!id) throw new Error('缺少插件 id');
      const p = findPluginAnyState(id);
      if (!p) throw new Error('找不到插件 ' + id);
      if (p.source === 'builtin') throw new Error('内置插件不能卸载，只能用开关停用');
      fs.rmSync(p.dir, { recursive: true, force: true });
      scanPlugins();
      log('info', `已卸载插件 ${id}`);
      return { removed: p.dir };
    }
    case 'newPluginTemplate': {
      const dir = path.join(PATHS.pluginDirs[PATHS.pluginDirs.length - 1], 'demo-echo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
        id: 'demo-echo',
        name: '示例插件',
        version: '1.0.0',
        description: '把收到的参数原样回显，用来验证插件链路',
        commands: ['echo', '回显'],
        usage: '/echo 随便写点什么',
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'index.js'), `'use strict';
// ctx 字段：text / args / sessionId / contact / sender / isGroup / context
//          libDir / outDir / archiveDir / workspace / accessMode / now
// 返回：{ ok, message, files? }
module.exports.run = async function run(ctx) {
  return { ok: true, message: '你说的是：' + (ctx.args || ctx.text || '（空）') };
};
`, 'utf8');
      scanPlugins();
      return { dir };
    }
    case 'archiveSession': {
      const stats = await runArchive('单聊', String(body.sessionId || ''));
      return stats || { skipped: true };
    }
    case 'rotateSession': {
      const id = String(body.sessionId || '');
      if (!id) throw new Error('缺少 sessionId');
      return rotateSession(id, body.name || id);
    }
    case 'archiveRuleState': {
      const cursors = loadCursors();
      const a = S.cfg.archive || {};
      const rules = (Array.isArray(a.rules) ? a.rules : []).map((r) => {
        const c = cursorOf(cursors, r.id);
        return {
          ...r,
          pending: c.pending,
          rotations: c.rotations,
          lastRun: c.lastRun,
          hotBytes: (() => {
            try { return fs.statSync(path.join(archiveDir(), safeName(r.id) + '.ndjson')).size; } catch (_) { return 0; }
          })(),
          packed: (() => {
            try {
              return fs.readdirSync(packedDir()).filter((f) => f.startsWith(safeName(r.id) + '-')).length;
            } catch (_) { return 0; }
          })(),
        };
      });
      return { rules, packedDir: packedDir(), defaultMax: a.default_max_records || 0, defaultHours: a.default_interval_hours || 0 };
    }
    case 'catalog': {
      const [ct, ses] = await Promise.all([
        wfGet('/api/v1/contacts?limit=3000').catch(() => ({ contacts: [] })),
        wfGet('/api/v1/sessions?limit=1000').catch(() => ({ sessions: [] })),
      ]);
      const map = new Map();
      for (const c of ct.contacts || []) {
        const u = String(c.username || '').trim();
        if (!u) continue;
        map.set(u, {
          username: u,
          name: String(c.displayName || c.nickname || c.remark || u),
          type: c.type === 'group' || u.endsWith('@chatroom') ? 'group' : 'friend',
          remark: String(c.remark || ''),
        });
      }
      for (const s of ses.sessions || []) {
        const u = String(s.username || '').trim();
        if (!u || map.has(u)) continue;
        map.set(u, {
          username: u,
          name: String(s.displayName || u),
          type: u.endsWith('@chatroom') ? 'group' : 'friend',
          remark: '',
        });
      }
      const items = [...map.values()].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'group' ? 1 : -1;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
      log('info', `名单目录：${items.length} 项（群 ${items.filter((x) => x.type === 'group').length}）`);
      return { total: items.length, groups: items.filter((x) => x.type === 'group').length, items };
    }
    case 'mediaProbe': {
      const sid = String(body.sessionId || '');
      if (!sid) throw new Error('缺少 sessionId');
      const img = await findRecentImage(sid, Number(body.withinSeconds) || 3600);
      if (!img) return { found: false, note: '这个会话最近没有可导出的图片/表情' };
      return { found: true, file: img.path, mime: img.mime, kb: Math.round(img.size / 1024), createTime: img.ts, localType: img.localType };
    }
    case 'visionTest': {
      const file = String(body.file || '');
      if (!file || !fs.existsSync(file)) throw new Error('图片不存在: ' + file);
      const ext = path.extname(file).toLowerCase();
      const mime = MIME_BY_EXT[ext] || 'image/png';
      try {
        const txt = await aiVision('你是图片描述助手，用一句话中文描述你看到的图片。', [], '这张图里是什么？', [{ path: file, mime }]);
        return { ok: true, text: txt, model: visionCfg().model };
      } catch (e) {
        return { ok: false, error: e.message, model: visionCfg().model };
      }
    }
    case 'schedList': {
      const now = Date.now();
      return {
        enabled: (S.cfg.schedule || {}).enabled !== false,
        rules: schedRules().map((r) => ({
          ...r,
          nextAt: nextSlot(r, now),
          lastAt: Number(r.lastRunAt) || 0,
        })),
        history: S.scheduleHistory.slice(0, 20),
      };
    }
    case 'schedSave': {
      const rules = Array.isArray(body.rules) ? body.rules : [];
      rules.forEach((r, i) => {
        if (!r.id) r.id = `r${Date.now()}${i}`;
        if (!r.createdAt) r.createdAt = Date.now();
      });
      saveConfig({ schedule: { rules } });
      startSchedule();
      return { ok: true, count: rules.length };
    }
    case 'schedTest': {
      const id = String(body.id || '');
      const rule = schedRules().find((r) => r.id === id);
      if (!rule) throw new Error('找不到这条规则');
      const r = await runScheduleRule(rule, { force: true });
      return r;
    }
    case 'archiveOpen': {
      const sid = String(body.sessionId || '').trim();
      const dir = archiveDir();
      let target = '';
      if (sid) {
        const safe = sid.replace(/[\\/:*?"<>|]/g, '_');
        const hit = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory() && d.name.endsWith('__' + safe)) : null;
        if (hit) target = body.file ? path.join(dir, hit.name, 'messages.ndjson') : path.join(dir, hit.name);
        else if (!body.file) target = dir;
      } else target = dir;
      if (!target) throw new Error('找不到这个会话的归档目录');
      if (!fs.existsSync(target)) throw new Error('路径不存在: ' + target);
      // .ndjson 没有默认关联程序，shell.openPath 会卡在"选择程序"对话框；
      // 直接用记事本打开，最稳。打不开就退回打开所在文件夹。
      if (body.file) {
        try {
          const ps = spawn('notepad.exe', [target], { detached: true, stdio: 'ignore', windowsHide: false });
          ps.unref();
          return { ok: true, path: target, how: 'notepad' };
        } catch (e) {
          try { spawn('explorer.exe', ['/select,' + target], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
          return { ok: true, path: target, how: 'explorer' };
        }
      }
      const { shell } = require('electron');
      const err = await shell.openPath(target);
      // Explorer 会被开在当前窗口后面，用户以为没反应 —— 主动把它提到前台
      try {
        const title = path.basename(target);
        const ps1 = path.join(WFAI_DIR, 'tools', 'focus-explorer.ps1');
        if (fs.existsSync(ps1) && title) {
          const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Title', title], { windowsHide: true, detached: true, stdio: 'ignore' });
          p.unref();
        }
      } catch (_) {}
      if (err) throw new Error(err);
      return { ok: true, path: target };
    }
    case 'archiveRead': {
      const sid = String(body.sessionId || '').trim();
      if (!sid) throw new Error('缺少 sessionId');
      const safe = sid.replace(/[\\/:*?"<>|]/g, '_');
      const dir = archiveDir();
      let file = '';
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.endsWith('__' + safe)) { file = path.join(dir, d.name, 'messages.ndjson'); break; }
      }
      if (!file) { const flat = path.join(dir, safe + '.ndjson'); if (fs.existsSync(flat)) file = flat; }
      if (!file || !fs.existsSync(file)) throw new Error('找不到归档文件');
      const st = fs.statSync(file);
      const MAX = 3 * 1024 * 1024;
      const buf = fs.readFileSync(file);
      const text = buf.subarray(0, MAX).toString('utf8');
      return { path: file, sizeKb: Math.round(st.size / 1024), truncated: st.size > MAX, text };
    }
    case 'archiveWrite': {
      const sid = String(body.sessionId || '').trim();
      if (!sid) throw new Error('缺少 sessionId');
      const safe = sid.replace(/[\\/:*?"<>|]/g, '_');
      const dir = archiveDir();
      let file = '';
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && d.name.endsWith('__' + safe)) { file = path.join(dir, d.name, 'messages.ndjson'); break; }
      }
      if (!file) { const flat = path.join(dir, safe + '.ndjson'); if (fs.existsSync(flat)) file = flat; }
      if (!file) throw new Error('找不到归档文件');
      const text = String(body.text == null ? '' : body.text);
      // 先备份再写
      try { fs.copyFileSync(file, file + '.bak'); } catch (_) {}
      fs.writeFileSync(file, text, 'utf8');
      invalidateArchiveCache();
      const okLines = text.split('\n').filter((l) => {
        if (!l.trim()) return false;
        try { JSON.parse(l); return true; } catch (_) { return false; }
      }).length;
      const badLines = text.split('\n').filter((l) => l.trim()).length - okLines;
      log('info', `归档文件已手动修改：${path.basename(path.dirname(file))}（${okLines} 条有效${badLines ? '，' + badLines + ' 条格式不对' : ''}）`);
      return { ok: true, path: file, valid: okLines, invalid: badLines };
    }
    case 'dataPaths': {
      return {
        root: PATHS.cfgDir,
        old: PATHS.oldCfgDir || null,
        migrated: PATHS.migrated || 0,
        isDefault: !((S.cfg.paths || {}).root),
        subdirs: { archive: PATHS.archive, context: path.join(PATHS.cfgDir, 'context'), logs: PATHS.logs, stickers: path.join(PATHS.cfgDir, 'stickers'), workspace: PATHS.workspace, out: PATHS.out, plugins: path.join(PATHS.cfgDir, 'plugins') },
      };
    }
    case 'setDataRoot': {
      const want = String(body.root || '').trim();
      const isDefault = !want || want === '__default__';
      const target = isDefault && WFAI_DIR ? path.join(WFAI_DIR, 'data') : want;
      if (!isDefault && !target) throw new Error('路径为空');
      if (!isDefault) {
        try { fs.mkdirSync(target, { recursive: true }); } catch (e) { throw new Error('无法创建目录: ' + e.message); }
      }
      saveConfig({ paths: { root: isDefault ? '' : target } });
      log('info', '数据目录已改为：' + target + '（重启后生效，会自动把旧数据复制过来）');
      return { ok: true, root: target, isDefault, needRestart: path.resolve(target) !== path.resolve(PATHS.cfgDir) };
    }
    case 'archiveList': {
      const wantRefresh = body.refresh === true;
      if (wantRefresh) invalidateArchiveCache();
      const list = archiveFilesCached();
      return { dir: archiveDir(), totals: archiveTotals(list), items: list.slice(0, 500), cached: !wantRefresh };
    }
    case 'archiveDelete': {
      const sid = String(body.sessionId || '').trim();
      if (!sid) throw new Error('缺少 sessionId');
      const safe = String(sid).replace(/[\\/:*?"<>|]/g, '_');
      const dir = archiveDir();
      const removed = [];
      // 新布局：整个会话文件夹一起删（含里面的 messages.ndjson 和 packed）
      try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          if (d.isDirectory() && d.name.endsWith('__' + safe)) {
            fs.rmSync(path.join(dir, d.name), { recursive: true, force: true });
            removed.push(d.name + '/');
          }
        }
      } catch (e) { throw new Error('删除文件夹失败: ' + e.message); }
      // 旧布局：单个 ndjson
      try {
        const f = path.join(dir, safe + '.ndjson');
        if (fs.existsSync(f)) { fs.unlinkSync(f); removed.push(safe + '.ndjson'); }
      } catch (e) { throw new Error('删除失败: ' + e.message); }
      // 连带删掉这个会话的压缩包
      if (body.withPacked !== false) {
        try {
          const pdir = path.join(dir, 'packed');
          if (fs.existsSync(pdir)) {
            for (const n of fs.readdirSync(pdir)) {
              if (n.startsWith(safe + '-')) { fs.unlinkSync(path.join(pdir, n)); removed.push('packed/' + n); }
            }
          }
        } catch (_) {}
      }
      // 游标清掉，之后重新归档时会从头拉
      try {
        if (S.archive.cursors && S.archive.cursors[sid]) { delete S.archive.cursors[sid]; saveCursors(S.archive.cursors); }
      } catch (_) {}
      invalidateArchiveCache();
      log('info', `已删除归档：${sid}（${removed.length} 个文件）`);
      return { ok: true, removed };
    }
    case 'archiveClearAll': {
      const dir = archiveDir();
      let n = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f === '_cursors.json' || f.startsWith('_layout-')) continue;
          const full = path.join(dir, f);
          let st;
          try { st = fs.statSync(full); } catch (_) { continue; }
          if (st.isFile() && f.endsWith('.ndjson')) { fs.unlinkSync(full); n++; }
          else if (st.isDirectory() && f !== 'packed') { fs.rmSync(full, { recursive: true, force: true }); n++; }
        }
        const pdir = path.join(dir, 'packed');
        if (fs.existsSync(pdir)) { for (const f of fs.readdirSync(pdir)) { try { fs.unlinkSync(path.join(pdir, f)); } catch (_) {} } }
      } catch (e) { throw new Error('清空失败: ' + e.message); }
      invalidateArchiveCache();
      try { S.archive.cursors = {}; saveCursors(S.archive.cursors); } catch (_) {}
      log('warn', `已清空全部归档（${n} 个文件）`);
      return { ok: true, removed: n };
    }
    case 'archiveSearch': {
      return searchArchive({
        query: body.query, sessionId: body.sessionId,
        limit: body.limit, since: body.since, until: body.until,
      });
    }
    case 'detectWeFlow': {
      const out = { base_url: '', access_token: '', wechat_exe: '', notes: [] };
      // 1) WeFlow 自己的配置文件
      const cands = [
        path.join(process.env.APPDATA || '', 'weflow', 'WeFlow-config.json'),
        path.join(process.env.APPDATA || '', 'WeFlow', 'WeFlow-config.json'),
      ];
      for (const p of cands) {
        try {
          if (!fs.existsSync(p)) continue;
          const j = JSON.parse(fs.readFileSync(p, 'utf8'));
          const port = Number(j.httpApiPort) || 5031;
          const host = String(j.httpApiHost || '127.0.0.1').trim();
          let tok = String(j.httpApiToken || '').trim();
          out.base_url = `http://${host}:${port}`;
          if (/^safe:/.test(tok)) {
            // WeFlow 把 token 加密存了，只有它自己进程内能读明文，我们拿不到
            out.access_token = '';
            out.notes.push(`读取 ${path.basename(p)}：端口 ${out.base_url.replace('http://','')}，token 是加密的（safe:…），沿用当前已配置的 token`);
          } else {
            out.access_token = tok;
            out.notes.push(`读取 ${path.basename(p)}：端口 ${port}，token ${tok ? '已获取' : '空'}`);
          }
          if (j.httpApiEnabled === false) out.notes.push('注意：WeFlow 里 HTTP API 是关闭状态');
          break;
        } catch (e) { out.notes.push('读取 ' + p + ' 失败: ' + e.message); }
      }
      if (!out.base_url) {
        out.base_url = String((S.cfg.weflow || {}).base_url || 'http://127.0.0.1:5031');
        out.notes.push('没找到 WeFlow 配置文件，沿用当前地址');
      }
      // 2) 微信进程名
      try {
        const ps = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
        const txt = String(ps.stdout || '');
        const names = ['Weixin.exe', 'WeChat.exe', 'Weixin', 'WeChat'];
        const hit = names.find((n) => new RegExp('^"' + n.replace('.exe','') + '(\\.exe)?",', 'im').test(txt))
          || names.find((n) => txt.toLowerCase().includes(n.toLowerCase().replace('.exe','') + '.exe'));
        if (hit) { out.wechat_exe = hit.endsWith('.exe') ? hit : hit + '.exe'; out.notes.push('检测到微信进程：' + out.wechat_exe); }
        else out.notes.push('没检测到微信进程（可能没开）');
      } catch (e) { out.notes.push('探测进程失败: ' + e.message); }
      return out;
    }
    case 'ctxUsage': {
      const sid = String(body.sessionId || '');
      if (!sid) throw new Error('缺少 sessionId');
      return ctxUsage(sid);
    }
    case 'ctxProbe': {
      // 给某个会话灌入 N 轮假对话，然后看会不会自动压缩（不调模型就能看到用量）
      const sid = String(body.sessionId || 'probe@chatroom');
      const rounds = Math.max(1, Math.min(400, Number(body.rounds) || 30));
      const filler = '这是一段用来撑大上下文的测试文本，包含一些事实：张三负责PPT，李四负责数据，结论是周五交付。'.repeat(Math.max(1, Math.min(40, Number(body.repeat) || 6)));
      const arr = S.history.get(sid) || [];
      for (let i = 0; i < rounds; i++) {
        arr.push({ role: 'user', content: `第${i + 1}轮提问：${filler}` });
        arr.push({ role: 'assistant', content: `第${i + 1}轮回答：${filler}` });
      }
      S.history.set(sid, arr);
      return { sessionId: sid, injected: rounds * 2, usage: ctxUsage(sid) };
    }
    case 'ctxCompress': {
      const sid = String(body.sessionId || 'probe@chatroom');
      const meta = { contact: String(body.contact || sid), group: sid.endsWith('@chatroom') ? String(body.contact || sid) : '', isGroup: sid.endsWith('@chatroom') };
      const before = ctxUsage(sid);
      const r = await maybeCompressContext(sid, meta);
      const after = ctxUsage(sid);
      return { before, after, result: r };
    }
    case 'ctxReset': {
      const sid = String(body.sessionId || '');
      S.history.delete(sid);
      S.ctx.delete(sid);
      try { fs.unlinkSync(ctxFile(sid)); } catch (_) {}
      return { ok: true };
    }
    case 'tidyTest': {
      const raw = String(body.text || '');
      return { before: raw, after: sanitizeReply(raw) };
    }
    case 'aiProbe': {
      const ai = S.cfg.ai || {};
      const body = { model: ai.model, messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }], temperature: ai.temperature, max_tokens: 512, stream: false };
      const thinkApplied = applyThinking(body);
      const mode = applyNativeSearch(body);
      const base = String(ai.base_url || '').replace(/\/+$/, '');
      return {
        provider: ai.provider, mode, thinkApplied, thinking: ai.thinking, effort: ai.reasoning_effort,
        url: /\/chat\/completions$/.test(base) ? base : base + '/chat/completions',
        body,
        samples: {
          weatherGoesNative: !needsLocalTools('查一下今天上海天气'),
          pptGoesTools: needsLocalTools('帮我做个PPT'),
          fileGoesTools: needsLocalTools('把 C:\\a 里的文件发我'),
        },
      };
    }
    case 'promptPeek': {
      const g = groupCfgFor(sessionId);
      const isGroup = !!body.isGroup;
      const globalPrompt = String(S.cfg.system_prompt || '').trim();
      const groupPrompt = isGroup ? String(g.system_prompt || '').trim() : '';
      let base = globalPrompt;
      if (groupPrompt) {
        base = g.ignore_global_prompt === false ? [globalPrompt, groupPrompt].filter(Boolean).join('\n\n') : groupPrompt;
      }
      return { isGroup, ignoreGlobal: g.ignore_global_prompt !== false, prompt: base };
    }
    case 'webTest': {
      const q = String(body.q || '测试');
      if (body.url) {
        const r = await webFetch(body.url, Number(body.limit_kb) || 0);
        return { kind: 'fetch', ok: r.ok, text: String(r.text).slice(0, 3000) };
      }
      const r = await webSearch(q);
      return { kind: 'search', ok: r.ok, text: String(r.text).slice(0, 3000), results: r.results || [] };
    }
    case 'stickerScan': {
      const r = await scanStickers(!!body.force);
      return { ...r, scan: S.stickerScan };
    }
    case 'stickerIndex': {
      const idx = loadStickerIndex();
      const { names } = listStickers(2000);
      return {
        total: names.length,
        tagged: names.filter((n) => idx[n]).length,
        scan: S.stickerScan,
        items: names.map((n) => ({ name: n, ...(idx[n] || {}) })),
      };
    }
    case 'stickerList': {
      const r = listStickers(2000);
      return { dir: r.dir, total: r.total, names: r.names.slice(0, 200) };
    }
    case 'stickerProbe': {
      const text = String(body.text || '今天心情不错');
      const p = await pickSticker(text);
      return { picked: p ? path.basename(p) : null, path: p || null };
    }
    case 'testAgent': {
      const text = String(body.text || '/help');
      const res = await runAgent(text, {
        sessionId: body.sessionId || 'test@local',
        contact: body.contact || '本地测试',
        sender: body.sender || '我',
        isGroup: !!body.isGroup,
        context: [],
      });
      return res || { ok: false, message: '不是命令（会走 AI 回复）', files: [] };
    }
    case 'archiveNow': {
      const stats = await runArchive('manual');
      return stats || { skipped: true };
    }
    case 'importWhitelist': {
      // WeFlow 把推送白名单存在它自己的配置里，这里把它抄进 Bot 的名单
      const wfCfgPath = path.join(app.getPath('userData'), 'WeFlow-config.json');
      if (!fs.existsSync(wfCfgPath)) throw new Error('找不到 WeFlow 配置: ' + wfCfgPath);
      const wf = JSON.parse(fs.readFileSync(wfCfgPath, 'utf8'));
      const list = Array.isArray(wf.messagePushFilterList) ? wf.messagePushFilterList.map((x) => String(x || '').trim()).filter(Boolean) : [];
      if (!list.length) throw new Error('WeFlow 配置里的 messagePushFilterList 是空的');
      const mode = wf.messagePushFilterMode === 'blacklist' ? 'blacklist' : 'whitelist';
      saveConfig({ filter: { mode, list } });
      log('info', `已从 WeFlow 导入推送名单 ${list.length} 条（模式=${mode}，WeFlow 原设置=${wf.messagePushFilterMode}）`);
      return { count: list.length, mode, weflowMode: wf.messagePushFilterMode, weflowEnabled: wf.messagePushEnabled };
    }
    case 'testWebhook': {
      const ev = buildEvent('keyword', {
        sessionId: body.sessionId || 'test@chatroom',
        contact: body.contact || '测试群',
        sender: '测试发送者',
        text: body.text || '这是一条 WeFlow Bot 的 Webhook 测试事件',
        isGroup: true,
        keyword: '测试',
        before: [],
        n: 0,
      });
      S.events.unshift(ev);
      await deliverWebhook(ev);
      return { delivered: ev.delivered };
    }
    case 'clearEvents':
      S.events.length = 0;
      S.triggerStats = { keyword: 0, mention: 0, webhookOk: 0, webhookFail: 0 };
      S.toolStats = { calls: 0, ok: 0, fail: 0 };
      return { cleared: true };
    case 'eval': {
      // 本地调试通道：在面板里执行一段 JS（仅本机、需要 api.json 里的令牌）
      if (!body.js || typeof body.js !== 'string') throw new Error('缺少 js 参数');
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && /dist[\\/]index\.html/.test(w.webContents.getURL() || ''));
      let target = win;
      if (!target) {
        const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
        const urls = all.map((w) => w.webContents.getURL());
        if (!all.length) throw new Error('找不到主窗口（一个窗口都没有）');
        target = all[0];
        log('warn', '主窗口未匹配到 dist/index.html，改用第一个窗口；现有 URL=' + JSON.stringify(urls));
      }
      const value = await target.webContents.executeJavaScript(body.js, true);
      return { value: typeof value === 'object' ? JSON.stringify(value).slice(0, 4000) : String(value).slice(0, 4000) };
    }
    default:
      throw new Error('未知操作: ' + body.op);
  }
}

// ---------------------------------------------------------------------------
// renderer injection
// ---------------------------------------------------------------------------
function injectInto(win) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL() || '';
  if (!/dist[\\/]index\.html/.test(url) && !/^file:.*index\.html/.test(url)) return;
  let js;
  try { js = fs.readFileSync(UI_FILE, 'utf8'); } catch (e) { log('error', '读取面板脚本失败: ' + e.message); return; }
  const boot = `window.__WFAI__=${JSON.stringify({ port: S.port, token: S.apiToken })};\n`;
  wc.executeJavaScript(boot + js, true).then(
    () => log('info', '面板已注入主窗口'),
    (e) => log('warn', '面板注入失败: ' + e.message)
  );
}

function attachWindow(win) {
  if (!win || win.__wfaiAttached) return;
  const wc = win.webContents;
  if (!wc) return;
  win.__wfaiAttached = true;
  wc.on('did-finish-load', () => injectInto(win));
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
function boot() {
  try {
    const userData = app.getPath('userData');
    PATHS.cfgDir = path.join(userData, 'wfai');
    // 便携模式：如果程序目录里放了 resources\wfai\config.json，就优先用它
    // （这样整个文件夹拷到别的机器也能带着设置走）
    try {
      const portableCfg = WFAI_DIR ? path.join(WFAI_DIR, 'config.json') : null;
      if (portableCfg && fs.existsSync(portableCfg)) {
        PATHS.cfgDir = WFAI_DIR;
        log('info', '便携模式：使用程序目录下的 config.json');
      }
    } catch (_) {}
    PATHS.cfgFile = path.join(PATHS.cfgDir, 'config.json');
    // ---- 数据根目录：默认放 WeFlow 目录下，分类存放；用户可在设置里改
    try {
      // 先把可能存在的旧配置读出来看用户有没有指定
      let wantRoot = '';
      try {
        const j = JSON.parse(fs.readFileSync(PATHS.cfgFile, 'utf8'));
        if (j && j.paths && typeof j.paths.root === 'string') wantRoot = j.paths.root.trim();
      } catch (_) {}
      if (!wantRoot && WFAI_DIR) wantRoot = path.join(WFAI_DIR, 'data');
      if (wantRoot && path.resolve(wantRoot) !== path.resolve(PATHS.cfgDir)) {
        const subdirs = ['archive', 'context', 'logs', 'stickers', 'workspace', 'out', 'plugins'];
        const newEmpty = !fs.existsSync(wantRoot) || fs.readdirSync(wantRoot).length === 0;
        // 旧目录有数据、新目录是空的 → 复制过去（保留旧的，不删）
        if (newEmpty) {
          let moved = 0;
          try { fs.mkdirSync(wantRoot, { recursive: true }); } catch (_) {}
          for (const d of subdirs) {
            const from = path.join(PATHS.cfgDir, d);
            if (!fs.existsSync(from)) continue;
            try {
              fs.cpSync(from, path.join(wantRoot, d), { recursive: true });
              moved++;
            } catch (_) {}
          }
          const cfgOld = path.join(PATHS.cfgDir, 'config.json');
          if (fs.existsSync(cfgOld)) {
            try { fs.copyFileSync(cfgOld, path.join(wantRoot, 'config.json')); moved++; } catch (_) {}
          }
          if (moved) {
            PATHS.migrated = moved;
            PATHS.migratedFrom = PATHS.cfgDir;
          }
        }
        PATHS.oldCfgDir = PATHS.cfgDir;
        PATHS.cfgDir = wantRoot;
        PATHS.cfgFile = path.join(PATHS.cfgDir, 'config.json');
      }
    } catch (_) {}
    PATHS.logs = path.join(PATHS.cfgDir, 'logs');
    PATHS.archive = path.join(PATHS.cfgDir, 'archive');
    PATHS.workspace = path.join(PATHS.cfgDir, 'workspace');
    PATHS.out = path.join(PATHS.cfgDir, 'out');
    PATHS.lib = WFAI_DIR ? path.join(WFAI_DIR, 'lib') : path.join(__dirname, 'lib');
    PATHS.pluginDirs = [path.join(WFAI_DIR, 'plugins'), path.join(PATHS.cfgDir, 'plugins')];
    for (const d of [PATHS.logs, PATHS.archive, PATHS.workspace, PATHS.out, path.join(PATHS.cfgDir, 'plugins')]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    }
    S.apiToken = require('crypto').randomBytes(16).toString('hex');
    loadConfig();
    S.archive.cursors = loadCursors();
    S.archive.dir = archiveDir();
    scanPlugins();
    try {
      fs.writeFileSync(path.join(PATHS.cfgDir, 'api.json'), JSON.stringify({ port: null, token: S.apiToken, pid: process.pid }, null, 2), 'utf8');
    } catch (_) {}
    log('info', `Bot 侧车已加载 (WeFlow ${app.getVersion ? app.getVersion() : '?'})`);
    if (S.portableMode) log('info', '便携模式：配置和数据都在 ' + PATHS.cfgDir);
    startApiServer();
    if (S.cfg.listen !== false) { S.started = true; startSse(); } else { log('info', '监听开关是关的（可点「开始监听」）'); }
    try { killTelemetry(); } catch (e) { log('warn', '关闭数据收集失败: ' + e.message); }
    try { migrateArchiveToFolders(); } catch (e) { log('warn', '迁移归档失败: ' + e.message); }
    scheduleArchive();
  startSchedule();

    for (const w of BrowserWindow.getAllWindows()) attachWindow(w);
    app.on('browser-window-created', (_e, win) => {
      attachWindow(win);
      // catch windows whose URL is set slightly after creation
      setTimeout(() => { if (!win.isDestroyed()) injectIfMain(win); }, 1500);
    });
    setInterval(() => {
      for (const w of BrowserWindow.getAllWindows()) injectIfMain(w);
    }, 5000).unref();

    // ui.js 改了（升级面板）就自动重新注入，省得手动刷新
    let uiStamp = 0;
    try { uiStamp = fs.statSync(UI_FILE).mtimeMs; } catch (_) {}
    setInterval(() => {
      let now = 0;
      try { now = fs.statSync(UI_FILE).mtimeMs; } catch (_) { return; }
      if (now && now !== uiStamp) {
        uiStamp = now;
        log('info', '检测到 ui.js 更新，重新注入面板');
        for (const w of BrowserWindow.getAllWindows()) injectInto(w);
      }
    }, 4000).unref();
  } catch (e) {
    log('error', '侧车启动失败: ' + (e && e.stack || e));
  }
}

const injected = new WeakSet();
function injectIfMain(win) {
  if (!win || win.isDestroyed()) return;
  if (injected.has(win)) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  const url = wc.getURL() || '';
  if (!/dist[\\/]index\.html/.test(url)) return;
  if (wc.isLoading()) return;
  injected.add(win);
  injectInto(win);
}

if (app.isReady && app.isReady()) boot();
else app.whenReady().then(boot);
