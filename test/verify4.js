'use strict';
const https = require('https'); const zlib = require('zlib');
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
function rawGet(urlStr, headers, timeoutMs, depth = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET',
      headers: Object.assign({ 'User-Agent': APP_UA, 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7', 'Accept-Encoding': 'gzip' }, headers || {}),
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
function decode(s) { return String(s || '').replace(/&#8211;/g, '-').replace(/&amp;/g, '&'); }

(async () => {
  const r = await rawGet('https://moviesho.com/wp-json/wp/v2/posts?per_page=8&_fields=id,link,title');
  const posts = JSON.parse(r.body);
  for (const p of posts.slice(0, 4)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    console.log(`POST "${t.slice(0, 50)}" → ${p.link}`);
    const pr = await rawGet(p.link);
    const anchors = [...pr.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,150}?)<\/a>/g)];
    console.log(`   anchors: ${anchors.length}`);
    anchors.slice(0, 5).forEach(m => console.log('     ', decode(m[1]).slice(0, 130), '|', m[2].replace(/<[^>]+>/g, ' ').trim().slice(0, 40)));
  }
  // also a SERIES page via /series/ archive
  const s = await rawGet('https://www.moviesho.com/series/');
  const seriesLinks = [...new Set([...s.body.matchAll(/href="(https:\/\/www\.moviesho\.com\/series\/[a-z0-9][^"]+\/)"/g)].map(m => decode(m[1])))]
    .filter(u => !/category|page\//.test(u));
  console.log('\nseries archive posts:', seriesLinks.slice(0, 3));
  if (seriesLinks.length) {
    const pr = await rawGet(seriesLinks[0]);
    const anchors = [...pr.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,150}?)<\/a>/g)];
    console.log(`SERIES POST ${seriesLinks[0].slice(0, 60)} → ${anchors.length} anchors`);
    anchors.slice(0, 6).forEach(m => console.log('     ', decode(m[1]).slice(0, 135), '|', m[2].replace(/<[^>]+>/g, ' ').trim().slice(0, 35)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
