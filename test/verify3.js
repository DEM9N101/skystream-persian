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

(async () => {
  // moviesho homepage: ALL hrefs sample
  let r = await rawGet('https://moviesho.com/');
  console.log('MOVIESHO home status:', r.status, 'len:', r.body.length);
  const hrefs = [...new Set([...r.body.matchAll(/href="([^"]+)"/g)].map(m => m[1]))];
  const interesting = hrefs.filter(h => /^https?:\/\//.test(h) && !/(wp-|\.css|\.js|\.png|\.jpg|\.ico|\.svg|facebook|telegram|instagram|twitter|youtube|aparat)/i.test(h));
  console.log('absolute hrefs sample:');
  interesting.slice(0, 12).forEach(h => console.log('   ', h.slice(0, 115)));
  const rel = hrefs.filter(h => h.startsWith('/') && !/(wp-|\.css|\.js|\.png|\.jpg|\.ico|\.svg|#)/i.test(h));
  console.log('relative hrefs sample:');
  rel.slice(0, 12).forEach(h => console.log('   ', decodeURIComponent(h).slice(0, 115)));

  // babakfilm post: find iranvids / download markup
  r = await rawGet('https://babakfilm.com/squid-game-2024-season-02/');
  console.log('\nBABAKFILM post status:', r.status, 'len:', r.body.length);
  for (const kw of ['iranvids', 'دانلود', 'download', 'لینک']) {
    const i = r.body.indexOf(kw);
    if (i >= 0) {
      console.log(`CTX [${kw}]:`, r.body.slice(Math.max(0, i - 150), i + 400).replace(/\s+/g, ' ').slice(0, 480));
      break;
    }
  }
  // any mp4/mkv anywhere?
  const media = [...new Set([...r.body.matchAll(/https?:\/\/[^"'\s<>]+?\.(?:mp4|mkv|zip|rar)[^"'\s<>]*/g)].map(m => m[0]))];
  console.log('media urls in page:', media.length); media.slice(0, 6).forEach(m => console.log('   ', m.slice(0, 120)));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
