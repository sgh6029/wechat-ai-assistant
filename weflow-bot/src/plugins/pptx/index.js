'use strict';
// 内置插件：把简易提纲 DSL 转成 .pptx
// DSL:
//   第一行            -> 封面标题
//   # xxx             -> 新一页标题
//   - xxx / • xxx     -> 该页要点
//   > xxx             -> 封面副标题
const fs = require('fs');
const path = require('path');

function parseDsl(text) {
  const raw = String(text || '');
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const spec = { title: '', subtitle: '', slides: [] };
  let cur = null;

  // A) 标准 DSL：# 分页 / - 要点 / > 副标题
  const hasDsl = lines.some((l) => /^#\s+/.test(l));
  if (hasDsl) {
    for (const rawLine of lines) {
      const line = rawLine.replace(/^[*•·]\s*/, '- ');
      if (/^#\s+/.test(line)) {
        cur = { title: line.replace(/^#\s+/, '').trim(), bullets: [] };
        spec.slides.push(cur);
      } else if (/^[-—]\s+/.test(line)) {
        if (!cur) { cur = { title: '要点', bullets: [] }; spec.slides.push(cur); }
        cur.bullets.push(line.replace(/^[-—]\s+/, '').trim());
      } else if (/^>\s+/.test(line)) {
        spec.subtitle = line.replace(/^>\s+/, '').trim();
      } else if (!spec.title) {
        spec.title = line;
      } else if (cur) {
        cur.bullets.push(line);
      }
    }
    if (!spec.title) spec.title = '未命名演示';
    return spec;
  }

  // B) 「第1页 封面：xxx」这种自然语言分页（大模型很爱这么写）
  const pageMarks = [];
  lines.forEach((l, i) => { if (/^(第\s*\d+\s*页|幻灯片\s*\d+|Slide\s*\d+|P\d+)/i.test(l)) pageMarks.push(i); });
  if (pageMarks.length) {
    // 第一条页标记之前的非空行当标题
    const head = lines.slice(0, pageMarks[0]).filter((l) => !/^要求[:：]/.test(l));
    const h0 = head[0] || '演示文稿';
    const qm = h0.match(/「([^」]{2,40})」|"([^"]{2,40})"/);
    spec.title = (qm ? (qm[1] || qm[2]) : h0.replace(/^(生成|做|来|帮我)?(一份|一个)?[^，,]{0,12}(PPT|演示文稿|幻灯片)[，,]?(主题为|主题是)?[：:]?/, '').replace(/[，,。].*$/, '')).slice(0, 40) || '演示文稿';
    if (head[1] && head[1].length < 40) spec.subtitle = head[1];

    for (let k = 0; k < pageMarks.length; k++) {
      const start = pageMarks[k];
      const end = k + 1 < pageMarks.length ? pageMarks[k + 1] : lines.length;
      const block = lines.slice(start, end);
      const head0 = block[0].replace(/^(第\s*\d+\s*页|幻灯片\s*\d+|Slide\s*\d+|P\d+)\s*[:：\-、]?\s*/i, '').trim();
      const title = (head0.split(/[:：]/)[0] || head0 || `第 ${k + 1} 页`).slice(0, 40);
      const bullets = [];
      for (const b of block.slice(1)) {
        if (/^要求[:：]/.test(b)) break;          // 后面的统一要求不当要点
        const t = b.replace(/^[-—*•·\d.、）)]+\s*/, '').trim();
        if (!t) continue;
        // 一行里如果有多段（用；/。分隔），拆成多条要点
        const parts = t.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
        for (const pp of parts) bullets.push(pp.length > 90 ? pp.slice(0, 90) + '…' : pp);
      }
      spec.slides.push({ title, bullets: bullets.slice(0, 7) });
    }
    return spec;
  }

  // C) 纯段落：按句子切块，每 5 条一页
  const sentences = raw.split(/[。；;！!？?\n]+/).map((s) => s.trim()).filter((s) => s.length > 1);
  spec.title = (sentences[0] || '演示文稿').slice(0, 40);
  const rest = sentences.slice(1);
  const per = 5;
  for (let i = 0; i < rest.length; i += per) {
    spec.slides.push({ title: `要点 ${i / per + 1}`, bullets: rest.slice(i, i + per) });
  }
  if (!spec.slides.length) spec.slides.push({ title: '内容', bullets: [spec.title] });
  return spec;
}

async function run(ctx) {
  const body = String(ctx.text || '').replace(/^\s*\/\S+\s*/, '').trim();
  if (!body) return { ok: false, message: '用法：/ppt 标题，然后 # 分页、- 要点' };

  const spec = parseDsl(body);
  const ooxml = require(path.join(ctx.libDir, 'ooxml'));
  const buf = ooxml.buildPptx(spec);

  const name = `PPT-${(spec.title || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${Date.now().toString(36)}.pptx`;
  const out = path.join(ctx.outDir, name);
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(out, buf);

  return {
    ok: true,
    message: `已生成 PPT：《${spec.title}》共 ${spec.slides.length + 1} 页（${Math.round(buf.length / 1024)} KB）`,
    files: [out],
  };
}

module.exports = { run };
