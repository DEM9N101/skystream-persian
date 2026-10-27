'use strict';
const https = require('https'); const zlib = require('zlib');
const APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';
function rawGet(urlStr, headers, timeoutMs, depth = 0) {
  return new Promise((resolve) => {
    let u; try { u = new URL(urlStr); } catch (e) { return resolve({ status: 0, body: '', headers: {} }); }
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
    req.on('error', e => resolve({ status: 0, body: '', headers: {}, err: String(e).slice(0, 40) }));
    req.end();
  });
}
function decode(s) { return String(s || '').replace(/&#8211;/g, '-').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'"); }

(async () => {
  // ===== F2MC.TOP (Film2Media)
  console.log('===== F2MC.TOP =====');
  let r = await rawGet('https://www.f2mc.top/?s=' + encodeURIComponent('fallout'), {}, 25000);
  console.log('search:', r.status);
  const f2posts = [...new Set([...r.body.matchAll(/href="(https:\/\/www\.f2mc\.top\/\d+\/[^"]+\/)"/g)].map(m => decode(m[1])))].slice(0, 3);
  console.log('posts:', f2posts.slice(0, 2));
  if (f2posts.length) {
    r = await rawGet(f2posts[0], {}, 30000);
    const onclicks = [...r.body.matchAll(/handleDownloadClick\(['"]([^'"]+)['"]/g)].map(m => decode(m[1]));
    const hrefs = [...r.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"/g)].map(m => decode(m[1]));
    const all = [...new Set([...onclicks, ...hrefs])];
    console.log(`post: ${anchors(all)} media candidates`);
    all.slice(0, 4).forEach(u => console.log('   ', u.slice(0, 125)));
    if (all.length) {
      const v = await rawGet(all[0], { Range: 'bytes=0-1000' }, 20000);
      console.log('   VERIFY:', v.status, v.headers['content-type'], (v.headers['content-range'] || '').slice(0, 30));
    }
  }
  function anchors(arr) { return arr.length; }

  // ===== MOVIELANDZ.COM
  console.log('\n===== MOVIELANDZ =====');
  r = await rawGet('https://movielandz.com/wp-json/wp/v2/posts?search=' + encodeURIComponent('fallout') + '&per_page=4&_fields=id,link,title,content');
  let posts = []; try { posts = JSON.parse(r.body); } catch (e) {}
  console.log('REST:', r.status, '| posts:', posts.length);
  for (const p of posts.slice(0, 2)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    const links = [...new Set([...p.content.rendered.matchAll(/href="([^"]+?\.(?:mp4|mkv)[^"]*)"/g)].map(m => decode(m[1])))];
    console.log(`  "${t.slice(0, 50)}" | media in REST content: ${links.length}`);
    links.slice(0, 3).forEach(l => console.log('     ', l.slice(0, 120)));
    if (links.length) {
      const v = await rawGet(links[0], { Range: 'bytes=0-1000' }, 20000);
      console.log('     VERIFY:', v.status, v.headers['content-type'], (v.headers['content-range'] || '').slice(0, 30));
    }
  }

  // ===== MIRAMOVIE.TOP
  console.log('\n===== MIRAMOVIE =====');
  r = await rawGet('https://miramovie.top/wp-json/wp/v2/posts?search=' + encodeURIComponent('fallout') + '&per_page=4&_fields=id,link,title');
  posts = []; try { posts = JSON.parse(r.body); } catch (e) {}
  console.log('REST:', r.status, '| posts:', posts.length);
  for (const p of posts.slice(0, 2)) {
    const t = String(p.title.rendered).replace(/<[^>]+>/g, '');
    console.log(`  post: "${t.slice(0, 50)}" | ${p.link.slice(0, 75)}`);
    const pr = await rawGet(p.link, {}, 30000);
    const links = [...new Set([...pr.body.matchAll(/<a[^>]+href="([^"]+?\.(?:mp4|mkv)[^"]*)"/g)].map(m => decode(m[1])))];
    console.log(`    page anchors: ${links.length}`);
    links.slice(0, 3).forEach(l => console.log('     ', l.slice(0, 125)));
    if (links.length) {
      const v = await rawGet(links[0], { Range: 'bytes=0-1000' }, 20000);
      console.log('     VERIFY:', v.status, v.headers['content-type'], (v.headers['content-range'] || '').slice(0, 30));
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
