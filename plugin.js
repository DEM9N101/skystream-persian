/*
 * PersianStream — SkyStream plugin (Gen 2)
 * Persian dubbed movies & series from 4 scraper sources (HTTP, no torrents):
 *   doostihaa  — WordPress REST API, direct mp4/mkv (irdanlod CDN)
 *   filmdoon   — WordPress HTML, direct mp4 (pishtaz CDN)
 *   namagate   — WordPress HTML, direct mp4 (upera CDN; playback needs an Iranian IP)
 *   aparat     — public JSON API, global CDN
 *
 * Runtime notes (SkyStream JS worker):
 *   http_get(url, headers) -> {status, body, headers}   (90s hard limit per call)
 *   http_parallel([{url, headers}]) -> [{status, body}]
 *   await parseHtml(html) -> document (querySelector/querySelectorAll/getAttribute/textContent/innerHTML)
 *   new MultimediaItem({...}) / new Episode({...}) / new StreamResult({url, source, quality, headers})
 *   setPreference(key, val) sync, getPreference(key) -> Promise
 *   btoa() is latin-1 only -> never feed it Persian text.
 */
(function () {
  'use strict';

  var APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  var BASE_HEADERS = { 'User-Agent': APP_UA, 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7' };

  /* ------------------------------------------------------------------ *
   *  Small utils
   * ------------------------------------------------------------------ */

  function manifestBase() {
    try {
      if (typeof manifest !== 'undefined' && manifest && manifest.baseUrl) {
        return String(manifest.baseUrl).replace(/\/+$/, '');
      }
    } catch (e) {}
    return '';
  }

  function providerId() {
    try {
      if (typeof manifest !== 'undefined' && manifest && manifest.providerId) return String(manifest.providerId);
    } catch (e) {}
    return 'doostihaa';
  }

  function withTimeout(promise, ms, fallback) {
    var timer = null;
    var winner = new Promise(function (resolve) {
      timer = setTimeout(function () { resolve(fallback); }, ms);
    });
    return Promise.race([promise, winner]).then(function (v) {
      clearTimeout(timer);
      return v;
    }, function (err) {
      clearTimeout(timer);
      if (fallback !== undefined) return fallback;
      throw err;
    });
  }

  function httpGet(url, headers, timeoutMs, retries) {
    headers = headers || {};
    timeoutMs = timeoutMs || 15000;
    retries = (retries === undefined) ? 1 : retries;
    var attempt = function (n) {
      var p;
      try {
        p = http_get(url, mergeHeaders(BASE_HEADERS, headers));
      } catch (e) {
        p = Promise.reject(e);
      }
      return p.then(function (res) {
        if (!res) throw new Error('empty response');
        return { status: res.status | 0, body: String(res.body || ''), headers: res.headers || {} };
      }).catch(function (err) {
        if (n > 0) return attempt(n - 1);
        throw err;
      });
    };
    return withTimeout(attempt(retries), timeoutMs + 4000, { status: 0, body: '', headers: {} });
  }

  function mergeHeaders(a, b) {
    var out = {};
    var k;
    for (k in a) if (a.hasOwnProperty(k)) out[k] = a[k];
    for (k in b) if (b.hasOwnProperty(k)) out[k] = b[k];
    return out;
  }

  function parallelGets(urls, headers, timeoutMs) {
    var reqs = urls.map(function (u) { return { url: u, headers: mergeHeaders(BASE_HEADERS, headers || {}) }; });
    var p;
    try {
      p = http_parallel(reqs);
    } catch (e) {
      p = Promise.all(reqs.map(function (r) { return httpGet(r.url, r.headers, timeoutMs || 15000, 0); }));
    }
    return withTimeout(Promise.resolve(p).then(function (arr) {
      return (arr || []).map(function (r) {
        return { status: (r && r.status | 0) || 0, body: String((r && r.body) || ''), headers: (r && r.headers) || {} };
      });
    }), (timeoutMs || 15000) + 5000, urls.map(function () { return { status: 0, body: '', headers: {} }; }));
  }

  function absUrl(u, base) {
    u = String(u || '').trim();
    if (!u) return '';
    if (u.indexOf('http') === 0) return u;
    try { return new URL(u, base).href; } catch (e) { return u; }
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, function (m, d) {
        try { return String.fromCharCode(parseInt(d, 10)); } catch (e) { return m; }
      });
  }

  function stripTags(s) {
    return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }

  /* quality detection: returns { h: 1080, label: '1080p' } or { h: 0, label: '' } */
  function qualityOf(text) {
    var t = String(text || '');
    var re = /(2160|1440|1080|720|480|360|240|144)\s*(?:p|P)?/g;
    var m, bestH = 0;
    while ((m = re.exec(t)) !== null) {
      var before = m.index > 0 ? t.charAt(m.index - 1) : '';
      if (before >= '0' && before <= '9') continue; // inside a longer number
      var afterIdx = m.index + m[0].length;
      var after = afterIdx < t.length ? t.charAt(afterIdx) : '';
      if (((after >= '0' && after <= '9') || (after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z'))) continue;
      var h = parseInt(m[1], 10);
      if (h > bestH) bestH = h;
    }
    if (!bestH && /4K|UHD/i.test(t)) bestH = 2160;
    if (!bestH && /\bHD\b/i.test(t)) bestH = 720;
    return { h: bestH, label: bestH ? bestH + 'p' : '' };
  }

  function sourceTags(text) {
    var t = String(text || '').toUpperCase();
    var tags = [];
    if (/BLURAY|BLU-RAY|BDRIP/.test(t)) tags.push('BluRay');
    else if (/WEB[-. ]?DL/.test(t)) tags.push('WEB-DL');
    else if (/WEBRIP/.test(t)) tags.push('WEBRip');
    else if (/HDTV/.test(t)) tags.push('HDTV');
    if (/HDR\b|HDR10/.test(t)) tags.push('HDR');
    if (/DOLBY.?VISION|\bDV\b/.test(t)) tags.push('DV');
    if (/X265|H\.?265|HEVC/.test(t)) tags.push('x265');
    if (/DUBBED|DUB\)/.test(t) || /دوبله/.test(String(text || ''))) tags.push('دوبله');
    if (/SUBBED|SUB\)/.test(t) || /زیرنویس/.test(String(text || ''))) tags.push('زیرنویس');
    return tags.join(' ');
  }

  function streamQualityNumber(q) {
    var v = qualityOf(q);
    if (v.h) return v.h;
    if (/4K|UHD/i.test(String(q))) return 2160;
    return 0;
  }

  function sortStreamsDesc(streams) {
    return streams.slice().sort(function (a, b) {
      var qa = a.quality === 'Auto' ? 9999 : streamQualityNumber(a.quality);
      var qb = b.quality === 'Auto' ? 9999 : streamQualityNumber(b.quality);
      return qb - qa;
    });
  }

  function dedupe(list, keyFn) {
    var seen = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var k = keyFn(list[i]);
      if (!k || seen[k]) continue;
      seen[k] = 1;
      out.push(list[i]);
    }
    return out;
  }

  function isMovieUrl(url) {
    return !/(\/series\/|\/anime\/|serial|series|-s\d{2}e\d{2}|S\d{2}E\d{2})/i.test(String(url || ''));
  }

  function guessType(url, hint) {
    if (hint) return hint;
    return isMovieUrl(url) ? 'movie' : 'series';
  }

  function yearFrom(text) {
    var m = String(text || '').match(/\b(19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : null;
  }

  function cbError(cb, err, code) {
    try {
      console.error('[PersianStream] ' + (err && err.message ? err.message : String(err)));
    } catch (e) {}
    cb({ success: false, errorCode: code || 'UNKNOWN', message: String(err && err.message ? err.message : err) });
  }

  /* ------------------------------------------------------------------ *
   *  Domain failover (per-site mirror lists, remembered via storage)
   * ------------------------------------------------------------------ */

  var SITE_DOMAINS = {
    doostihaa: ['https://www.doostihaa.com', 'https://doostihaa.com'],
    filmdoon: ['https://www.filmdoon.com', 'https://filmdoon.com'],
    namagate: ['https://namagate.com', 'https://www.namagate.com'],
    aparat: ['https://www.aparat.com']
  };

  var MARKERS = {
    doostihaa: 'doostihaa',
    filmdoon: 'filmdoon',
    namagate: 'namagate',
    aparat: 'aparat'
  };

  /* getPreference may be sync (installer closure) or async (worker global) */
  function prefGet(key) {
    try {
      var v = getPreference(key);
      return Promise.resolve(v === undefined ? null : v);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function resolveBase(site) {
    var cands = SITE_DOMAINS[site] || [manifestBase()];
    var memKey = 'dom:' + site;
    return prefGet(memKey).then(function (saved) {
      if (saved && saved.indexOf('http') === 0) {
        return probeBase(saved, site).then(function (ok) {
          if (ok) return saved;
          return pickHealthy(cands, site, memKey);
        });
      }
      return pickHealthy(cands, site, memKey);
    }).catch(function () {
      return pickHealthy(cands, site, memKey);
    });
  }

  function probeBase(base, site) {
    return httpGet(base + '/', {}, 7000, 0).then(function (res) {
      return res.status === 200 && (!MARKERS[site] || res.body.indexOf(MARKERS[site]) !== -1);
    }).catch(function () { return false; });
  }

  function pickHealthy(cands, site, memKey) {
    var probes = cands.map(function (c) {
      return probeBase(c, site).then(function (ok) { return ok ? c : null; });
    });
    return Promise.all(probes).then(function (results) {
      for (var i = 0; i < cands.length; i++) {
        if (results[i]) {
          try { setPreference(memKey, cands[i]); } catch (e) {}
          return cands[i];
        }
      }
      return cands[0]; // last resort: primary, even if the probe failed
    });
  }

  /* ------------------------------------------------------------------ *
   *  TMDB enrichment (best effort, cached, never blocks on failure)
   * ------------------------------------------------------------------ */

  var TMDB_KEY = '1865f43a0549ca50d341dd9ab8b29f49';
  var TMDB_IMG = 'https://image.tmdb.org/t/p';

  function latinQuery(title) {
    var t = String(title || '');
    var latin = t.replace(/[^A-Za-z0-9 .:\-']/g, ' ');
    latin = latin.replace(/\b(Download|Danlod|Full|Free|Movie|Film|Series|Serial|S\d{1,2}E\d{1,2}|Season|Episode|Dual|Audio|Subbed|Dubbed|WEB|DL|BluRay|HDRip|x26[45]|1080p|720p|480p|2160p|4K|Farsi|Persian)\b/gi, ' ');
    latin = latin.replace(/\s+/g, ' ').trim();
    return latin;
  }

  function tmdbEnrich(item, isMovie) {
    var q = latinQuery(item.title);
    if (!q || q.length < 2) return Promise.resolve(item);
    var cacheKey = 'tmdb:' + (isMovie ? 'm' : 't') + ':' + q.toLowerCase() + ':' + (item.year || '');
    return prefGet(cacheKey).then(function (cached) {
      var data = null;
      if (cached) { try { data = JSON.parse(cached); } catch (e) {} }
      if (data) return applyMeta(item, data);
      var url = 'https://api.themoviedb.org/3/search/' + (isMovie ? 'movie' : 'tv') +
        '?api_key=' + TMDB_KEY + '&query=' + encodeURIComponent(q) + '&language=en-US&page=1';
      if (item.year) url += (isMovie ? '&year=' : '&first_air_date_year=') + item.year;
      return httpGet(url, { Accept: 'application/json' }, 6000, 0).then(function (res) {
        if (res.status !== 200 || !res.body) return item;
        var json;
        try { json = JSON.parse(res.body); } catch (e) { return item; }
        var results = (json && json.results) || [];
        if (!results.length) return item;
        var r = results[0];
        var data = {
          poster: r.poster_path ? TMDB_IMG + '/w500' + r.poster_path : null,
          backdrop: r.backdrop_path ? TMDB_IMG + '/original' + r.backdrop_path : null,
          overview: r.overview || null,
          rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null,
          genres: (r.genre_ids || []).length ? r.genre_ids.slice(0, 4) : null,
          name: isMovie ? r.title : r.name
        };
        try { setPreference(cacheKey, JSON.stringify(data)); } catch (e) {}
        return applyMeta(item, data);
      }).catch(function () { return item; });
    }).catch(function () { return item; });
  }

  function applyMeta(item, data) {
    if (!data) return item;
    if (data.poster && !item.posterUrl) item.posterUrl = data.poster;
    if (data.backdrop && !item.bannerUrl) item.bannerUrl = data.backdrop;
    if (data.overview && !item.description) item.description = data.overview;
    if (data.rating && !item.score) item.score = data.rating;
    return item;
  }

  function enrichTop(items, isMovieFlag, count) {
    var flagFn = (typeof isMovieFlag === 'function') ? isMovieFlag : function () { return !!isMovieFlag; };
    var top = items.slice(0, count || 8);
    return Promise.all(top.map(function (it) {
      return withTimeout(tmdbEnrich(it, flagFn(it)), 7000, it);
    })).then(function (enriched) {
      for (var i = 0; i < enriched.length; i++) items[i] = enriched[i];
      return items;
    }).catch(function () { return items; });
  }

  /* ================================================================== *
   *  SITE: doostihaa.com  (WordPress REST API + irdanlod direct files)
   * ================================================================== */

  function doostihaaCardsFromRest(res, base) {
    var out = [];
    var posts;
    try { posts = JSON.parse(res.body); } catch (e) { return out; }
    if (!Array.isArray(posts)) posts = posts && posts.posts ? posts.posts : [];
    posts.forEach(function (p) {
      if (!p || !p.link) return;
      var url = absUrl(p.link, base);
      var title = p.title && (p.title.rendered || p.title) ? stripTags(p.title.rendered || p.title) : '';
      if (!title) return;
      var html = (p.content && p.content.rendered) || '';
      var img = '';
      var im = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (im) img = absUrl(decodeEntities(im[1]), base);
      out.push(new MultimediaItem({
        title: title,
        url: url,
        posterUrl: img,
        type: guessType(url),
        year: yearFrom(title) || (p.date ? parseInt(String(p.date).substring(0, 4), 10) : null)
      }));
    });
    return out;
  }

  function parseDoostihaaLinks(html) {
    // returns [{label, url}] of direct media anchors inside post content
    var out = [];
    var re = /<a[^>]+href=["']([^"']+?\.(?:mp4|mkv)(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
    var m;
    while ((m = re.exec(html)) !== null) {
      var href = decodeEntities(m[1]);
      var label = stripTags(m[2]) || href.split('/').pop();
      out.push({ label: label, url: href });
    }
    return out;
  }

  function episodeNumFrom(text) {
    var t = String(text || '');
    var m = t.match(/S\d{1,2}\s?E\s?(\d{1,3})/i) || t.match(/\.S\d{2}\.?E\.?(\d{1,3})/i) ||
            t.match(/قسمت\s*([۰-۹0-9]+)/) || t.match(/EP?\s?(\d{1,3})\b/i);
    if (!m) return null;
    return parseInt(String(m[1]).replace(/[۰-۹]/g, function (c) {
      return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
    }), 10);
  }

  function seasonNumFrom(text) {
    var m = String(text || '').match(/S(\d{1,2})\s?E/i) || String(text || '').match(/فصل\s*([۰-۹0-9]+)/);
    if (!m) return 1;
    return parseInt(String(m[1]).replace(/[۰-۹]/g, function (c) {
      return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
    }), 10) || 1;
  }

  function groupEpisodes(links, fallbackTitle) {
    // links: [{label,url}] -> { movie: [links], episodes: {num: [links]} }
    var movie = [], eps = {};
    links.forEach(function (l) {
      var en = episodeNumFrom(l.label + ' ' + l.url);
      if (en) {
        if (!eps[en]) eps[en] = [];
        eps[en].push(l);
      } else {
        movie.push(l);
      }
    });
    return { movie: movie, episodes: eps };
  }

  function doostihaa() {
    var SITE = 'doostihaa';
    var NAME = 'دوستی‌ها';

    function restSearch(base, query, perPage) {
      var url = base + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(query) +
        '&per_page=' + (perPage || 20) + '&_fields=id,link,title,content,date';
      return httpGet(url, { Accept: 'application/json' }, 20000, 1);
    }

    function search(query, cb) {
      resolveBase(SITE).then(function (base) {
        return restSearch(base, query, 24).then(function (res) {
          var items = doostihaaCardsFromRest(res, base);
          cb({ success: true, data: items });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function getHome(cb) {
      resolveBase(SITE).then(function (base) {
        var latestUrl = base + '/wp-json/wp/v2/posts?per_page=20&_fields=id,link,title,content,date';
        var dubbedUrl = base + '/wp-json/wp/v2/posts?search=' + encodeURIComponent('دوبله') +
          '&per_page=18&_fields=id,link,title,content,date';
        return parallelGets([latestUrl, dubbedUrl], { Accept: 'application/json' }, 20000).then(function (results) {
          var latest = doostihaaCardsFromRest(results[0], base);
          var dubbed = doostihaaCardsFromRest(results[1], base);
          latest = dedupe(latest, function (x) { return x.url; });
          dubbed = dedupe(dubbed, function (x) { return x.url; });
          var data = {};
          data['آخرین‌ها'] = latest;
          data['دوبله فارسی'] = dubbed.filter(function (d) { return d.title.indexOf('دوبله') !== -1; });
          if (!data['دوبله فارسی'].length) data['دوبله فارسی'] = dubbed;
          var trendingSeed = latest.slice(0, 8);
          enrichTop(trendingSeed, function (it) { return it.type === 'movie'; }, 8).then(function () {
            data['Trending'] = trendingSeed;
            cb({ success: true, data: data });
          }).catch(function () {
            data['Trending'] = trendingSeed;
            cb({ success: true, data: data });
          });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function load(url, cb) {
      resolveBase(SITE).then(function (base) {
        var slug = String(url).split('?')[0].replace(/\/+$/, '').split('/').pop().replace(/\.html$/i, '');
        var restUrl = base + '/wp-json/wp/v2/posts?slug=' + encodeURIComponent(slug) +
          '&_fields=id,link,title,content,date';
        return parallelGets([restUrl, url], {}, 20000).then(function (results) {
          var rest = results[0], page = results[1];
          var posts = [];
          try { posts = JSON.parse(rest.body); } catch (e) {}
          var p = Array.isArray(posts) && posts.length ? posts[0] : null;
          if (!p) return cb({ success: false, errorCode: 'NOT_FOUND', message: 'post not found' });

          var html = (p.content && p.content.rendered) || '';
          var title = p.title && p.title.rendered ? stripTags(p.title.rendered) : '';
          var poster = '';
          var ogm = page.body.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                    page.body.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
          if (ogm) poster = absUrl(decodeEntities(ogm[1]), base);
          var y = yearFrom(title) || yearFrom(String(p.date || ''));

          var item = new MultimediaItem({
            title: title, url: url, posterUrl: poster, type: guessType(url),
            year: y, description: stripTags(html).substring(0, 600)
          });

          var links = parseDoostihaaLinks(html);
          // online-watch (watch.php) buttons -> resolved to HLS in loadStreams
          var wre = /<a[^>]+href=["']([^"']*watch\.php\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
          var wm;
          while ((wm = wre.exec(html)) !== null) {
            var wurl = decodeEntities(wm[1]);
            if (wurl.indexOf('http') !== 0) wurl = absUrl(wurl, base);
            var wlabel = stripTags(wm[2]) || 'پخش آنلاین';
            links.push({ label: wlabel, url: wurl, watch: true });
          }
          var grouped = groupEpisodes(links, title);
          var epList = [];
          if (grouped.movie.length) {
            epList.push(new Episode({
              name: item.type === 'movie' ? 'تماشای فیلم' : 'پخش',
              url: JSON.stringify(grouped.movie), season: 1, episode: 1, posterUrl: poster
            }));
          }
          var nums = Object.keys(grouped.episodes).map(Number).sort(function (a, b) { return a - b; });
          var season = 1;
          if (nums.length) season = seasonNumFrom(grouped.episodes[nums[0]][0].url + ' ' + grouped.episodes[nums[0]][0].label);
          nums.forEach(function (n) {
            var ls = grouped.episodes[n];
            var best = ls.map(function (l) { return qualityOf(l.label + ' ' + l.url).h; })
                         .reduce(function (a, b) { return Math.max(a, b); }, 0);
            epList.push(new Episode({
              name: 'قسمت ' + n + (best ? ' — ' + best + 'p' : ''),
              url: JSON.stringify(ls), season: season, episode: n, posterUrl: poster
            }));
          });
          item.episodes = epList;
          enrichTop([item], item.type === 'movie', 1).then(function () {
            cb({ success: true, data: item });
          }).catch(function () { cb({ success: true, data: item }); });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function loadStreams(data, cb) {
      Promise.resolve().then(function () {
        var links = data;
        if (typeof data === 'string' && data.charAt(0) === '[') links = JSON.parse(data);
        else if (data && typeof data === 'object' && data.url && typeof data.url === 'string' && data.url.charAt(0) === '[') links = JSON.parse(data.url);
        else if (data && typeof data === 'object' && data.url) links = [{ url: data.url, label: data.name || '' }];
        if (!Array.isArray(links) || !links.length) return [];

        var streams = [];
        var watchPages = [];
        links.forEach(function (l) {
          var u = (l && l.url) || l;
          if (typeof u !== 'string' || u.indexOf('http') !== 0) return;
          var label = (l && l.label) || u.split('/').pop();
          if (l && l.watch) {
            watchPages.push({ label: label, url: u });
            return;
          }
          var q = qualityOf(label + ' ' + u);
          var tags = sourceTags(label + ' ' + u);
          streams.push(new StreamResult({
            url: u,
            source: NAME + (q.label ? ' ' + q.label : '') + (tags ? ' · ' + tags : ''),
            quality: q.label || '',
            headers: { 'Referer': 'https://www.doostihaa.com/', 'User-Agent': APP_UA }
          }));
        });

        // resolve watch.php pages -> HLS (served via doostihaa's own proxy, works worldwide)
        if (!watchPages.length) return streams;
        return parallelGets(watchPages.map(function (w) { return w.url; }), {}, 15000).then(function (pages) {
          pages.forEach(function (res, i) {
            if (res.status !== 200 || !res.body) return;
            var dm = res.body.match(/data-src=["']([^"']+)["']/i);
            if (!dm) return;
            var raw = decodeEntities(dm[1]);
            var src = null;
            if (/^https?:\/\//i.test(raw)) src = raw;
            else if (raw.indexOf('.m3u8') !== -1) src = absUrl(raw, watchPages[i].url);
            else {
              try {
                var decoded = atob(raw);
                if (/^https?:\/\//i.test(decoded)) src = decoded;
                else if (decoded.indexOf('.m3u8') !== -1) src = absUrl(decoded, watchPages[i].url);
                else if (decoded.indexOf('stream_token=') !== -1) {
                  var sep = watchPages[i].url.indexOf('?') === -1 ? '?' : '&';
                  src = watchPages[i].url + sep + decoded.replace(/^\?/, '');
                }
              } catch (e) {}
            }
            if (src) {
              streams.push(new StreamResult({
                url: src,
                source: NAME + ' پخش آنلاین (HLS)',
                quality: 'Auto',
                headers: { 'Referer': 'https://www.doostihaa.com/', 'User-Agent': APP_UA }
              }));
            }
          });
          return streams;
        });
      }).then(function (streams) {
        cb({ success: true, data: sortStreamsDesc(dedupe(streams, function (s) { return s.url; })) });
      }).catch(function (e) {
        cbError(cb, e);
      });
    }

    return { getHome: getHome, search: search, load: load, loadStreams: loadStreams };
  }

  /* ================================================================== *
   *  SITE: filmdoon.com  (HTML cards with data-link attributes, pishtaz CDN)
   * ================================================================== */

  function filmdoon() {
    var SITE = 'filmdoon';
    var NAME = 'فیلمدون';

    function cardsFromDoc(doc, base) {
      var out = [];
      if (!doc) return out;
      var nodes = doc.querySelectorAll('div[data-link]');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var link = n.getAttribute('data-link');
        var title = n.getAttribute('data-title');
        if (!link || !title) continue;
        link = absUrl(decodeEntities(link), base);
        var img = null;
        try {
          var im = n.querySelector('img');
          if (im) img = im.getAttribute('data-src') || im.getAttribute('src');
        } catch (e) {}
        var year = parseInt(n.getAttribute('data-year'), 10) || yearFrom(title);
        var score = parseFloat(n.getAttribute('data-imdb')) || null;
        var type = /\/(series|anime)\//.test(link) ? 'series' : 'movie';
        out.push(new MultimediaItem({
          title: decodeEntities(title), url: link, posterUrl: img ? absUrl(decodeEntities(img), base) : null,
          type: type, year: year, score: score
        }));
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function search(query, cb) {
      resolveBase(SITE).then(function (base) {
        return httpGet(base + '/?s=' + encodeURIComponent(query), {}, 20000, 1).then(function (res) {
          return parseHtml(res.body).then(function (doc) {
            cb({ success: true, data: cardsFromDoc(doc, base) });
          });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function getHome(cb) {
      resolveBase(SITE).then(function (base) {
        var pages = [
          ['دوبله فارسی', base + '/persian-dubbed'],
          ['فیلم', base + '/movie'],
          ['سریال', base + '/series'],
          ['انیمیشن دوبله', base + '/animation/animation-dubbed']
        ];
        return parallelGets(pages.map(function (p) { return p[1]; }), {}, 20000).then(function (results) {
          var data = {};
          var trendingSeed = null;
          for (var i = 0; i < pages.length; i++) {
            var items = [];
            try {
              // parseHtml is async; do it inline below via a sync queue
            } catch (e) {}
            data[pages[i][0]] = items;
          }
          // parse each page asynchronously
          return Promise.all(results.map(function (res) {
            return parseHtml(res.body).then(function (doc) { return cardsFromDoc(doc, base); })
              .catch(function () { return []; });
          })).then(function (lists) {
            for (var j = 0; j < pages.length; j++) data[pages[j][0]] = lists[j] || [];
            var dub = data['دوبله فارسی'];
            var trendingSeed2 = (dub && dub.length ? dub : data['فیلم']).slice(0, 8);
            enrichTop(trendingSeed2, function (it) { return it.type === 'movie'; }, 8).then(function () {
              data['Trending'] = trendingSeed2;
              cb({ success: true, data: data });
            }).catch(function () {
              data['Trending'] = trendingSeed2;
              cb({ success: true, data: data });
            });
          });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function parseFilmdoonLinks(html) {
      var out = [];
      var re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = decodeEntities(m[1]);
        var label = stripTags(m[2]);
        if (/pishtaz|\.mp4|\.mkv/i.test(href) && /دانلود|1080|720|480|2160|4K/i.test(label)) {
          out.push({ label: label, url: href });
        }
      }
      return dedupe(out, function (x) { return x.url + '|' + x.label; });
    }

    function splitEpisodes(innerHTML, links) {
      // Walk raw HTML: split at episode markers, associate following links.
      var sections = [];
      var re = /قسمت\s*(?:[x×]?\s*)?([۰-۹0-9]{1,3})/g, m, marks = [];
      while ((m = re.exec(innerHTML)) !== null) marks.push({ idx: m.index, num: parseInt(String(m[1]).replace(/[۰-۹]/g, function (c) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)); }), 10) });
      if (!marks.length) return { movie: links, episodes: {} };
      var eps = {};
      var groupedByPos = {};
      links.forEach(function (l) {
        var pos = innerHTML.indexOf(l.url);
        if (pos < 0) pos = innerHTML.indexOf(l.label);
        groupedByPos[pos] = { link: l, pos: pos };
      });
      var positions = Object.keys(groupedByPos).map(Number).sort(function (a, b) { return a - b; });
      positions.forEach(function (pos) {
        var cur = null;
        for (var i = 0; i < marks.length; i++) if (marks[i].idx <= pos) cur = marks[i].num;
        var entry = groupedByPos[pos].link;
        if (cur) {
          if (!eps[cur]) eps[cur] = [];
          eps[cur].push(entry);
        } else {
          sections.push(entry);
        }
      });
      return { movie: sections, episodes: eps };
    }

    function load(url, cb) {
      resolveBase(SITE).then(function (base) {
        return httpGet(url, {}, 25000, 1).then(function (res) {
          return parseHtml(res.body).then(function (doc) {
            var h1 = doc.querySelector('h1');
            var title = h1 ? stripTags(h1.textContent) : '';
            var og = doc.querySelector('meta[property="og:image"]');
            var poster = og ? og.getAttribute('content') : null;
            if (poster) poster = absUrl(decodeEntities(poster), base);

            var item = new MultimediaItem({
              title: title || url, url: url, posterUrl: poster,
              type: /\/(series|anime)\//.test(url) ? 'series' : 'movie',
              year: yearFrom(title)
            });

            var links = parseFilmdoonLinks(res.body);
            var bodyEl = doc.querySelector('.entry-content') || doc.querySelector('main') || doc.body || doc;
            var container = (bodyEl && bodyEl.innerHTML) ? bodyEl.innerHTML : res.body;
            var grouped = splitEpisodes(container, links);

            var epList = [];
            if (grouped.movie.length) {
              epList.push(new Episode({
                name: item.type === 'movie' ? 'تماشای فیلم' : 'پخش',
                url: JSON.stringify(grouped.movie), season: 1, episode: 1, posterUrl: poster
              }));
            }
            var nums = Object.keys(grouped.episodes).map(Number).sort(function (a, b) { return a - b; });
            nums.forEach(function (n) {
              var ls = grouped.episodes[n];
              var best = ls.map(function (l) { return qualityOf(l.label + ' ' + l.url).h; })
                           .reduce(function (a, b) { return Math.max(a, b); }, 0);
              epList.push(new Episode({
                name: 'قسمت ' + n + (best ? ' — ' + best + 'p' : ''),
                url: JSON.stringify(ls), season: 1, episode: n, posterUrl: poster
              }));
            });
            item.episodes = epList;
            enrichTop([item], item.type === 'movie', 1).then(function () {
              cb({ success: true, data: item });
            }).catch(function () { cb({ success: true, data: item }); });
          });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function loadStreams(data, cb) {
      try {
        var links = data;
        if (typeof data === 'string' && data.charAt(0) === '[') links = JSON.parse(data);
        else if (data && typeof data === 'object' && data.url && typeof data.url === 'string' && data.url.charAt(0) === '[') links = JSON.parse(data.url);
        else if (data && typeof data === 'object' && data.url) links = [{ url: data.url, label: data.name || '' }];
        if (!Array.isArray(links) || !links.length) return cb({ success: true, data: [] });

        var streams = [];
        links.forEach(function (l) {
          var u = (l && l.url) || l;
          if (typeof u !== 'string' || u.indexOf('http') !== 0) return;
          var label = (l && l.label) || '';
          var q = qualityOf(label);
          var tags = sourceTags(label);
          streams.push(new StreamResult({
            url: u,
            source: NAME + (q.label ? ' ' + q.label : '') + (tags ? ' · ' + tags : ''),
            quality: q.label || '',
            headers: { 'Referer': 'https://www.filmdoon.com/', 'User-Agent': APP_UA }
          }));
        });
        cb({ success: true, data: sortStreamsDesc(dedupe(streams, function (s) { return s.url; })) });
      } catch (e) {
        cbError(cb, e);
      }
    }

    return { getHome: getHome, search: search, load: load, loadStreams: loadStreams };
  }

  /* ================================================================== *
   *  SITE: namagate.com  (HTML, upera CDN — playback needs Iranian IP)
   * ================================================================== */

  function namagate() {
    var SITE = 'namagate';
    var NAME = 'نماگیت';

    function postCards(html, base) {
      var out = [];
      var re = /<a[^>]+href=["'](https?:\/\/[^"']*?\/(?:movie|series|anime)\/[a-z0-9][a-z0-9\-]*\/)["'][^>]*>([\s\S]{0,700}?)<\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var url = decodeEntities(m[1]);
        if (/cat-archive|\/genre\/|\/page\//.test(url)) continue;
        var chunk = m[2];
        var imgm = chunk.match(/<img[^>]+(?:data-src|src)=["']([^"']+)["']/i);
        var titlem = chunk.match(/alt=["']([^"']{3,120})["']/i);
        var title = titlem ? decodeEntities(titlem[1]) : stripTags(chunk);
        title = title.replace(/دانلود و تماشای (فیلم|سریال|انیمه|انیمیشن)\s*/i, '').trim();
        if (!title || title.length < 2) continue;
        out.push(new MultimediaItem({
          title: title,
          url: url,
          posterUrl: imgm ? absUrl(decodeEntities(imgm[1]), base) : null,
          type: /\/movie\//.test(url) ? 'movie' : 'series',
          year: yearFrom(url) || yearFrom(title)
        }));
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function search(query, cb) {
      resolveBase(SITE).then(function (base) {
        return httpGet(base + '/?s=' + encodeURIComponent(query), {}, 20000, 1).then(function (res) {
          cb({ success: true, data: postCards(res.body, base) });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function getHome(cb) {
      resolveBase(SITE).then(function (base) {
        var pages = [
          ['فیلم دوبله', base + '/movie/cat-archive/dubbed/'],
          ['سریال دوبله', base + '/series/cat-archive/dubbed/'],
          ['انیمه', base + '/anime/'],
          ['فیلم', base + '/movie/']
        ];
        return parallelGets(pages.map(function (p) { return p[1]; }), {}, 20000).then(function (results) {
          var lists = results.map(function (res) { return res.status === 200 ? postCards(res.body, base) : []; });
          var data = {};
          for (var j = 0; j < pages.length; j++) data[pages[j][0]] = lists[j];
          var seed = (lists[0] && lists[0].length ? lists[0] : lists[3] || []).slice(0, 8);
          data['Trending'] = seed;
          cb({ success: true, data: data });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function parseUperaLinks(html) {
      var out = [];
      var re = /<a[^>]+href=["'](https?:\/\/[^"']+?upera[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = decodeEntities(m[1]);
        var chunk = html.substring(Math.max(0, m.index - 400), m.index);
        var sizeM = chunk.match(/حجم:?\s*([^<]{1,30})</);
        var q = qualityOf(href);
        var label = 'دانلود ' + (q.label ? q.label + ' ' : '') + (sizeM ? sizeM[1].trim() + ' ' : '');
        out.push({ label: label, url: href, pos: m.index });
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function epNumFromUpera(url) {
      var m = String(url).match(/upera\.tv\/\d+-(\d{1,3})-/);
      return m ? parseInt(m[1], 10) : null;
    }

    function load(url, cb) {
      resolveBase(SITE).then(function (base) {
        return httpGet(url, {}, 25000, 1).then(function (res) {
          return parseHtml(res.body).then(function (doc) {
            var h1 = doc.querySelector('h1');
            var title = h1 ? stripTags(h1.textContent) : '';
            title = title.replace(/دانلود و تماشای (فیلم|سریال|انیمه|انیمیشن)\s*/i, '').trim();
            var og = doc.querySelector('meta[property="og:image"]');
            var poster = og ? og.getAttribute('content') : null;

            var item = new MultimediaItem({
              title: title || url, url: url, posterUrl: poster,
              type: /\/movie\//.test(url) ? 'movie' : 'series',
              year: yearFrom(url) || yearFrom(title),
              playbackPolicy: 'Iranian IP (VPN) recommended'
            });

            var links = parseUperaLinks(res.body);
            // Episode mapping: look BACKWARD from each link position for the
            // nearest "قسمت N" marker (upera file IDs are NOT episode numbers).
            var byEp = {};
            var single = [];
            links.forEach(function (l) {
                var pos = res.body.indexOf(l.url);
                var windowStart = Math.max(0, pos - 4000);
                var windowHtml = res.body.substring(windowStart, pos);
                var em = windowHtml.match(/قسمت\s*(?:[x×]?\s*)?([۰-۹0-9]{1,3})(?![۰-۹0-9])/g);
                var en = null;
                if (em && em.length) {
                    var last = em[em.length - 1].match(/([۰-۹0-9]{1,3})/);
                    en = parseInt(String(last[1]).replace(/[۰-۹]/g, function (c) {
                        return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c));
                    }), 10);
                }
                if (en && en > 0) {
                    if (!byEp[en]) byEp[en] = [];
                    byEp[en].push(l);
                } else {
                    single.push(l);
                }
            });

            var epList = [];
            if (single.length) {
              epList.push(new Episode({
                name: item.type === 'movie' ? 'تماشای فیلم' : 'پخش',
                url: JSON.stringify(single), season: 1, episode: 1, posterUrl: poster
              }));
            }
            var nums = Object.keys(byEp).map(Number).sort(function (a, b) { return a - b; });
            nums.forEach(function (n) {
              var ls = byEp[n];
              var best = ls.map(function (l) { return qualityOf(l.url).h; })
                           .reduce(function (a, b) { return Math.max(a, b); }, 0);
              epList.push(new Episode({
                name: 'قسمت ' + n + (best ? ' — ' + best + 'p' : ''),
                url: JSON.stringify(ls), season: 1, episode: n, posterUrl: poster
              }));
            });
            item.episodes = epList;
            cb({ success: true, data: item });
          });
        });
      }).catch(function (e) { cbError(cb, e); });
    }

    function loadStreams(data, cb) {
      try {
        var links = data;
        if (typeof data === 'string' && data.charAt(0) === '[') links = JSON.parse(data);
        else if (data && typeof data === 'object' && data.url && typeof data.url === 'string' && data.url.charAt(0) === '[') links = JSON.parse(data.url);
        else if (data && typeof data === 'object' && data.url) links = [{ url: data.url, label: data.name || '' }];
        if (!Array.isArray(links) || !links.length) return cb({ success: true, data: [] });

        var streams = [];
        links.forEach(function (l) {
          var u = (l && l.url) || l;
          if (typeof u !== 'string' || u.indexOf('http') !== 0) return;
          var q = qualityOf(u);
          streams.push(new StreamResult({
            url: u,
            source: NAME + (q.label ? ' ' + q.label : ''),
            quality: q.label || '',
            headers: { 'Referer': 'https://namagate.com/', 'User-Agent': APP_UA }
          }));
        });
        cb({ success: true, data: sortStreamsDesc(dedupe(streams, function (s) { return s.url; })) });
      } catch (e) {
        cbError(cb, e);
      }
    }

    return { getHome: getHome, search: search, load: load, loadStreams: loadStreams };
  }

  /* ================================================================== *
   *  SITE: aparat.com  (public JSON API, global CDN)
   * ================================================================== */

  function aparat() {
    var SITE = 'aparat';
    var NAME = 'آپارات';
    var API = 'https://www.aparat.com/etc/api';

    function apiGet(path) {
      return httpGet(API + path, { Accept: 'application/json' }, 15000, 1).then(function (res) {
        if (res.status !== 200 || !res.body) throw new Error('aparat api http ' + res.status);
        return JSON.parse(res.body);
      });
    }

    function itemsFromVideos(videos) {
      return (videos || []).map(function (v) {
        if (!v || !v.uid) return null;
        return new MultimediaItem({
          title: stripTags(v.title),
          url: 'https://www.aparat.com/v/' + v.uid,
          posterUrl: v.big_poster || v.small_poster || null,
          type: 'movie',
          year: null,
          duration: v.duration ? Math.round(v.duration / 60) : null
        });
      }).filter(Boolean);
    }

    function search(query, cb) {
      apiGet('/videoBySearch/text/' + encodeURIComponent(query)).then(function (json) {
        cb({ success: true, data: itemsFromVideos(json.videobysearch || []) });
      }).catch(function (e) { cbError(cb, e); });
    }

    function getHome(cb) {
      var rows = [
        ['فیلم دوبله فارسی', 'فیلم دوبله فارسی'],
        ['انیمیشن دوبله', 'انیمیشن دوبله فارسی کامل'],
        ['سریال دوبله', 'سریال دوبله فارسی'],
        ['کلاسیک دوبله', 'فیلم دوبله فارسی قدیمی']
      ];
      Promise.all(rows.map(function (r) {
        return withTimeout(apiGet('/videoBySearch/text/' + encodeURIComponent(r[1])).then(function (json) {
          return [r[0], itemsFromVideos(json.videobysearch || [])];
        }), 18000, [r[0], []]);
      })).then(function (lists) {
        var data = {};
        lists.forEach(function (p) { data[p[0]] = p[1]; });
        data['Trending'] = (lists[0] && lists[0][1] ? lists[0][1] : []).slice(0, 8);
        cb({ success: true, data: data });
      }).catch(function (e) { cbError(cb, e); });
    }

    function load(url, cb) {
      var uid = String(url).replace(/\/+$/, '').split('/').pop();
      apiGet('/video/videohash/' + uid).then(function (json) {
        var v = json.video || {};
        var item = new MultimediaItem({
          title: stripTags(v.title) || uid,
          url: url,
          posterUrl: v.big_poster || null,
          type: 'movie',
          duration: v.duration ? Math.round(v.duration / 60) : null,
          description: stripTags(v.description || '').substring(0, 600),
          score: null
        });
        var links = [];
        var all = v.file_link_all || [];
        (Array.isArray(all) ? all : []).forEach(function (f) {
          if (f && f.urls && f.urls.length && f.urls[0]) {
            links.push({ label: String(f.profile || f.text || ''), url: f.urls[0], q: String(f.profile || '') });
          }
        });
        if (!links.length && v.file_link) links.push({ label: '', url: v.file_link, q: 'Auto' });
        item.episodes = [new Episode({
          name: 'پخش از آپارات',
          url: JSON.stringify(links), season: 1, episode: 1, posterUrl: item.posterUrl
        })];
        cb({ success: true, data: item });
      }).catch(function (e) { cbError(cb, e); });
    }

    function loadStreams(data, cb) {
      try {
        var links = data;
        if (typeof data === 'string' && data.charAt(0) === '[') links = JSON.parse(data);
        else if (data && typeof data === 'object' && data.url && typeof data.url === 'string' && data.url.charAt(0) === '[') links = JSON.parse(data.url);
        else if (data && typeof data === 'object' && data.url) links = [{ url: data.url, label: data.name || '' }];
        if (!Array.isArray(links) || !links.length) return cb({ success: true, data: [] });

        var streams = [];
        links.forEach(function (l) {
          var u = (l && l.url) || l;
          if (typeof u !== 'string' || u.indexOf('http') !== 0) return;
          var q = String((l && l.q) || '') || qualityOf(u).label;
          var isHls = /\.m3u8/i.test(u);
          streams.push(new StreamResult({
            url: u,
            source: NAME + (q ? ' ' + q : ''),
            quality: isHls ? 'Auto' : (q || ''),
            headers: { 'Referer': 'https://www.aparat.com/', 'User-Agent': APP_UA }
          }));
        });
        cb({ success: true, data: sortStreamsDesc(dedupe(streams, function (s) { return s.url; })) });
      } catch (e) {
        cbError(cb, e);
      }
    }

    return { getHome: getHome, search: search, load: load, loadStreams: loadStreams };
  }

  /* ================================================================== *
   *  Dispatch
   * ================================================================== */

  function scraper() {
    var pid = providerId();
    if (pid === 'filmdoon') return filmdoon();
    if (pid === 'namagate') return namagate();
    if (pid === 'aparat') return aparat();
    return doostihaa();
  }

  var impl = {
    getHome: function (cb) {
      try { scraper().getHome(cb); } catch (e) { cbError(cb, e); }
    },
    search: function (query, cb) {
      try { scraper().search(String(query || ''), cb); } catch (e) { cbError(cb, e); }
    },
    load: function (url, cb) {
      try { scraper().load(String(url || ''), cb); } catch (e) { cbError(cb, e); }
    },
    loadStreams: function (data, cb) {
      try { scraper().loadStreams(data, cb); } catch (e) { cbError(cb, e); }
    }
  };

  globalThis.getHome = impl.getHome;
  globalThis.search = impl.search;
  globalThis.load = impl.load;
  globalThis.loadStreams = impl.loadStreams;
  globalThis.PersianStream = impl;
})();
