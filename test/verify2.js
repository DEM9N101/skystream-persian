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
function decode(s) { return String(s || '').replace(/&#8211;/g, '-').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"'); }

(async () => {
  // babakfilm: get post URLs from REST, fetch page, dump anchors
  let r = await rawGet('https://www.babakfilm.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('squid game season') + '&per_page=3&_fields=id,link,title');
  const bp = JSON.parse(r.body);
  for (const p of bp.slice(0, 2)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    r = await rawGet(p.link);
    const anchors = [...r.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,140}?)<\/a>/g)];
    console.log(`BABAKFILM "${t.slice(0, 50)}" [${p.link.slice(0, 60)}] → ${anchors.length} anchors`);
    anchors.slice(0, 4).forEach(m => console.log('   ', decode(m[1]).slice(0, 120), '|', m[2].replace(/<[^>]+>/g, ' ').trim().slice(0, 40)));
    const og = (r.body.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/) || [])[1];
    console.log('    og:image:', og ? decode(og).slice(0, 90) : 'none');
  }

  // moviesho: homepage → post URL pattern
  r = await rawGet('https://moviesho.com/');
  const hrefs = [...new Set([...r.body.matchAll(/href="(https?:\/\/moviesho\.com\/[^"]+)"/g)].map(m => decode(m[1])))];
  const postish = hrefs.filter(u => !/(category|genre|tag|\/page\/|wp-|author|feed|\.css|\.js|\.png|\.jpg|\.ico|#|\?|account|login|register|about|contact|dmca|request|report)/i.test(u));
  console.log('\nMOVIESHO homepage post-ish URLs:');
  postish.slice(0, 10).forEach(u => console.log('   ', u.slice(0, 110)));
  // fetch first 2 and dump anchors
  for (const u of postish.slice(0, 2)) {
    r = await rawGet(u);
    const anchors = [...r.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,140}?)<\/a>/g)];
    console.log(`  POST ${u.slice(0, 70)} → ${anchors.length} anchors`);
    anchors.slice(0, 4).forEach(m => console.log('     ', decode(m[1]).slice(0, 125), '|', m[2].replace(/<[^>]+>/g, ' ').trim().slice(0, 35)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
