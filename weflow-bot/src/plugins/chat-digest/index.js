'use strict';
// 内置插件：从本地 NDJSON 归档里做统计并输出 Word 纪要。
// 全部是本地规则统计（词频/人数/时段），不调用任何大模型。
const fs = require('fs');
const path = require('path');

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 120);
}

function readNdjson(file) {
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) {}
  }
  return out;
}

function pickSession(archiveDir, want, fallbackId) {
  const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith('.ndjson'));
  const norm = String(want || '').trim().toLowerCase();
  if (norm) {
    // direct wxid file hit
    const direct = files.find((f) => f.toLowerCase() === norm + '.ndjson' || f.toLowerCase().includes(norm));
    if (direct) return path.join(archiveDir, direct);
    // search by display name inside the file headers
    for (const f of files) {
      const rows = readNdjson(path.join(archiveDir, f));
      if (rows.length && String(rows[0].session || '').toLowerCase().includes(norm)) return path.join(archiveDir, f);
    }
    return null;
  }
  if (fallbackId) {
    const f = files.find((x) => x === safeName(fallbackId) + '.ndjson');
    if (f) return path.join(archiveDir, f);
  }
  return null;
}

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '就', '不', '也', '都', '要', '啊', '吧', '吗', '呢', '嗯', '哦', '个', '上', '下', '说', '到', '去', '会', '把', '被', '给', '让', '一个', '什么', '怎么', '可以', '这个', '那个', '还是', '然后', '就是', '没有', '我们', '你们', '他们']);

function topWords(rows, limit = 25) {
  const freq = new Map();
  for (const r of rows) {
    const txt = String(r.text || '');
    const tokens = txt.match(/[\u4e00-\u9fa5]{2,4}|[A-Za-z][A-Za-z0-9_#+.-]{1,20}/g) || [];
    for (const t of tokens) {
      const k = t.toLowerCase();
      if (STOP.has(k)) continue;
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

async function run(ctx) {
  const argRaw = String(ctx.text || '').replace(/^\s*\/\S+\s*/, '').trim();
  const parts = argRaw.split(/\s+/).filter(Boolean);
  let want = '';
  let days = 7;
  for (const p of parts) {
    if (/^\d+$/.test(p)) days = Math.min(365, Math.max(1, Number(p)));
    else want = want ? want + ' ' + p : p;
  }

  const archiveDir = ctx.archiveDir;
  if (!archiveDir || !fs.existsSync(archiveDir)) {
    return { ok: false, message: '还没有归档目录。先到 Bot → 规则 → 定时归档，点「立即归档」。' };
  }
  const file = pickSession(archiveDir, want, ctx.sessionId);
  if (!file) {
    return { ok: false, message: want ? `归档里找不到「${want}」这个会话。` : '归档里没有当前会话，请在命令后带上会话名，例如：/纪要 项目群 7' };
  }

  const all = readNdjson(file);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = all.filter((r) => Number(r.ts || 0) >= since);
  if (!rows.length) {
    return { ok: false, message: `《${path.basename(file, '.ndjson')}》最近 ${days} 天没有归档到消息。` };
  }

  const sessionName = rows[0].session || path.basename(file, '.ndjson');
  const senders = new Map();
  for (const r of rows) {
    const k = r.isSend ? '我' : (r.sender || '未知');
    senders.set(k, (senders.get(k) || 0) + 1);
  }
  const topSenders = [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const hours = new Array(24).fill(0);
  for (const r of rows) hours[new Date(Number(r.ts) * 1000).getHours()]++;
  const peak = hours.indexOf(Math.max(...hours));

  const types = new Map();
  for (const r of rows) {
    const t = String(r.text || '');
    const kind = t.startsWith('[图片]') ? '图片' : t.startsWith('[语音]') ? '语音' : t.startsWith('[视频]') ? '视频'
      : t.startsWith('[表情]') ? '表情' : t.startsWith('[') ? '其他富媒体' : '文本';
    types.set(kind, (types.get(kind) || 0) + 1);
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const fmt = (ts) => new Date(Number(ts) * 1000).toLocaleString('zh-CN');

  const blocks = [
    { type: 'h1', text: '一、概览' },
    {
      type: 'table',
      rows: [
        ['指标', '数值'],
        ['会话', sessionName],
        ['统计区间', `${fmt(first.ts)} ~ ${fmt(last.ts)}（最近 ${days} 天）`],
        ['消息条数', String(rows.length)],
        ['参与人数', String(senders.size)],
        ['最活跃时段', `${peak}:00 - ${peak + 1}:00`],
      ],
    },
    { type: 'h1', text: '二、发言分布' },
    { type: 'table', rows: [['成员', '条数', '占比'], ...topSenders.map(([k, v]) => [k, String(v), (v / rows.length * 100).toFixed(1) + '%'])] },
    { type: 'h1', text: '三、内容构成' },
    { type: 'table', rows: [['类型', '条数'], ...[...types.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)])] },
    { type: 'h1', text: '四、高频词（本地词频，非大模型摘要）' },
    { type: 'p', text: topWords(rows).map(([w, c]) => `${w}(${c})`).join('　') || '（无）' },
    { type: 'h1', text: '五、最后 30 条原文' },
    ...rows.slice(-30).map((r) => ({
      type: 'quote',
      text: `[${fmt(r.ts)}] ${r.isSend ? '我' : (r.sender || '')}：${String(r.text || '').slice(0, 200)}`,
    })),
  ];

  const ooxml = require(path.join(ctx.libDir, 'ooxml'));
  const buf = ooxml.buildDocx({ title: `${sessionName} 聊天纪要`, subtitle: `最近 ${days} 天 · 生成于 ${new Date().toLocaleString('zh-CN')}`, blocks });
  const out = path.join(ctx.outDir, `纪要-${safeName(sessionName)}-${Date.now().toString(36)}.docx`);
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(out, buf);

  return {
    ok: true,
    message: `《${sessionName}》最近 ${days} 天 ${rows.length} 条消息，${senders.size} 人参与；纪要已生成（${Math.round(buf.length / 1024)} KB）`,
    files: [out],
  };
}

module.exports = { run };
