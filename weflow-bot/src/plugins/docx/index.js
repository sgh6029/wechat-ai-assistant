'use strict';
// 内置插件：把简易 DSL 转成 .docx
//   # 一级标题 / ## 二级标题 / ### 三级标题
//   - 列表项
//   > 引用
//   | a | b |  连续多行 -> 表格
//   ---        -> 分页
//   其他        -> 普通段落
const fs = require('fs');
const path = require('path');

function parseDsl(text) {
  const lines = String(text || '').split(/\r?\n/);
  const spec = { title: '', subtitle: '', blocks: [] };
  let tableBuf = [];
  const flushTable = () => {
    if (tableBuf.length) {
      spec.blocks.push({ type: 'table', rows: tableBuf });
      tableBuf = [];
    }
  };
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushTable(); continue; }
    if (/^\|.*\|$/.test(line)) {
      tableBuf.push(line.replace(/^\||\|$/g, '').split('|').map((s) => s.trim()));
      continue;
    }
    flushTable();
    if (first && !/^[#\-|>]/.test(line)) { spec.title = line; first = false; continue; }
    first = false;
    if (/^###\s+/.test(line)) spec.blocks.push({ type: 'h3', text: line.replace(/^###\s+/, '') });
    else if (/^##\s+/.test(line)) spec.blocks.push({ type: 'h2', text: line.replace(/^##\s+/, '') });
    else if (/^#\s+/.test(line)) spec.blocks.push({ type: 'h1', text: line.replace(/^#\s+/, '') });
    else if (/^[-*•]\s+/.test(line)) spec.blocks.push({ type: 'bullet', text: line.replace(/^[-*•]\s+/, '') });
    else if (/^>\s+/.test(line)) spec.blocks.push({ type: 'quote', text: line.replace(/^>\s+/, '') });
    else if (/^-{3,}$/.test(line)) spec.blocks.push({ type: 'pagebreak' });
    else spec.blocks.push({ type: 'p', text: line });
  }
  flushTable();
  if (!spec.title) spec.title = '未命名文档';
  return spec;
}

async function run(ctx) {
  const body = String(ctx.text || '').replace(/^\s*\/\S+\s*/, '').trim();
  if (!body) return { ok: false, message: '用法：/word 标题，然后 # 分级、- 列表、| 表格 |' };

  const spec = parseDsl(body);
  if (ctx.sender) spec.subtitle = `由 ${ctx.sender} 通过 WeFlow Bot 生成 · ${new Date().toLocaleString('zh-CN')}`;
  const ooxml = require(path.join(ctx.libDir, 'ooxml'));
  const buf = ooxml.buildDocx(spec);

  const name = `DOC-${(spec.title || 'untitled').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}-${Date.now().toString(36)}.docx`;
  const out = path.join(ctx.outDir, name);
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(out, buf);

  return {
    ok: true,
    message: `已生成 Word：《${spec.title}》${spec.blocks.length} 个段落块（${Math.round(buf.length / 1024)} KB）`,
    files: [out],
  };
}

module.exports = { run };
