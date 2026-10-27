/*
 * PersianStream test harness — shims the SkyStream JS worker runtime in Node
 * and runs getHome/search/load/loadStreams against LIVE sites.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { parseHTML } = require('linkedom');

const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ---------------- runtime shim ---------------- */

const store = new Map();

function rawGet(urlStr, headers, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'http:' ? http : https;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({
        'User-Agent': APP_UA,
        'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate',
      }, headers || {}),
      timeout: timeoutMs || 20000,
      rejectUnauthorized: false,
    };
    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && depth < 5) {
        res.resume();
        const next = new URL(res.headers.location, urlStr).href;
        return resolve(rawGet(next, headers, timeoutMs, depth + 1));
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
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

global.manifest = { baseUrl: 'https://www.doostihaa.com', providerId: process.env.PID || null };

global.http_get = (url, headers) => rawGet(url, headers, 20000);

global.http_parallel = (requests) => Promise.all(requests.map(r => rawGet(r.url, r.headers, 20000)));

global.parseHtml = async (html) => parseHTML(html).document;

global.getPreference = (key) => (store.has(key) ? store.get(key) : null); // sync — like the real installer closure
global.setPreference = (key, val) => { store.set(key, String(val)); };

function SkyClass(defaults) {
  return function (params) { Object.assign(this, defaults, params || {}); };
}
global.MultimediaItem = SkyClass({ type: 'movie', status: 'unknown', playbackPolicy: 'none', isAdult: false, streams: [], syncData: {} });
global.Episode = SkyClass({ season: 0, episode: 0, dubStatus: 'none', playbackPolicy: 'none', streams: [] });
global.StreamResult = function (p) {
  this.url = p.url; this.source = p.source || 'Auto'; this.quality = p.quality;
  this.headers = p.headers; this.subtitles = p.subtitles;
  this.drmKid = p.drmKid; this.drmKey = p.drmKey; this.licenseUrl = p.licenseUrl;
};
global.Actor = SkyClass({});
global.Trailer = SkyClass({});
global.NextAiring = SkyClass({});

/* ---------------- load plugin ---------------- */

const pluginSrc = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
vm.runInThisContext(pluginSrc, { filename: 'plugin.js' });

/* ---------------- verification helpers ---------------- */

async function verifyStream(streamUrl, headers) {
  try {
    const h = Object.assign({}, headers || {}, { Range: 'bytes=0-1023' });
    const res = await rawGet(streamUrl, h, 25000);
    const total = (res.headers['content-range'] || '').split('/')[1] || res.headers['content-length'] || '?';
    const ct = res.headers['content-type'] || '?';
    return { status: res.status, ct, total, ok: (res.status === 206 || res.status === 200) && /video|octet|mpegurl/i.test(ct) };
  } catch (e) {
    return { status: 0, ct: String(e).slice(0, 60), total: '?', ok: false };
  }
}

function fmtItem(it, n) {
  return `${n ? n + '. ' : ''}"${(it.title || '').slice(0, 60)}" [${it.type}] url=${(it.url || '').slice(0, 80)} poster=${(it.posterUrl || 'NO').slice(0, 60)} y=${it.year || '?'} s=${it.score || '?'}`;
}

async function runProvider(pid, searchQuery) {
  console.log(`\n${'='.repeat(78)}\nPROVIDER: ${pid}\n${'='.repeat(78)}`);
  global.manifest.providerId = pid;
  store.clear();
  const S = global.PersianStream;

  // getHome
  let home = await new Promise((res, rej) => S.getHome(r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'home failed'))));
  const cats = Object.keys(home);
  console.log('HOME categories:', cats.map(c => `${c}(${(home[c] || []).length})`).join('  '));
  for (const c of cats) {
    if (home[c] && home[c][0]) console.log('   ' + c + ' → ' + fmtItem(home[c][0]));
  }

  // search
  let results = await new Promise((res, rej) => S.search(searchQuery, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'search failed'))));
  console.log(`SEARCH "${searchQuery}": ${results.length} results`);
  results.slice(0, 3).forEach((it, i) => console.log('   ' + fmtItem(it, i + 1)));
  if (!results.length) throw new Error('no search results');

  // load
  const pick = results[0];
  const item = await new Promise((res, rej) => S.load(pick.url, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'load failed'))));
  console.log(`LOAD: "${(item.title || '').slice(0, 70)}" type=${item.type} poster=${(item.posterUrl || 'NO').slice(0, 60)} episodes=${(item.episodes || []).length}`);
  if (!item.episodes || !item.episodes.length) throw new Error('no episodes parsed');

  // loadStreams on first + middle episode
  const epsToTest = item.episodes.length > 3 ? [item.episodes[0], item.episodes[Math.floor(item.episodes.length / 2)]] : item.episodes;
  let verified = 0, failed = 0, geoCount = 0;
  for (const ep of epsToTest) {
    const streams = await new Promise((res, rej) => S.loadStreams(ep.url, r => r && r.success ? res(r.data) : rej(new Error(r && r.message || 'streams failed'))));
    console.log(`EP "${ep.name}" → ${streams.length} streams:`);
    const toVerify = streams.slice(0, 4);
    for (const st of toVerify) {
      const v = await verifyStream(st.url, st.headers);
      const geo = (v.status === 403 && /upera|VPN/i.test(st.url + ' ' + v.ct)) ? ' [geo: IR-IP only]' : '';
      if (v.ok) verified++; else if (geo) geoCount++; else failed++;
      console.log(`   [${v.ok ? 'OK ' : (geo ? 'GEO ' : 'FAIL')}] ${st.source} | q=${st.quality} | ${v.status} ${v.ct} total=${typeof v.total === 'string' ? (Number(v.total) / 1e9).toFixed ? (Number(v.total) / 1e9).toFixed(2) + 'GB' : v.total : v.total}${geo} | ${st.url.slice(0, 85)}`);
    }
  }
  console.log(`STREAM VERIFY: ${verified} OK, ${geoCount} geo(IR), ${failed} failed`);
  if (!verified && !geoCount) throw new Error('no playable streams verified');
  return { home: cats.length, results: results.length, episodes: item.episodes.length, verified, failed, geo: geoCount };
}

(async () => {
  const plan = [
    ['doostihaa', 'inception'],
    ['filmdoon', 'the exit 8'],
    ['namagate', 'inception'],
    ['aparat', 'فیلم دوبله فارسی'],
  ];
  const summary = {};
  for (const [pid, q] of plan) {
    try {
      summary[pid] = await runProvider(pid, q);
      summary[pid].PASS = true;
    } catch (e) {
      console.log(`>>> ${pid} FAILED: ${e.message}`);
      summary[pid] = { PASS: false, error: e.message };
    }
  }
  console.log('\n' + '='.repeat(78));
  console.log('SUMMARY:', JSON.stringify(summary, null, 1));
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
