/*
 * PersianStream v3 test harness — merged-provider flow against LIVE sites.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const zlib = require('zlib');
const { parseHTML } = require('linkedom');

const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const store = new Map();

function rawGet(urlStr, headers, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({
        'User-Agent': APP_UA, 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7', 'Accept-Encoding': 'gzip',
      }, headers || {}),
      timeout: timeoutMs || 20000, rejectUnauthorized: false,
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && depth < 5) {
        res.resume();
        return resolve(rawGet(new URL(res.headers.location, urlStr).href, headers, timeoutMs, depth + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) {}
        resolve({ status: res.statusCode, body: buf.toString('utf8'), headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

global.manifest = { baseUrl: 'https://www.doostihaa.com' };
global.http_get = (url, headers) => rawGet(url, headers, 20000);
global.http_parallel = (requests) => Promise.all(requests.map(r => rawGet(r.url, r.headers, 20000)));
global.parseHtml = async (html) => parseHTML(html).document;
global.getPreference = (key) => (store.has(key) ? store.get(key) : null); // sync, like real installer
global.setPreference = (key, val) => { store.set(key, String(val)); };

function SkyClass(defaults) { return function (params) { Object.assign(this, defaults, params || {}); }; }
global.MultimediaItem = SkyClass({ type: 'movie', status: 'unknown', playbackPolicy: 'none', isAdult: false, streams: [], syncData: {} });
global.Episode = SkyClass({ season: 0, episode: 0, dubStatus: 'none', playbackPolicy: 'none', streams: [] });
global.StreamResult = function (p) {
  this.url = p.url; this.source = p.source || 'Auto'; this.quality = p.quality;
  this.headers = p.headers; this.subtitles = p.subtitles;
  this.drmKid = p.drmKid; this.drmKey = p.drmKey; this.licenseUrl = p.licenseUrl;
};
global.Actor = SkyClass({}); global.Trailer = SkyClass({}); global.NextAiring = SkyClass({});

vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8'));

async function verifyStream(streamUrl, headers) {
  try {
    const res = await rawGet(streamUrl, Object.assign({}, headers || {}, { Range: 'bytes=0-1023' }), 25000);
    const total = (res.headers['content-range'] || '').split('/')[1] || res.headers['content-length'] || '?';
    const ct = res.headers['content-type'] || '';
    const ok = (res.status === 206 || res.status === 200) &&
      (/video|octet|mpegurl|matroska/i.test(ct) || (res.status === 206 && total !== '?'));
    return { status: res.status, ct: ct || '?', total, ok };
  } catch (e) {
    return { status: 0, ct: String(e).slice(0, 50), total: '?', ok: false };
  }
}

function gb(total) {
  const n = Number(total);
  return Number.isFinite(n) && n > 1000 ? (n / 1e9).toFixed(2) + 'GB' : String(total);
}

const S = global.PersianStream;

(async () => {
  let pass = true;

  // 1) getHome
  const home = await new Promise((res, rej) => S.getHome(r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'home failed'))));
  const cats = Object.keys(home);
  console.log('HOME:', cats.map(c => `${c}(${(home[c] || []).length})`).join('  '));
  if (home['Trending'] && home['Trending'][0]) console.log('   Trending[0]:', home['Trending'][0].title, '|', home['Trending'][0].posterUrl);
  if (home['Latest Movies'] && home['Latest Movies'][0]) console.log('   Movies[0]:', home['Latest Movies'][0].title);

  // 2) merged search — movie
  for (const q of ['inception', 'money heist']) {
    const results = await new Promise((res, rej) => S.search(q, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'search failed'))));
    console.log(`\nSEARCH "${q}": ${results.length} merged results`);
    results.slice(0, 4).forEach((it, i) =>
      console.log(`   ${i + 1}. "${it.title}" [${it.type}] y=${it.year || '?'} s=${it.score || '?'} poster=${(it.posterUrl || 'NO') ? 'yes' : 'NO'} url=${it.url.slice(0, 90)}`));
    if (!results.length) { console.log('   >>> no results'); pass = false; continue; }

    // 3) load merged item
    const item = await new Promise((res, rej) => S.load(results[0].url, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'load failed'))));
    const seasons = [...new Set((item.episodes || []).map(e => e.season))].sort((a, b) => a - b);
    console.log(`LOAD "${item.title}" type=${item.type} episodes=${(item.episodes || []).length} seasons=${seasons.join(',')}`);
    if (!item.episodes || !item.episodes.length) { console.log('   >>> no episodes'); pass = false; continue; }

    // 4) streams on first episode (+ one mid for series)
    const eps = item.episodes.length > 4
      ? [item.episodes[0], item.episodes[Math.floor(item.episodes.length / 2)]]
      : item.episodes;
    let verified = 0, failed = 0;
    for (const ep of eps) {
      const streams = await new Promise((res, rej) => S.loadStreams(ep.url, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'streams failed'))));
      console.log(`   ${ep.name} (S${ep.season}E${ep.episode}) → ${streams.length} options:`);
      for (const st of streams.slice(0, 6)) {
        const v = await verifyStream(st.url, st.headers);
        if (v.ok) verified++; else failed++;
        console.log(`      [${v.ok ? 'OK  ' : 'FAIL'}] ${st.source} | ${v.status} ${v.ct} ${gb(v.total)} | ${st.url.slice(0, 90)}`);
      }
    }
    console.log(`   VERIFY: ${verified} OK, ${failed} failed`);
    if (!verified) pass = false;
  }

  console.log('\n' + (pass ? '=== ALL CHECKS PASSED ===' : '=== FAILURES PRESENT ==='));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
