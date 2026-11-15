#!/usr/bin/env node
// Builds tiny sites in a temp dir and checks validate-og.cjs passes or fails them.
//   node test/run.cjs
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const VALIDATOR = path.join(__dirname, '..', 'validate-og.cjs');
const SITE = 'https://example.test';

// Minimal valid PNG of any size (one filtered scanline per row, all black).
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const head = (meta) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title>${meta}</head><body><p>hi</p></body></html>`;
const good = (img = '/og.png', extra = '') => [
  `<meta property="og:title" content="A title">`,
  `<meta property="og:description" content="A description">`,
  `<meta property="og:type" content="website">`,
  `<meta property="og:image" content="${SITE}${img}">`,
  `<meta name="twitter:card" content="summary_large_image">`,
  `<meta name="twitter:image" content="${SITE}${img}">`,
  extra,
].join('');

const cases = [
  { name: 'good page', html: head(good()), expect: 0 },
  { name: 'good page, declared size matches', html: head(good('/og.png', '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">')), expect: 0 },
  { name: 'unquoted, reordered (minify-html output)', html: head(good().replace('<meta property="og:image" content="https://example.test/og.png">', '<meta content=https://example.test/og.png property=og:image>')), expect: 1, output: /og:image tag not in the form WhatsApp reads/ },
  { name: 'og:image missing', html: head(good().replace(/<meta property="og:image"[^>]*>/, '')), expect: 1, output: /og:image missing/ },
  { name: 'og:image file missing from build', html: head(good('/missing.png')), expect: 1, output: /not in the build/ },
  { name: 'og:image relative', html: head(good().replace(`content="${SITE}/og.png"`, 'content="/og.png"')), expect: 1, output: /relative/ },
  { name: 'og:image too small', html: head(good('/tiny.png')), expect: 1, output: /too small/ },
  { name: 'og:image too heavy', html: head(good('/heavy.png')), expect: 1, output: /KB; WhatsApp drops/ },
  { name: 'og:image is svg', html: head(good('/og.svg')), expect: 1, output: /SVG/ },
  { name: 'og tags in body', html: head('').replace('<p>hi</p>', good()), expect: 1, output: /outside <head>/ },
  { name: 'player card with twitter:player', html: head(good().replace('content="summary_large_image"', 'content="player"') + '<meta name="twitter:player" content="https://example.test/embed">'), expect: 0 },
  { name: 'player card without twitter:player', html: head(good().replace('content="summary_large_image"', 'content="player"')), expect: 1, output: /use summary_large_image/ },
  { name: 'summary card (warning only)', html: head(good().replace('content="summary_large_image"', 'content="summary"')), expect: 0, output: /twitter:card is summary/ },
  { name: 'declared size wrong (warning only)', html: head(good('/og.png', '<meta property="og:image:width" content="800">')), expect: 0, output: /say 800x\?/ },
];

let failed = 0;
for (const c of cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogtest-'));
  fs.writeFileSync(path.join(dir, 'og.png'), png(1200, 630));
  fs.writeFileSync(path.join(dir, 'tiny.png'), png(100, 100));
  // Random bytes after IEND keep the file valid for the header check and heavy.
  fs.writeFileSync(path.join(dir, 'heavy.png'), Buffer.concat([png(1200, 630), require('crypto').randomBytes(700 * 1024)]));
  fs.writeFileSync(path.join(dir, 'og.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>');
  fs.writeFileSync(path.join(dir, 'index.html'), c.html);
  const r = spawnSync(process.execPath, [VALIDATOR, '--dir', dir, '--site', SITE], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  const ok = r.status === c.expect && (!c.output || c.output.test(out));
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.name} (exit ${r.status}, want ${c.expect})`);
  if (!ok) console.log(out.split('\n').map((l) => '     ' + l).join('\n'));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} case(s) failed` : `\nall ${cases.length} cases passed`);
process.exit(failed ? 1 : 0);
