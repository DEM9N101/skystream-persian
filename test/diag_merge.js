// Diagnose sibling-season merge for Money Heist — per-candidate season maps
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const { parseHTML } = require('linkedom');
const https = require('https'); const zlib = require('zlib');
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
const store = new Map();
function rawGet(urlStr, headers, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': APP_UA, 'Accept-Language': 'fa-IR,fa;q=0.9', 'Accept-Encoding': 'gzip' }, headers || {}),
      timeout: timeoutMs || 25000, rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location && depth < 5) {
        res.resume(); return resolve(rawGet(new URL(res.headers.location, urlStr).href, headers, timeoutMs, depth + 1));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if ((res.headers['content-encoding'] || '').includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch (e) {} }
        resolve({ status: res.statusCode, body: buf.toString('utf8'), headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject); req.end();
  });
}
global.manifest = { baseUrl: 'https://www.doostihaa.com' };
global.http_get = (u, h) => rawGet(u, h, 25000);
global.http_parallel = (rs) => Promise.all(rs.map(r => rawGet(r.url, r.headers, 25000)));
global.parseHtml = async (h) => parseHTML(h).document;
global.getPreference = (k) => (store.has(k) ? store.get(k) : null);
global.setPreference = (k, v) => { store.set(k, String(v)); };
function SkyClass(d) { return function (p) { Object.assign(this, d, p || {}); }; }
global.MultimediaItem = SkyClass({ type: 'movie' }); global.Episode = SkyClass({});
global.StreamResult = function (p) { Object.assign(this, p); };
global.Actor = SkyClass({}); global.Trailer = SkyClass({}); global.NextAiring = SkyClass({});
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8'));
const S = global.PersianStream;

(async () => {
  const r = await rawGet('https://www.doostihaa.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('Money Heist') + '&per_page=12&_fields=id,link,title,date');
  const posts = JSON.parse(r.body);
  console.log('candidates:', posts.length);
  for (const p of posts.slice(0, 12)) {
    const title = String(p.title.rendered).replace(/<[^>]+>/g, '');
    try {
      const item = await Promise.race([
        new Promise((res2) => S.load('ps:' + JSON.stringify({ doostihaa: p.link }), rr => rr && rr.success ? res2(rr.data) : res2(null))),
        new Promise(res2 => setTimeout(() => res2(null), 60000)),
      ]);
      if (!item) { console.log(`  [load-fail ] ${title.slice(0, 52)}`); continue; }
      const seasons = {};
      (item.episodes || []).forEach(e => { (seasons[e.season] = seasons[e.season] || []).push(e.episode); });
      const sm = Object.keys(seasons).sort((a, b) => a - b).map(s => `S${s}:${Math.max(...seasons[s])}ep`).join(',');
      console.log(`  [ok        ] "${title.slice(0, 45)}" → tmdb="${item.title.slice(0, 32)}" | ${sm}`);
    } catch (e) {
      console.log(`  [error     ] ${title.slice(0, 52)} :: ${e.message.slice(0, 60)}`);
    }
  }
  process.exit(0);
})();
