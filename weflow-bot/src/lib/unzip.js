'use strict';
// Minimal ZIP reader (deflate + store). Enough for GitHub archive / release zips.
const zlib = require('zlib');

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function decodeName(buf, flags) {
  // bit 11 = UTF-8
  return buf.toString((flags & 0x0800) ? 'utf8' : 'binary');
}

/**
 * @param {Buffer} buf
 * @returns {Array<{name:string, dir:boolean, data:Buffer}>}
 */
function unzip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 ZIP（文件太小）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  if (!ptr || ptr >= buf.length) throw new Error('ZIP 中央目录偏移异常');

  const out = [];
  for (let i = 0; i < count; i++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const rawSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = decodeName(buf.slice(ptr + 46, ptr + 46 + nameLen), flags);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) { out.push({ name, dir: true, data: Buffer.alloc(0) }); continue; }
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const comp = buf.slice(start, start + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) {
      try { data = zlib.inflateRawSync(comp); } catch (e) { throw new Error(`解压失败 ${name}: ${e.message}`); }
    } else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
    if (rawSize && data.length !== rawSize) { /* 大小不一致也继续，部分打包器写得不准 */ }
    out.push({ name, dir: false, data });
  }
  return out;
}

module.exports = { unzip };
