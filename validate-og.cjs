#!/usr/bin/env node
/*
 * Framework-agnostic Open Graph / social-card validator.
 *
 * Modes:
 *   node validate-og.cjs --url https://example.com[/path]   (validate a LIVE page)
 *   node validate-og.cjs --dir ./public [--home-only]        (validate built HTML in a dir)
 *   node validate-og.cjs --dir ./public --all                (audit every *.html in dir)
 *
 * What it enforces (matches the link-preview contract WhatsApp / iMessage /
 * LinkedIn / Slack need):
 *   - og:image present, and the referenced image is reachable (HTTP 200) and
 *     has real pixel dimensions >= 200x200 (warn < 600x315).
 *   - og:image is an absolute https:// URL.
 *   - twitter:card == "summary_large_image" and twitter:image present.
 *   - og:title, og:description, og:type present.
 *
 * Exit code 1 = at least one FAIL (so it can gate a deploy pipeline).
 * Exit code 0 = all checks passed (or only warnings).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const argv = process.argv.slice(2);
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const hasFlag = (name) => argv.includes(name);

const URL_MODE = hasFlag('--url');
const DIR_MODE = hasFlag('--dir');
const urlArg = getArg('--url');
const dirArg = getArg('--dir');
const HOME_ONLY = hasFlag('--home-only');
const ALL = hasFlag('--all');
const WAIT_FOR_IMAGE = getArg('--wait-for-image'); // substring the og:image must contain
const POLL_TIMEOUT = parseInt(getArg('--poll-timeout') || '480', 10);

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'");
}
function getAttr(tag, attr) {
  const re = new RegExp(`${attr}=["']?([^"'>\\s]+)`, 'i');
  const m = tag.match(re);
  return m ? decodeEntities(m[1]) : null;
}
function findMeta(html, key, attr = 'property') {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}=["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[^>]*>`, 'i');
  const m = html.match(re);
  return m ? getAttr(m[0], 'content') : null;
}
function findTag(html, key, attr = 'property') {
  const re = new RegExp(`<meta\\b[^>]*\\b${attr}=["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?[^>]*>`, 'i');
  const m = html.match(re);
  return m ? m[0] : null;
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'og-check/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(new URL(res.headers.location, url).toString()).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = res.headers['content-type'] || '';
        resolve({ status: res.statusCode, buffer: buf, body: ct.includes('text') || ct.includes('html') || ct.includes('xml') ? buf.toString('utf8') : '', contentType: ct });
      });
    }).on('error', reject);
  });
}

function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 8) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xc0 || m === 0xc1 || m === 0xc2 || m === 0xc3) {
        const h = (buf[i + 5] << 8) | buf[i + 6];
        const w = (buf[i + 7] << 8) | buf[i + 8];
        return { w, h };
      }
      const len = (buf[i + 2] << 8) | buf[i + 3];
      i += 2 + len;
    }
    return null;
  }
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return null;
}

const recs = [];
function record(level, msg, detail) {
  const icon = level === 'FAIL' ? '❌' : level === 'WARN' ? '⚠️' : '✅';
  recs.push({ level, msg, detail });
  console.log(`${icon} ${level}: ${msg}${detail ? ` — ${detail}` : ''}`);
}

function httpStatus(url) {
  return httpGet(url).then((r) => r.status);
}

async function validateHtml(html, label, baseOrigin) {
  const ogTitle = findMeta(html, 'og:title');
  const ogDesc = findMeta(html, 'og:description');
  const ogType = findMeta(html, 'og:type');
  const ogImage = findMeta(html, 'og:image');
  const twCard = findMeta(html, 'twitter:card', 'name');
  const twImage = findMeta(html, 'twitter:image', 'name') || findMeta(html, 'twitter:image', 'property');

  if (!ogTitle) record('FAIL', `[${label}] og:title missing — share shows no title`, 'bare link');
  if (!ogDesc) record('WARN', `[${label}] og:description missing`, '');
  if (!ogType) record('WARN', `[${label}] og:type missing`, '');

  if (!ogImage) {
    record('FAIL', `[${label}] og:image missing — no preview image (bare link)`, 'WhatsApp/iMessage/LinkedIn render nothing');
  } else {
    let abs = ogImage;
    if (ogImage.startsWith('//')) abs = 'https:' + ogImage;
    else if (ogImage.startsWith('/')) abs = baseOrigin + ogImage;
    else if (!/^https?:\/\//.test(ogImage)) abs = baseOrigin + '/' + ogImage.replace(/^\//, '');
    if (!/^https:\/\//.test(abs)) record('FAIL', `[${label}] og:image not absolute https`, abs);
    let st = 0;
    try { const r = await httpGet(abs); st = r.status; } catch { st = 0; }
    if (st !== 200) record('FAIL', `[${label}] og:image not reachable (HTTP ${st})`, abs);
    else {
      let buf = Buffer.alloc(0);
      try { const r = await httpGet(abs); buf = r.buffer || Buffer.alloc(0); } catch {}
      const dim = imageSize(buf);
      if (!dim) {
        if (/\.svg$/i.test(abs)) record('OK', `[${label}] og:image ok (svg, no raster dims)`, abs);
        else record('WARN', `[${label}] og:image dimensions unreadable`, abs);
      } else if (dim.w < 200 || dim.h < 200) {
        record('FAIL', `[${label}] og:image too small (${dim.w}x${dim.h}, need >=200x200)`, abs);
      } else {
        if (dim.w < 600 || dim.h < 315) record('WARN', `[${label}] og:image small (${dim.w}x${dim.h}, recommend >=600x315)`, abs);
        else record('OK', `[${label}] og:image ok (${dim.w}x${dim.h})`, abs);
      }
    }
  }

  if (!twCard) record('FAIL', `[${label}] twitter:card missing`, '');
  else if (twCard !== 'summary_large_image') record('FAIL', `[${label}] twitter:card != summary_large_image (${twCard})`, '');
  if (!twImage) record('FAIL', `[${label}] twitter:image missing`, '');
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

async function main() {
  let pages = [];
  if (URL_MODE && urlArg) {
    const u = urlArg;
    const origin = new URL(u).origin;
    console.log(`Validating live URL: ${u}\n`);

    // Deploy-aware wait: if we expect the deploy to flip og:image to a new
    // asset, poll until it appears (or timeout) so we validate the NEW build,
    // not the stale one still served right after `push` to main.
    if (WAIT_FOR_IMAGE) {
      const deadline = Date.now() + POLL_TIMEOUT * 1000;
      let ready = false;
      while (Date.now() < deadline) {
        const probe = await httpGet(u);
        const img = findMeta(probe.body || '', 'og:image');
        if (img && img.includes(WAIT_FOR_IMAGE)) { ready = true; break; }
        process.stdout.write('.');
        await new Promise((r) => setTimeout(r, 15000));
      }
      console.log(ready ? '\n[wait] expected og:image is live, validating now.' : `\n[wait] timed out after ${POLL_TIMEOUT}s waiting for og:image to contain "${WAIT_FOR_IMAGE}"; validating current state.`);
    }

    const r = await httpGet(u);
    if (r.status !== 200) { record('FAIL', `page not reachable (HTTP ${r.status})`, u); process.exit(1); }
    pages.push({ html: r.body, label: u, origin });
  } else if (DIR_MODE && dirArg) {
    const files = walk(dirArg);
    let targets = files;
    if (!ALL && !HOME_ONLY) {
      const home = files.find((f) => {
        const rel = path.relative(dirArg, f);
        return rel === 'index.html' || rel === path.join('index.html');
      }) || files.find((f) => /(^|\/)index\.html$/.test(f));
      targets = home ? [home] : files.slice(0, 1);
    }
    console.log(`Validating ${targets.length} page(s) in ${dirArg}\n`);
    for (const f of targets) {
      const html = fs.readFileSync(f, 'utf8');
      const rel = path.relative(dirArg, f);
      const origin = 'https://PLACEHOLDER.invalid';
      pages.push({ html, label: rel || 'index.html', origin });
    }
  } else {
    console.error('Usage:\n  node validate-og.cjs --url https://example.com\n  node validate-og.cjs --dir ./public [--home-only|--all]');
    process.exit(2);
  }

  for (const p of pages) await validateHtml(p.html, p.label, p.origin);

  const fails = recs.filter((r) => r.level === 'FAIL').length;
  console.log(`\n${fails === 0 ? '✅ PASS' : '❌ FAIL'} — ${fails} failure(s), ${recs.filter(r=>r.level==='WARN').length} warning(s).`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
