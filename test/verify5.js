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
  // 1) Range-verify a moviesho stream MYSELF
  let r = await rawGet('https://sr1moviesho.musitraf.com/Movie/2026/07/Newborn.2026.480p.Farsi.Subbed.mkv', { Range: 'bytes=0-1023' });
  console.log('VERIFY moviesho stream:', r.status, r.headers['content-type'], r.headers['content-range']);

  // 2) REST with _embed for posters
  r = await rawGet('https://moviesho.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('silo') + '&per_page=5&_embed=wp:featuredmedia&_fields=id,link,title,_links,_embedded');
  const posts = JSON.parse(r.body);
  for (const p of posts.slice(0, 3)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    const med = p._embedded && p._embedded['wp:featuredmedia'] && p._embedded['wp:featuredmedia'][0];
    console.log(`REST+embed: "${t.slice(0, 45)}" | poster: ${med ? (med.source_url || '').slice(0, 80) : 'none'} | link: ${p.link.slice(0, 70)}`);
  }

  // 3) a SERIES post: full anchor dump with classes
  const seriesSearch = await rawGet('https://moviesho.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('tulsa king') + '&per_page=3&_fields=id,link,title');
  const sp = JSON.parse(seriesSearch.body);
  for (const p of sp.slice(0, 2)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    const pr = await rawGet(p.link);
    const anchors = [...pr.body.matchAll(/<a[^>]+class="([^"]*download-link[^"]*)"[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,160}?)<\/a>/g)];
    console.log(`\nSERIES "${t.slice(0, 45)}" ${p.link.slice(0, 60)} → ${anchors.length} download anchors`);
    anchors.slice(0, 6).forEach(m => console.log('   ', (m[1] || '').slice(0, 45), '|', decode(m[2]).slice(0, 120), '|', m[3].replace(/<[^>]+>/g, ' ').trim().slice(0, 30)));
    // episode/season info in filenames
    const fns = anchors.map(m => decode(m[2]));
    const seEps = [...new Set(fns.map(f => (f.match(/S(\d{1,2})E(\d{1,3})/i) || []).slice(1).join(':')))].filter(Boolean);
    console.log('   S/E in filenames:', seEps.slice(0, 8).join('  '));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
