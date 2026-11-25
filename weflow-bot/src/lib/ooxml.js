'use strict';
// Hand-written OOXML (docx / pptx) builders. No third-party dependencies.
const { zip } = require('./zip');

const FONT = '微软雅黑';

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // strip control chars that would make the XML invalid
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// ---------------------------------------------------------------------------
// DOCX
// ---------------------------------------------------------------------------
function p(text, opts = {}) {
  const { bold = false, size = 22, color = null, align = null, spacing = 60, bullet = false } = opts;
  const rpr = `<w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}"/>${bold ? '<w:b/>' : ''}` +
    `${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const ppr = `<w:pPr>${align ? `<w:jc w:val="${align}"/>` : ''}` +
    `${bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}` +
    `<w:spacing w:before="${spacing}" w:after="${spacing}" w:line="320" w:lineRule="auto"/></w:pPr>`;
  return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

function table(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const cols = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 0)));
  const width = Math.floor(9000 / Math.max(1, cols));
  const border = '<w:tblBorders>' +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BDBDBD"/>`).join('') +
    '</w:tblBorders>';
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('');
  const body = rows.map((row, ri) => {
    const cells = Array.from({ length: cols }, (_, ci) => {
      const v = Array.isArray(row) ? row[ci] : '';
      return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p(v == null ? '' : v, { bold: ri === 0, size: 20, spacing: 20 })}</w:tc>`;
    }).join('');
    return `<w:tr>${cells}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>${p('', { spacing: 40 })}`;
}

/**
 * @param {{title?:string, subtitle?:string, blocks:Array}} spec
 *   block: {type:'h1'|'h2'|'h3'|'p'|'bullet'|'quote'|'table'|'pagebreak', text?, rows?}
 */
function buildDocx(spec) {
  const blocks = spec.blocks || [];
  let body = '';
  if (spec.title) body += p(spec.title, { bold: true, size: 40, align: 'center', spacing: 120 });
  if (spec.subtitle) body += p(spec.subtitle, { size: 20, color: '808080', align: 'center', spacing: 40 });

  for (const b of blocks) {
    if (!b) continue;
    if (b.type === 'h1') body += p(b.text, { bold: true, size: 32, spacing: 140 });
    else if (b.type === 'h2') body += p(b.text, { bold: true, size: 28, spacing: 110 });
    else if (b.type === 'h3') body += p(b.text, { bold: true, size: 24, spacing: 90 });
    else if (b.type === 'bullet') body += p(b.text, { bullet: true, size: 22, spacing: 40 });
    else if (b.type === 'quote') body += p(b.text, { size: 21, color: '595959', spacing: 40 });
    else if (b.type === 'table') body += table(b.rows || []);
    else if (b.type === 'pagebreak') body += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    else body += p(b.text, { size: 22 });
  }
  if (!body) body = p('（空文档）');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1100" w:bottom="1200" w:left="1100" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;

  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="420" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/numbering.xml', data: numbering },
  ]);
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------
const EMU_W = 12192000;
const EMU_H = 6858000;
const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="WFai">
<a:themeElements>
<a:clrScheme name="WFai">
<a:dk1><a:srgbClr val="1B1917"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="3A3A3A"/></a:dk2><a:lt2><a:srgbClr val="F5F1E8"/></a:lt2>
<a:accent1><a:srgbClr val="F6CF9B"/></a:accent1><a:accent2><a:srgbClr val="5AD19A"/></a:accent2>
<a:accent3><a:srgbClr val="E8B45C"/></a:accent3><a:accent4><a:srgbClr val="8AB4F8"/></a:accent4>
<a:accent5><a:srgbClr val="E2705F"/></a:accent5><a:accent6><a:srgbClr val="B39DDB"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="WFai"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Arial"/><a:ea typeface="${FONT}"/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="WFai">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme></a:themeElements></a:theme>`;

function txBox(id, name, x, y, cx, cy, paragraphs) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${xmlEsc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>
<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function para(text, opts = {}) {
  const { size = 1800, bold = false, color = '1B1917', align = 'l', bullet = false } = opts;
  const ppr = `<a:pPr algn="${align}"${bullet ? ' marL="342900" indent="-342900"' : ''}>${bullet ? '<a:buChar char="•"/>' : '<a:buNone/>'}</a:pPr>`;
  return `<a:p>${ppr}<a:r><a:rPr lang="zh-CN" sz="${size}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/><a:ea typeface="${FONT}"/></a:rPr><a:t>${xmlEsc(text)}</a:t></a:r></a:p>`;
}

function slideXml(slide, index, total) {
  const isTitle = slide.kind === 'title';
  const shapes = [];
  if (isTitle) {
    shapes.push(txBox(2, 'title', 838200, 2132000, EMU_W - 1676400, 1400000,
      para(slide.title || '未命名', { size: 4400, bold: true, color: '1B1917' })));
    if (slide.subtitle) {
      shapes.push(txBox(3, 'subtitle', 838200, 3600000, EMU_W - 1676400, 900000,
        para(slide.subtitle, { size: 2000, color: '6B6259' })));
    }
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="4" name="accent"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="1900000"/><a:ext cx="914400" cy="63500"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="F6CF9B"/></a:solidFill></p:spPr></p:sp>`);
  } else {
    shapes.push(txBox(2, 'title', 838200, 457200, EMU_W - 1676400, 1000000,
      para(slide.title || '未命名', { size: 3200, bold: true, color: '1B1917' })));
    shapes.push(`<p:sp><p:nvSpPr><p:cNvPr id="3" name="rule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="1500000"/><a:ext cx="10515600" cy="25400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
<a:solidFill><a:srgbClr val="E0D8C8"/></a:solidFill></p:spPr></p:sp>`);
    const bullets = slide.bullets && slide.bullets.length ? slide.bullets : [''];
    const paras = bullets.map((b) => para(b, { size: 1900, bullet: true })).join('');
    shapes.push(txBox(4, 'body', 838200, 1750000, EMU_W - 1676400, 4200000, paras));
    shapes.push(txBox(5, 'pageno', EMU_W - 1600000, EMU_H - 600000, 900000, 400000,
      para(`${index} / ${total}`, { size: 1200, color: '8C857B', align: 'r' })));
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
${shapes.join('\n')}
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/**
 * @param {{title?:string, subtitle?:string, slides:Array<{title:string, bullets?:string[]}>}} spec
 */
function buildPptx(spec) {
  const slides = [{ kind: 'title', title: spec.title || '未命名演示', subtitle: spec.subtitle || '' }]
    .concat((spec.slides || []).map((s) => ({ kind: 'body', title: s.title, bullets: s.bullets })));
  const total = slides.length;

  const files = [];
  const ctOverrides = [];
  const sldIds = [];
  const presRels = [];

  slides.forEach((s, i) => {
    const n = i + 1;
    files.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(s, n, total) });
    files.push({
      name: `ppt/slides/_rels/slide${n}.xml.rels`,
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    });
    ctOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    sldIds.push(`<p:sldId id="${255 + n}" r:id="rId${n + 1}"/>`);
    presRels.push(`<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
  });

  files.push({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
${ctOverrides.join('\n')}
</Types>`,
  });

  files.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
  });

  files.push({
    name: 'ppt/presentation.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSubsetFonts="1">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIds.join('')}</p:sldIdLst>
<p:sldSz cx="${EMU_W}" cy="${EMU_H}"/><p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  });

  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${presRels.join('\n')}
</Relationships>`,
  });

  files.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>
<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr algn="l"><a:defRPr sz="1900"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>
</p:sldMaster>`,
  });

  files.push({
    name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  });

  files.push({
    name: 'ppt/slideLayouts/slideLayout1.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
  });

  files.push({
    name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
  });

  files.push({ name: 'ppt/theme/theme1.xml', data: THEME });

  return zip(files);
}

module.exports = { buildDocx, buildPptx, xmlEsc };
