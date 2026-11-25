'use strict';
// Plugin host: runs ONE plugin in an isolated plain-Node process.
// stdin: JSON payload { text, args, context, sessionId, contact, sender, isGroup,
//                       libDir, outDir, archiveDir, workspace, accessMode, now }
// stdout: one line of JSON { ok, message, files, data }
const path = require('path');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', async () => {
  let ctx = {};
  try { ctx = JSON.parse(raw || '{}'); } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, message: '插件入参解析失败: ' + e.message }) + '\n');
    return;
  }
  const entry = process.argv[2];
  if (!entry) {
    process.stdout.write(JSON.stringify({ ok: false, message: '缺少插件入口' }) + '\n');
    return;
  }
  try {
    const mod = require(entry);
    if (!mod || typeof mod.run !== 'function') throw new Error('插件没有导出 run(ctx)');
    const res = await mod.run(ctx);
    const out = res && typeof res === 'object' ? res : { ok: true, message: String(res || '') };
    process.stdout.write(JSON.stringify({
      ok: out.ok !== false,
      message: String(out.message || ''),
      files: Array.isArray(out.files) ? out.files.map(String) : [],
      data: out.data === undefined ? null : out.data,
    }) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: false,
      message: '插件执行出错: ' + (e && e.message ? e.message : String(e)),
      stack: e && e.stack ? String(e.stack).slice(0, 1500) : '',
    }) + '\n');
  }
});
process.on('uncaughtException', (e) => {
  try {
    process.stdout.write(JSON.stringify({ ok: false, message: '插件崩溃: ' + (e && e.message || e) }) + '\n');
  } catch (_) {}
  process.exit(1);
});
