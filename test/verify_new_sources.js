'use strict';
// Verify moviesho.com + babakfilm.com structures for plugin integration
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
function decode(s) { return String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"'); }

(async () => {
  // ---- moviesho: REST search shape
  let r = await rawGet('https://moviesho.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('money heist') + '&per_page=6&_fields=id,link,title,content');
  console.log('MOVIESHO REST search:', r.status);
  let posts = []; try { posts = JSON.parse(r.body); } catch (e) {}
  for (const p of posts.slice(0, 4)) {
    const t = String(p.title && p.title.rendered || '').replace(/<[^>]+>/g, '');
    const links = [...new Set([...p.content.rendered.matchAll(/href="([^"]+?\.(?:mp4|mkv)[^"]*)"/g)].map(m => decode(m[1])))];
    console.log(`  post: "${t.slice(0, 55)}" | media links: ${links.length}`);
    links.slice(0, 3).forEach(l => console.log('     ', l.slice(0, 120)));
    const img = (p.content.rendered.match(/<img[^>]+src="([^"]+)"/) || [])[1];
    if (img) console.log('      img:', decode(img).slice(0, 100));
  }

  // ---- moviesho: HTML search + series post structure
  r = await rawGet('https://moviesho.com/?s=' + encodeURIComponent('silo'));
  console.log('\nMOVIESHO ?s= search:', r.status);
  const htmlPosts = [...new Set([...r.body.matchAll(/href="(https:\/\/moviesho\.com\/[a-z0-9][^"]{6,}\/)"/g)].map(m => m[1]))]
    .filter(u => !/(category|genre|tag|page|wp-|author|feed|app|#)/.test(u));
  console.log('  html search posts:', htmlPosts.slice(0, 4));

  // series page structure (a known one from scout: series archive)
  r = await rawGet('https://moviesho.com/?s=' + encodeURIComponent('tulsa king'));
  const tulsa = [...new Set([...r.body.matchAll(/href="(https:\/\/moviesho\.com\/[^"]*tulsa[^"]*)"/g)].map(m => m[1]))].filter(u => !/category|tag|page/.test(u));
  console.log('  tulsa links:', tulsa.slice(0, 3));
  if (tulsa.length) {
    r = await rawGet(tulsa[0]);
    const links = [...r.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"[^>]*>([\s\S]{0,120}?)<\/a>/g)];
    console.log(`  SERIES post ${tulsa[0].slice(0, 60)}: ${links.length} media anchors`);
    links.slice(0, 6).forEach(m => console.log('     ', decode(m[1]).slice(0, 125), '|', m[2].replace(/<[^>]+>/g, ' ').trim().slice(0, 30)));
    const og = (r.body.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/) || [])[1];
    console.log('      og:image:', og ? decode(og).slice(0, 90) : 'none');
    const h1 = (r.body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
    console.log('      h1:', h1 ? h1.replace(/<[^>]+>/g, '').trim().slice(0, 60) : 'none');
  }

  // ---- babakfilm: REST search + post links
  r = await rawGet('https://www.babakfilm.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('squid game') + '&per_page=5&_fields=id,link,title,content');
  console.log('\nBABAKFILM REST:', r.status);
  posts = []; try { posts = JSON.parse(r.body); } catch (e) {}
  for (const p of posts.slice(0, 3)) {
    const t = String(p.title && p.title.rendered || '').replace(/<[^>]+>/g, '');
    const links = [...new Set([...p.content.rendered.matchAll(/href="([^"]+?\.(?:mp4|mkv)[^"]*)"/g)].map(m => decode(m[1])))];
    console.log(`  post: "${t.slice(0, 55)}" | media: ${links.length}`);
    links.slice(0, 3).forEach(l => console.log('     ', l.slice(0, 120)));
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
