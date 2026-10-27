/*
 * PersianStream v3 — SkyStream plugin (Gen 2)
 *
 * ONE merged catalog of Persian-dubbed / Persian-subbed movies & series.
 * Multiple scraper sources are combined under the hood:
 *   - Doostihaa  (WordPress REST + watch.php HLS + direct files)   [works worldwide]
 *   - Filmdoon   (WordPress HTML + pishtaz direct MP4)             [works worldwide]
 * Search returns ONE merged result per title (TMDB English metadata).
 * Seasons/episodes are merged; at play time the user picks website + quality.
 * All player-facing labels are English. No torrents.
 *
 * Runtime: SkyStream Gen 2 JS worker (http_get/http_parallel/parseHtml/classes).
 */
(function () {
  'use strict';

  var APP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  var BASE_HEADERS = { 'User-Agent': APP_UA, 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.7' };

  /* ================================================================== *
   *  Generic utils
   * ================================================================== */

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

  function mergeHeaders(a, b) {
    var out = {}, k;
    for (k in a) if (a.hasOwnProperty(k)) out[k] = a[k];
    for (k in b) if (b.hasOwnProperty(k)) out[k] = b[k];
    return out;
  }

  function httpGet(url, headers, timeoutMs, retries) {
    headers = headers || {};
    timeoutMs = timeoutMs || 15000;
    retries = (retries === undefined) ? 1 : retries;
    var attempt = function (n) {
      var p;
      try { p = http_get(url, mergeHeaders(BASE_HEADERS, headers)); }
      catch (e) { p = Promise.reject(e); }
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

  function parallelGets(urls, headers, timeoutMs) {
    var reqs = urls.map(function (u) { return { url: u, headers: mergeHeaders(BASE_HEADERS, headers || {}) }; });
    var p;
    try { p = http_parallel(reqs); }
    catch (e) { p = Promise.all(reqs.map(function (r) { return httpGet(r.url, r.headers, timeoutMs || 15000, 0); })); }
    return withTimeout(Promise.resolve(p).then(function (arr) {
      return (arr || []).map(function (r) {
        return { status: (r && r.status | 0) || 0, body: String((r && r.body) || ''), headers: (r && r.headers) || {} };
      });
    }), (timeoutMs || 15000) + 5000, urls.map(function () { return { status: 0, body: '', headers: {} }; }));
  }

  /* getPreference may be sync (installer closure) or async (worker global) */
  function prefGet(key) {
    try {
      var v = getPreference(key);
      return Promise.resolve(v === undefined ? null : v);
    } catch (e) { return Promise.resolve(null); }
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

  function faDigits(s) {
    return String(s || '').replace(/[۰-۹]/g, function (c) { return String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)); });
  }

  function yearFrom(text) {
    var m = String(text || '').match(/\b(19|20)\d{2}\b/);
    return m ? parseInt(m[0], 10) : null;
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

  function cbError(cb, err, code) {
    try { console.error('[PersianStream] ' + (err && err.message ? err.message : String(err))); } catch (e) {}
    cb({ success: false, errorCode: code || 'UNKNOWN', message: String(err && err.message ? err.message : err) });
  }

  /* quality: returns {h, label}; handles '1080p', 'HQ_1080', '4K' */
  function qualityOf(text) {
    var t = String(text || '');
    var re = /(2160|1440|1080|720|480|360|240|144)\s*(?:p|P)?/g;
    var m, bestH = 0;
    while ((m = re.exec(t)) !== null) {
      var before = m.index > 0 ? t.charAt(m.index - 1) : '';
      if (before >= '0' && before <= '9') continue;
      var afterIdx = m.index + m[0].length;
      var after = afterIdx < t.length ? t.charAt(afterIdx) : '';
      if ((after >= '0' && after <= '9') || (after >= 'a' && after <= 'z') || (after >= 'A' && after <= 'Z')) continue;
      var h = parseInt(m[1], 10);
      if (h > bestH) bestH = h;
    }
    if (!bestH && /4K|UHD/i.test(t)) bestH = 2160;
    if (!bestH && /\bHD\b/i.test(t)) bestH = 720;
    return { h: bestH, label: bestH ? bestH + 'p' : '' };
  }

  /* encode quality tag in ENGLISH: BluRay / WEB-DL / HDRip ... */
  function qualityTag(text) {
    var t = String(text || '').toUpperCase();
    if (/BLURAY|BLU-RAY|BDRIP/.test(t)) return 'BluRay';
    if (/WEB[-. ]?DL/.test(t)) return 'WEB-DL';
    if (/WEBRIP/.test(t)) return 'WEBRip';
    if (/HDTV/.test(t)) return 'HDTV';
    if (/HDRIP/.test(t)) return 'HDRip';
    return '';
  }

  function isDubbed(text) {
    var t = String(text || '');
    return /DUBBED|DUB\)|\bDUB\b/i.test(t) || /دوبله/.test(t);
  }

  function isSubbed(text) {
    var t = String(text || '');
    return /SUBBED|SUB\)|\bSUB\b/i.test(t) || /زیرنویس|زيرنويس/.test(t);
  }

  /* season + episode extraction from label+url */
  function seasonEpisodeOf(label, url) {
    var t = faDigits(String(label || '') + ' ' + String(url || ''));
    var m = t.match(/S(\d{1,2})\s*E\s*(\d{1,3})/i);
    if (m) return { s: parseInt(m[1], 10), e: parseInt(m[2], 10) };
    var fa = t.match(/فصل\s*(\d{1,2})[^0-9]{0,12}قسمت\s*(\d{1,3})/);
    if (fa) return { s: parseInt(fa[1], 10), e: parseInt(fa[2], 10) };
    var ep = t.match(/قسمت\s*(\d{1,3})/);
    if (ep) return { s: 1, e: parseInt(ep[1], 10) };
    var se = t.match(/(?:^|[^0-9a-z])S(\d{1,2})(?:[^0-9a-z]|$)/i);
    var ee = t.match(/E(\d{1,3})(?:[^0-9]|$)/i);
    if (ee && se) return { s: parseInt(se[1], 10), e: parseInt(ee[1], 10) };
    if (ee) return { s: 1, e: parseInt(ee[1], 10) };
    return null;
  }

  /* ================================================================== *
   *  Domain failover
   * ================================================================== */

  var SITE_DOMAINS = {
    doostihaa: ['https://www.doostihaa.com', 'https://doostihaa.com'],
    filmdoon: ['https://www.filmdoon.com', 'https://filmdoon.com']
  };

  function resolveBase(site) {
    var cands = SITE_DOMAINS[site];
    var memKey = 'dom:' + site;
    return prefGet(memKey).then(function (saved) {
      if (saved && saved.indexOf('http') === 0) {
        return probeBase(saved, site).then(function (ok) {
          return ok ? saved : pickHealthy(cands, site, memKey);
        });
      }
      return pickHealthy(cands, site, memKey);
    }).catch(function () { return pickHealthy(cands, site, memKey); });
  }

  function probeBase(base, site) {
    return httpGet(base + '/', {}, 7000, 0).then(function (res) {
      return res.status === 200 && res.body.indexOf(site) !== -1;
    }).catch(function () { return false; });
  }

  function pickHealthy(cands, site, memKey) {
    return Promise.all(cands.map(function (c) {
      return probeBase(c, site).then(function (ok) { return ok ? c : null; });
    })).then(function (results) {
      for (var i = 0; i < cands.length; i++) {
        if (results[i]) {
          try { setPreference(memKey, cands[i]); } catch (e) {}
          return cands[i];
        }
      }
      return cands[0];
    });
  }

  /* ================================================================== *
   *  TMDB enrichment — English titles, posters, ratings (cached, optional)
   * ================================================================== */

  var TMDB_KEY = '1865f43a0549ca50d341dd9ab8b29f49';
  var TMDB_IMG = 'https://image.tmdb.org/t/p';

  function latinQuery(title) {
    var t = String(title || '');
    var latin = t.replace(/[^A-Za-z0-9 .:\-']/g, ' ');
    latin = latin.replace(/\b(Download|Danlod|Full|Free|Movie|Film|Series|Serial|S\d{1,2}E\d{1,2}|Season|Episode|Dual|Audio|Subbed|Dubbed|WEB|DL|BluRay|Blu|HDRip|WEBRip|x26[45]|1080p|720p|480p|2160p|4K|Farsi|Persian|Complete|Pack)\b/gi, ' ');
    latin = latin.replace(/\s+/g, ' ').trim();
    return latin;
  }

  function tmdbLookup(title, year, isMovie) {
    var q = latinQuery(title).replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q || q.length < 2) return Promise.resolve(null);
    var cacheKey = 'tmdb2:' + (isMovie ? 'm' : 't') + ':' + q.toLowerCase() + ':' + (year || '');
    return prefGet(cacheKey).then(function (cached) {
      if (cached) { try { return JSON.parse(cached); } catch (e) {} }
      var url = 'https://api.themoviedb.org/3/search/' + (isMovie ? 'movie' : 'tv') +
        '?api_key=' + TMDB_KEY + '&query=' + encodeURIComponent(q) + '&language=en-US&page=1';
      // For TV, never filter by the post's year: Persian posts are per-season,
      // so the year is a season air-year, not the show's first_air_date — and
      // spinoffs from that year hijack the match.
      if (year && isMovie) url += '&year=' + year;
      return httpGet(url, { Accept: 'application/json' }, 6000, 0).then(function (res) {
        function bestOf(body) {
          if (res.status !== 200 || !body) return null;
          var json;
          try { json = JSON.parse(body); } catch (e) { return null; }
          var list = json.results || [];
          if (!list.length) return null;
          // pick the result whose name best overlaps the query tokens (avoids
          // spinoffs/documentaries fuzzy-matching their parent show)
          var qTokens = {};
          q.toLowerCase().split(' ').forEach(function (w) { if (w.length > 1) qTokens[w] = 1; });
          var qn = Object.keys(qTokens).length || 1;
          var best = null, bestScore = -1;
          list.forEach(function (r) {
            var nm = String((isMovie ? r.title || r.original_title : r.name || r.original_name) || '').toLowerCase();
            var hit = 0;
            Object.keys(qTokens).forEach(function (w) { if (nm.indexOf(w) !== -1) hit += 1; });
            var nmTokens = nm.split(/\s+/).filter(Boolean).length;
            var score = hit / qn
              + (nm === q ? 2 : 0)                 // exact name wins ties
              - Math.max(0, nmTokens - hit) * 0.15; // penalize spinoff suffixes
            if (score > bestScore) { bestScore = score; best = r; }
          });
          return best;
        }
        var r = bestOf(res.body);
        if (!r && year) {
          // post year (e.g. a later season) can exclude the real title — retry unfiltered
          var url2 = 'https://api.themoviedb.org/3/search/' + (isMovie ? 'movie' : 'tv') +
            '?api_key=' + TMDB_KEY + '&query=' + encodeURIComponent(q) + '&language=en-US&page=1';
          return httpGet(url2, { Accept: 'application/json' }, 6000, 0).then(function (res2) {
            var savedRes = res;
            var body = res2.body, status = res2.status;
            res = { status: status };
            return bestOf(body);
          }).then(applyResult).catch(function () { return null; });
        }
        return applyResult(r);
      }).catch(function () { return null; });

      function applyResult(r) {
        if (!r) return null;
        var data = {
          id: r.id || null,
          name: isMovie ? (r.title || r.original_title) : (r.name || r.original_name),
          year: parseInt(((isMovie ? r.release_date : r.first_air_date) || '').substring(0, 4), 10) || null,
          poster: r.poster_path ? TMDB_IMG + '/w500' + r.poster_path : null,
          backdrop: r.backdrop_path ? TMDB_IMG + '/original' + r.backdrop_path : null,
          overview: r.overview || null,
          rating: r.vote_average ? Math.round(r.vote_average * 10) / 10 : null
        };
        if (data.name) { try { setPreference(cacheKey, JSON.stringify(data)); } catch (e) {} }
        return data.name ? data : null;
      }
    }).catch(function () { return null; });
  }

  /* logoUrl via metahub (needs the IMDb id from TMDB external_ids) */
  function logoLookup(tmdbId, isMovie) {
    if (!tmdbId) return Promise.resolve(null);
    var key = 'logo:' + tmdbId;
    return prefGet(key).then(function (cached) {
      if (cached) return cached === 'none' ? null : cached;
      var url = 'https://api.themoviedb.org/3/' + (isMovie ? 'movie' : 'tv') + '/' + tmdbId +
        '?api_key=' + TMDB_KEY + '&append_to_response=external_ids';
      return httpGet(url, { Accept: 'application/json' }, 6000, 0).then(function (res) {
        if (res.status !== 200 || !res.body) return null;
        var json;
        try { json = JSON.parse(res.body); } catch (e) { return null; }
        var imdb = json.external_ids && json.external_ids.imdb_id;
        var logo = imdb ? ('https://live.metahub.space/logo/medium/' + imdb + '/img') : null;
        try { setPreference(key, logo || 'none'); } catch (e) {}
        return logo;
      }).catch(function () { return null; });
    });
  }

  /* ================================================================== *
   *  SOURCE: Doostihaa (WordPress REST + watch.php HLS + direct files)
   * ================================================================== */

  function doostihaaSource() {
    var SITE = 'doostihaa';
    var LABEL = 'Doostihaa';

    function parseMediaLinks(html) {
      var out = [];
      var re = /<a[^>]+href=["']([^"']+?\.(?:mp4|mkv)(?:\?[^"']*)?)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var href = decodeEntities(m[1]);
        var label = stripTags(m[2]) || href.split('/').pop();
        out.push({ label: label, url: href });
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function parseWatchLinks(html, base) {
      var out = [];
      var re = /<a[^>]+href=["']([^"']*watch\.php\?[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var wurl = decodeEntities(m[1]);
        if (wurl.indexOf('http') !== 0) wurl = absUrl(wurl, base);
        out.push({ label: stripTags(m[2]) || 'Online', url: wurl, watch: true });
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function collectLinks(html, base) {
      return parseMediaLinks(html).map(function (l) {
        return { src: LABEL, label: l.label, url: l.url };
      }).concat(parseWatchLinks(html, base).map(function (l) {
        return { src: LABEL, label: l.label, url: l.url, watch: true };
      }));
    }

    function search(query) {
      return resolveBase(SITE).then(function (base) {
        var url = base + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(query) +
          '&per_page=20&_fields=id,link,title,content,date';
        return httpGet(url, { Accept: 'application/json' }, 20000, 1).then(function (res) {
          var posts;
          try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
          return (Array.isArray(posts) ? posts : []).map(function (p) {
            if (!p || !p.link) return null;
            var html = (p.content && p.content.rendered) || '';
            var im = html.match(/<img[^>]+src=["']([^"']+)["']/i);
            return {
              site: SITE,
              title: p.title && p.title.rendered ? stripTags(p.title.rendered) : '',
              url: absUrl(p.link, base),
              poster: im ? absUrl(decodeEntities(im[1]), base) : null,
              year: yearFrom(p.title && p.title.rendered ? p.title.rendered : '') || yearFrom(String(p.date || ''))
            };
          }).filter(function (x) { return x && x.title; });
        });
      });
    }

    function homeLists() {
      return resolveBase(SITE).then(function (base) {
        var latest = base + '/wp-json/wp/v2/posts?per_page=18&_fields=id,link,title,content,date';
        var dubbed = base + '/wp-json/wp/v2/posts?search=' + encodeURIComponent('دوبله') +
          '&per_page=18&_fields=id,link,title,content,date';
        return parallelGets([latest, dubbed], { Accept: 'application/json' }, 20000).then(function (results) {
          function parse(res) {
            var posts;
            try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
            return (Array.isArray(posts) ? posts : []).map(function (p) {
              if (!p || !p.link) return null;
              var html = (p.content && p.content.rendered) || '';
              var im = html.match(/<img[^>]+src=["']([^"']+)["']/i);
              return {
                site: SITE,
                title: p.title && p.title.rendered ? stripTags(p.title.rendered) : '',
                url: absUrl(p.link, base),
                poster: im ? absUrl(decodeEntities(im[1]), base) : null,
                year: yearFrom(p.title && p.title.rendered ? p.title.rendered : '') || yearFrom(String(p.date || ''))
              };
            }).filter(function (x) { return x && x.title; });
          }
          return { latest: parse(results[0]), dubbed: parse(results[1]) };
        });
      });
    }

    /* returns { title, poster, isSeries, episodes: {s,e -> [link]}, movieLinks: [link] } */
    function loadDetail(postUrl) {
      return resolveBase(SITE).then(function (base) {
        var slug = String(postUrl).split('?')[0].replace(/\/+$/, '').split('/').pop().replace(/\.html$/i, '');
        var restUrl = base + '/wp-json/wp/v2/posts?slug=' + encodeURIComponent(slug) + '&_fields=id,link,title,content,date';
        return parallelGets([restUrl, postUrl], {}, 20000).then(function (results) {
          var posts = [];
          try { posts = JSON.parse(results[0].body); } catch (e) {}
          var p = Array.isArray(posts) && posts.length ? posts[0] : null;
          if (!p) return null;

          var html = (p.content && p.content.rendered) || '';
          var rawTitle = p.title && p.title.rendered ? stripTags(p.title.rendered) : '';
          var ogm = results[1].body.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                    results[1].body.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
          var poster = ogm ? absUrl(decodeEntities(ogm[1]), base) : null;

          var links = collectLinks(html, base);
          var episodes = {}, movie = [];
          links.forEach(function (l) {
            var se = seasonEpisodeOf(l.label, l.url);
            if (se && se.e > 0) {
              var key = se.s + ':' + se.e;
              if (!episodes[key]) episodes[key] = [];
              episodes[key].push(l);
            } else {
              movie.push(l);
            }
          });
          return {
            site: SITE,
            rawTitle: rawTitle,
            poster: poster,
            year: yearFrom(rawTitle) || yearFrom(String(p.date || '')),
            isSeries: Object.keys(episodes).length > 0 && !movie.length,
            episodes: episodes,
            movieLinks: movie
          };
        });
      });
    }

    /* resolve watch.php pages to HLS (doostihaa proxy — works worldwide) */
    function resolveWatch(url) {
      return httpGet(url, {}, 15000, 0).then(function (res) {
        if (res.status !== 200 || !res.body) return null;
        var dm = res.body.match(/data-src=["']([^"']+)["']/i);
        if (!dm) return null;
        var raw = decodeEntities(dm[1]);
        if (/^https?:\/\//i.test(raw)) return raw;
        if (raw.indexOf('.m3u8') !== -1) return absUrl(raw, url);
        try {
          var decoded = atob(raw);
          if (/^https?:\/\//i.test(decoded)) return decoded;
          if (decoded.indexOf('.m3u8') !== -1) return absUrl(decoded, url);
          if (decoded.indexOf('stream_token=') !== -1) {
            var sep = url.indexOf('?') === -1 ? '?' : '&';
            return url + sep + decoded.replace(/^\?/, '');
          }
        } catch (e) {}
        return null;
      }).catch(function () { return null; });
    }

    return { search: search, homeLists: homeLists, loadDetail: loadDetail, resolveWatch: resolveWatch, label: LABEL };
  }

  /* ================================================================== *
   *  SOURCE: Filmdoon (WordPress HTML cards + pishtaz direct MP4)
   * ================================================================== */

  function filmdoonSource() {
    var SITE = 'filmdoon';
    var LABEL = 'Filmdoon';

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
        out.push({
          site: SITE,
          title: decodeEntities(title),
          url: link,
          poster: img ? absUrl(decodeEntities(img), base) : null,
          year: parseInt(n.getAttribute('data-year'), 10) || yearFrom(title),
          score: parseFloat(n.getAttribute('data-imdb')) || null
        });
      }
      return dedupe(out, function (x) { return x.url; });
    }

    function parseCards(html, base) {
      return parseHtml(html).then(function (doc) { return cardsFromDoc(doc, base); })
        .catch(function () { return []; });
    }

    function search(query) {
      return resolveBase(SITE).then(function (base) {
        return httpGet(base + '/?s=' + encodeURIComponent(query), {}, 20000, 1)
          .then(function (res) { return parseCards(res.body, base); });
      });
    }

    function homeLists() {
      return resolveBase(SITE).then(function (base) {
        var pages = [base + '/persian-dubbed', base + '/movie', base + '/series'];
        return parallelGets(pages, {}, 20000).then(function (results) {
          return Promise.all(results.map(function (res) {
            return res.status === 200 ? parseCards(res.body, base) : Promise.resolve([]);
          })).then(function (lists) {
            return { dubbed: lists[0], latestMovies: lists[1], latestSeries: lists[2] };
          });
        });
      });
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

    /* returns { title, poster, isSeries, episodes, movieLinks } */
    function loadDetail(postUrl) {
      return resolveBase(SITE).then(function (base) {
        return httpGet(postUrl, {}, 25000, 1).then(function (res) {
          return parseHtml(res.body).then(function (doc) {
            if (!doc) return null;
            var h1 = doc.querySelector('h1');
            var rawTitle = h1 ? stripTags(h1.textContent) : '';
            var og = doc.querySelector('meta[property="og:image"]');
            var poster = og ? absUrl(decodeEntities(og.getAttribute('content') || ''), base) : null;

            var links = parseFilmdoonLinks(res.body).map(function (l) {
              return { src: LABEL, label: l.label, url: l.url };
            });
            var bodyEl = doc.querySelector('.entry-content') || doc.querySelector('main') || doc.body || doc;
            var container = (bodyEl && bodyEl.innerHTML) ? bodyEl.innerHTML : res.body;

            // split by قسمت markers, associate links positioned after each marker
            var marks = [];
            var mre = /قسمت\s*(?:[x×]?\s*)?([۰-۹0-9]{1,3})/g, mm;
            while ((mm = mre.exec(container)) !== null) {
              marks.push({ idx: mm.index, num: parseInt(faDigits(mm[1]), 10) });
            }
            var episodes = {}, movie = [];
            links.forEach(function (l) {
              var pos = container.indexOf(l.url);
              if (pos < 0) pos = container.indexOf(l.label);
              var se = null;
              var src = l.label + ' ' + l.url;
              var m2 = faDigits(src).match(/S(\d{1,2})\s*E\s*(\d{1,3})/i) ||
                       faDigits(src).match(/فصل\s*(\d{1,2})[^0-9]{0,12}قسمت\s*(\d{1,3})/);
              if (m2) {
                se = { s: parseInt(m2[1], 10), e: parseInt(m2[2], 10) };
              } else if (marks.length && pos >= 0) {
                var cur = null;
                for (var i = 0; i < marks.length; i++) if (marks[i].idx <= pos) cur = marks[i].num;
                if (cur) se = { s: 1, e: cur };
              }
              if (se && se.e > 0) {
                var key = se.s + ':' + se.e;
                if (!episodes[key]) episodes[key] = [];
                episodes[key].push(l);
              } else {
                movie.push(l);
              }
            });

            return {
              site: SITE,
              rawTitle: rawTitle,
              poster: poster,
              year: yearFrom(rawTitle),
              isSeries: Object.keys(episodes).length > 0 && !movie.length,
              episodes: episodes,
              movieLinks: movie
            };
          });
        });
      });
    }

    return { search: search, homeLists: homeLists, loadDetail: loadDetail, label: LABEL };
  }

  /* ================================================================== *
   *  SOURCE: MoviesHo (WordPress REST + direct musitraf CDN, works abroad)
   * ================================================================== */

  function movieshoSource() {
    var SITE = 'moviesho';
    var LABEL = 'MoviesHo';
    var BASE = 'https://moviesho.com';
    var catId = null;

    function restSearch(query) {
      return httpGet(BASE + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(query) +
        '&per_page=15&_fields=id,link,title,date', { Accept: 'application/json' }, 18000, 1)
        .then(function (res) {
          var posts;
          try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
          return (Array.isArray(posts) ? posts : []).map(function (p) {
            if (!p || !p.link) return null;
            return {
              site: SITE,
              title: p.title && p.title.rendered ? stripTags(p.title.rendered) : '',
              url: absUrl(p.link, BASE),
              poster: null,
              year: yearFrom(p.title && p.title.rendered ? p.title.rendered : '') || yearFrom(String(p.date || ''))
            };
          }).filter(function (x) { return x && x.title; });
        }).catch(function () { return []; });
    }

    function htmlSearch(query) {
      return httpGet(BASE + '/?s=' + encodeURIComponent(query), {}, 18000, 0).then(function (res) {
        if (res.status !== 200) return [];
        var out = [];
        var re = /<a[^>]+href="(https:\/\/www\.moviesho\.com\/(?:series\/|anime\/)?[a-z0-9][a-z0-9\-]*(?:-\d{4})?(?:-film|-tv-serial)?\/)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
        var m;
        while ((m = re.exec(res.body)) !== null) {
          var u = decodeEntities(m[1]);
          if (/\/(category|tag|page\/|imdb|collection|app|account)/.test(u)) continue;
          var t = stripTags(m[2]);
          if (!t || t.length < 3) continue;
          out.push({ site: SITE, title: t, url: u, poster: null, year: yearFrom(u) || yearFrom(t) });
        }
        return dedupe(out, function (x) { return x.url; });
      }).catch(function () { return []; });
    }

    function search(query) {
      return restSearch(query).then(function (items) {
        if (items.length >= 3) return items;
        return htmlSearch(query).then(function (more) {
          return dedupe(items.concat(more), function (x) { return mergeKey(x.title); });
        });
      });
    }

    function dubbedCategoryId() {
      if (catId) return Promise.resolve(catId);
      return httpGet(BASE + '/wp-json/wp/v2/categories?slug=farsi-dubbed&_fields=id', { Accept: 'application/json' }, 12000, 0)
        .then(function (res) {
          var cats;
          try { cats = JSON.parse(res.body); } catch (e) { cats = []; }
          catId = (Array.isArray(cats) && cats.length && cats[0].id) || null;
          return catId;
        }).catch(function () { return null; });
    }

    function restList(qs) {
      return httpGet(BASE + '/wp-json/wp/v2/posts?' + qs, { Accept: 'application/json' }, 18000, 1)
        .then(function (res) {
          var posts;
          try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
          return (Array.isArray(posts) ? posts : []).map(function (p) {
            if (!p || !p.link) return null;
            return {
              site: SITE,
              title: p.title && p.title.rendered ? stripTags(p.title.rendered) : '',
              url: absUrl(p.link, BASE),
              poster: null,
              year: yearFrom(p.title && p.title.rendered ? p.title.rendered : '') || yearFrom(String(p.date || ''))
            };
          }).filter(function (x) { return x && x.title; });
        }).catch(function () { return []; });
    }

    function homeLists() {
      return Promise.all([
        restList('per_page=15&_fields=id,link,title,date'),
        dubbedCategoryId().then(function (id) {
          return id ? restList('per_page=12&_fields=id,link,title,date&categories=' + id) : [];
        })
      ]).then(function (r) {
        return { latest: r[0], dubbed: r[1], latestSeries: [], latestMovies: r[0] };
      });
    }

    /* detail from post page HTML: download-link anchors + og:image + h1 */
    function loadDetail(postUrl) {
      return httpGet(postUrl, {}, 25000, 1).then(function (res) {
        return parseHtml(res.body).then(function (doc) {
          if (!doc) return null;
          var h1 = doc.querySelector('h1');
          var rawTitle = h1 ? stripTags(h1.textContent) : '';
          var og = doc.querySelector('meta[property="og:image"]');
          var poster = og ? absUrl(decodeEntities(og.getAttribute('content') || ''), postUrl) : null;

          var links = [];
          var nodes = doc.querySelectorAll('a[href]');
          for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var href = n.getAttribute('href');
            var cls = String(n.getAttribute('class') || '');
            if (!href || !/\.(mp4|mkv)(\?|$)/i.test(href)) continue;
            if (!/musitraf|moviesho|upera/i.test(href)) continue;
            var qm = cls.match(/dl-(\d{3,4})/i);
            var label = 'دانلود ' + (qm ? qm[1] + 'p' : (qualityOf(href).label || ''));
            links.push({ src: LABEL, label: label, url: absUrl(decodeEntities(href), postUrl) });
          }
          links = dedupe(links, function (x) { return x.url; });

          var episodes = {}, movie = [];
          links.forEach(function (l) {
            var se = seasonEpisodeOf(l.label, l.url);
            if (se && se.e > 0) {
              var key = se.s + ':' + se.e;
              if (!episodes[key]) episodes[key] = [];
              episodes[key].push(l);
            } else {
              movie.push(l);
            }
          });
          return {
            site: SITE,
            rawTitle: rawTitle,
            poster: poster,
            year: yearFrom(rawTitle) || yearFrom(postUrl),
            isSeries: Object.keys(episodes).length > 0 && !movie.length,
            episodes: episodes,
            movieLinks: movie
          };
        });
      });
    }

    return { search: search, homeLists: homeLists, loadDetail: loadDetail, label: LABEL };
  }

  /* ================================================================== *
   *  SOURCE: Cinamatic.top (WP REST + base64 player URLs -> signed direct
   *  files on dl*.cinamadownload.top — verified working from abroad)
   * ================================================================== */

  function cinamaticSource() {
    var SITE = 'cinamatic';
    var LABEL = 'Cinamatic';
    var BASE = 'https://cinamatic.top';

    function restList(qs) {
      return httpGet(BASE + '/wp-json/wp/v2/posts?' + qs, { Accept: 'application/json' }, 18000, 1)
        .then(function (res) {
          var posts;
          try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
          return (Array.isArray(posts) ? posts : []).map(function (p) {
            if (!p || !p.link) return null;
            return {
              site: SITE,
              title: p.title && p.title.rendered ? stripTags(p.title.rendered) : '',
              url: absUrl(p.link, BASE),
              poster: null,
              year: yearFrom(p.title && p.title.rendered ? p.title.rendered : '') || yearFrom(String(p.date || ''))
            };
          }).filter(function (x) { return x && x.title; });
        }).catch(function () { return []; });
    }

    function search(query) {
      return restList('search=' + encodeURIComponent(query) + '&per_page=15&_fields=id,link,title,date');
    }

    function homeLists() {
      return restList('per_page=15&_fields=id,link,title,date').then(function (latest) {
        return { latest: latest, dubbed: [], latestSeries: [], latestMovies: latest };
      });
    }

    function loadDetail(postUrl) {
      return httpGet(postUrl, {}, 25000, 1).then(function (res) {
        return parseHtml(res.body).then(function (doc) {
          if (!doc) return null;
          var h1 = doc.querySelector('h1');
          var rawTitle = h1 ? stripTags(h1.textContent) : '';
          var og = doc.querySelector('meta[property="og:image"]');
          var poster = og ? absUrl(decodeEntities(og.getAttribute('content') || ''), postUrl) : null;

          // direct files hide base64-encoded in /player?pid=..&file=<b64> anchors
          var links = [];
          var nodes = doc.querySelectorAll('a[href]');
          for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var href = String(n.getAttribute('href') || '');
            var fm = href.match(/[?&]file=([A-Za-z0-9+/=]+)/);
            if (!fm) continue;
            var direct = null;
            try { direct = atob(fm[1]); } catch (e) { continue; }
            if (!direct || !/\.(mp4|mkv|m3u8)(\?|$)/i.test(direct)) continue;
            var label = 'دانلود ' + (qualityOf(direct).label || '');
            links.push({ src: LABEL, label: label, url: direct });
          }
          links = dedupe(links, function (x) { return x.url; });

          var episodes = {}, movie = [];
          links.forEach(function (l) {
            var se = seasonEpisodeOf(l.label, l.url);
            if (se && se.e > 0) {
              var key = se.s + ':' + se.e;
              if (!episodes[key]) episodes[key] = [];
              episodes[key].push(l);
            } else {
              movie.push(l);
            }
          });
          return {
            site: SITE,
            rawTitle: rawTitle,
            poster: poster,
            year: yearFrom(rawTitle) || yearFrom(postUrl),
            isSeries: Object.keys(episodes).length > 0 && !movie.length,
            episodes: episodes,
            movieLinks: movie
          };
        });
      });
    }

    return { search: search, homeLists: homeLists, loadDetail: loadDetail, label: LABEL };
  }

  /* ================================================================== *
   *  Merge helpers
   * ================================================================== */

  function mergeKey(title) {
    var q = latinQuery(title).replace(/\b(19|20)\d{2}\b/g, ' ').toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    return q || String(title || '').toLowerCase().trim();
  }

  function mergedUrl(map) {
    return 'ps:' + JSON.stringify(map);
  }

  function parseMergedUrl(url) {
    if (typeof url === 'string' && url.indexOf('ps:') === 0) {
      try {
        var raw = JSON.parse(url.substring(3));
        return {
          d: raw.doostihaa || raw.d || null,
          f: raw.filmdoon || raw.f || null,
          m: raw.moviesho || raw.m || null,
          c: raw.cinamatic || raw.c || null
        };
      } catch (e) { return {}; }
    }
    // legacy plain URL — guess source
    var u = String(url || '');
    if (/filmdoon/i.test(u)) return { f: u };
    if (/moviesho/i.test(u)) return { m: u };
    if (/cinamatic/i.test(u)) return { c: u };
    return { d: u };
  }

  function typeFor(title, url) {
    var t = String(title || '');
    if (/series|serial|anime|سریال|انیمه/i.test(t) || /\/(series|anime)\//i.test(String(url || ''))) return 'series';
    return 'movie';
  }

  function buildItemFromTmdb(meta, sources, fallbackTitle, fallbackPoster, fallbackYear) {
    var title = (meta && meta.name) || stripTags(fallbackTitle || '').replace(/دانلود (فیلم|سریال|انیمیشن)\s*/i, '').trim();
    return {
      title: title,
      poster: (meta && meta.poster) || fallbackPoster || null,
      banner: (meta && meta.backdrop) || null,
      overview: (meta && meta.overview) || null,
      rating: (meta && meta.rating) || null,
      year: (meta && meta.year) || fallbackYear || null
    };
  }

  /* ================================================================== *
   *  Stream building — English labels, quality ranking
   * ================================================================== */

  var SOURCES = {
    doostihaa: doostihaaSource(),
    filmdoon: filmdoonSource(),
    moviesho: movieshoSource(),
    cinamatic: cinamaticSource()
  };

  function buildStreams(links) {
    // links: [{src, label, url, watch?}]
    var direct = [], watchPages = [];
    links.forEach(function (l) {
      if (l && l.watch) watchPages.push(l);
      else if (l && typeof l.url === 'string' && l.url.indexOf('http') === 0) direct.push(l);
    });

    var streams = direct.map(function (l) {
      var text = l.label + ' ' + l.url;
      var q = qualityOf(text);
      var tag = qualityTag(text);
      var dub = isDubbed(text) ? 'Dubbed' : (isSubbed(text) ? 'Subbed' : '');
      var url = l.url;
      // irdanlod.ir hosts are unreachable outside Iran — same files serve from irdanlod.top
      url = url.replace(/(https?:\/\/)[a-z0-9\-]+\.irdanlod\.ir\//i, '$1hub.irdanlod.top/');
      var isUpera = /upera/i.test(url);
      var parts = [l.src || 'Source'];
      if (tag) parts.push(tag);
      if (q.label) parts.push(q.label);
      if (dub) parts.push(dub);
      if (isUpera) parts.push('(IR IP)');
      return new StreamResult({
        url: url,
        source: parts.join(' · '),
        quality: q.label || '',
        headers: /doostihaa|irdanlod/i.test(url)
          ? { 'Referer': 'https://www.doostihaa.com/', 'User-Agent': APP_UA }
          : { 'Referer': 'https://www.filmdoon.com/', 'User-Agent': APP_UA }
      });
    });

    var watchResolved = Promise.all(watchPages.map(function (l) {
      return SOURCES.doostihaa.resolveWatch(l.url).then(function (hls) {
        if (!hls) return null;
        return new StreamResult({
          url: hls,
          source: 'Doostihaa · HLS (Auto, up to 1080p)',
          quality: 'Auto',
          headers: { 'Referer': 'https://www.doostihaa.com/', 'User-Agent': APP_UA }
        });
      });
    }));

    return watchResolved.then(function (hlsStreams) {
      var all = streams.concat(hlsStreams.filter(Boolean));
      var seen = {}, out = [];
      all.forEach(function (s) {
        if (!s.url || seen[s.url]) return;
        seen[s.url] = 1;
        out.push(s);
      });
      out.sort(function (a, b) {
        function score(s) {
          var h = s.quality === 'Auto' ? 9999 : (qualityOf(s.quality + '').h || 0);
          var dub = /Dubbed/.test(s.source) ? 2 : (/Subbed/.test(s.source) ? 1 : 1.5);
          var crisp = /(BluRay|WEB-DL|HLS)/.test(s.source) ? 0.5 : 0;
          var ir = /\(IR IP\)/.test(s.source) ? -0.6 : 0; // geo-blocked abroad, rank lower
          return h * 10 + dub * 5 + crisp + ir;
        }
        return score(b) - score(a);
      });
      var candidates = out.slice(0, 8);
      // Pre-verify each candidate with a tiny Range request so dead/geo links
      // never reach the player ("video cannot reach" prevention). The response
      // also gives us the file size = bitrate proxy, so crisp encodes rank
      // above thin re-encodes at the same resolution.
      return Promise.all(candidates.map(function (s) {
        return withTimeout(httpGet(s.url, {
          Range: 'bytes=0-1023',
          Referer: (s.headers && s.headers.Referer) || 'https://www.doostihaa.com/'
        }, 6000, 0), 8000, { status: 0, body: '', headers: {} }).then(function (res) {
          var ct = String(res.headers && res.headers['content-type'] || '');
          var cr = String(res.headers && res.headers['content-range'] || '');
          var cl = String(res.headers && res.headers['content-length'] || '');
          var total = parseInt((cr.split('/')[1] || cl), 10) || 0;
          var ok = (res.status === 200 || res.status === 206) &&
            (/video|mpegurl|matroska|octet/i.test(ct) || (res.status === 206 && cr.indexOf('/') !== -1));
          return { s: s, ok: ok, size: total };
        }).catch(function () { return { s: s, ok: false, size: 0 }; });
      })).then(function (checks) {
        var good = checks.filter(function (c) { return c.ok; });
        if (!good.length) return candidates; // nothing verified (network hiccup) — show all
        // annotate size into the visible label + re-rank: bitrate matters
        good.forEach(function (c) {
          var gb = c.size / 1e9;
          if (gb >= 0.15 && !/HLS/.test(c.s.source)) {
            c.s.source += ' · ' + (gb >= 1 ? gb.toFixed(1) + 'GB' : Math.round(gb * 1000) + 'MB');
          }
        });
        good.sort(function (a, b) {
          function score(c) {
            var s = c.s;
            var h = s.quality === 'Auto' ? 9999 : (qualityOf(s.quality + '').h || 0);
            var dub = /Dubbed/.test(s.source) ? 2 : (/Subbed/.test(s.source) ? 1 : 1.5);
            var crisp = /(BluRay|WEB-DL|HLS)/.test(s.source) ? 0.5 : 0;
            var ir = /\(IR IP\)/.test(s.source) ? -0.6 : 0;
            var sizeBoost = Math.min(c.size / 1e9, 4) * 0.35; // bitrate proxy, capped
            return h * 10 + dub * 5 + crisp + ir + sizeBoost;
          }
          return score(b) - score(a);
        });
        return good.slice(0, 8).map(function (c) { return c.s; });
      });
    });
  }

  /* ================================================================== *
   *  Provider functions (merged)
   * ================================================================== */

  function getHome(cb) {
    Promise.all([
      SOURCES.doostihaa.homeLists(),
      SOURCES.filmdoon.homeLists(),
      withTimeout(SOURCES.moviesho.homeLists(), 25000, { latest: [], dubbed: [], latestSeries: [], latestMovies: [] }),
      withTimeout(SOURCES.cinamatic.homeLists(), 25000, { latest: [], dubbed: [], latestSeries: [], latestMovies: [] })
    ]).then(function (results) {
      var d = results[0], f = results[1], mh = results[2], ci = results[3];
      var mergedMovies = dedupe((d.latest || []).concat(f.latestMovies || [], mh.latest || [], ci.latest || []), function (x) { return mergeKey(x.title); });
      var mergedSeries = dedupe((f.latestSeries || []).concat(mh.latestSeries || [], ci.latestSeries || []), function (x) { return mergeKey(x.title); });
      var mergedDubbed = dedupe((d.dubbed || []).concat(f.dubbed || [], mh.dubbed || [], ci.dubbed || []), function (x) { return mergeKey(x.title); });

      var data = {};
      var trending = (mergedMovies.length ? mergedMovies : mergedDubbed).slice(0, 8).map(function (r) {
        return { raw: r, meta: null };
      });

      Promise.all(trending.map(function (t) {
        return withTimeout(tmdbLookup(t.raw.title, t.raw.year, true), 7000, null).then(function (meta) {
          return buildItemFromTmdb(meta, null, t.raw.title, t.raw.poster, t.raw.year);
        });
      })).then(function (metas) {
        var trendingItems = metas.map(function (m, i) {
          var raw = trending[i].raw;
          return new MultimediaItem({
            title: m.title,
            url: mergedUrl(defineProperty(raw.site, raw.url)),
            posterUrl: m.poster,
            bannerUrl: m.banner,
            type: typeFor(raw.title, raw.url),
            year: m.year,
            description: m.overview,
            score: m.rating
          });
        });
        data['Trending'] = trendingItems;
        data['Latest Movies'] = mergedMovies.slice(0, 18).map(basicItem);
        data['Latest Series'] = mergedSeries.slice(0, 18).map(basicItem);
        data['Persian Dubbed'] = mergedDubbed.slice(0, 18).map(basicItem);
        // English titles for home rows via TMDB (cached; top entries only)
        var rowJobs = [];
        function enrichRow(rowName) {
          (data[rowName] || []).slice(0, 12).forEach(function (item) {
            var isMovie = !/series|serial|anime/i.test(String(item.url || ''));
            rowJobs.push(withTimeout(tmdbLookup(item.title, item.year, isMovie), 7000, null).then(function (meta) {
              if (meta && meta.name) {
                item.title = meta.name;
                if (meta.poster && !item.posterUrl) item.posterUrl = meta.poster;
                if (meta.rating && !item.score) item.score = meta.rating;
              }
            }).catch(function () {}));
          });
        }
        enrichRow('Latest Movies');
        enrichRow('Latest Series');
        enrichRow('Persian Dubbed');
        return Promise.all(rowJobs).then(function () {
          cb({ success: true, data: data });
        }).catch(function () { cb({ success: true, data: data }); });
      }).catch(function () {
        data['Trending'] = [];
        data['Latest Movies'] = mergedMovies.slice(0, 18).map(basicItem);
        data['Latest Series'] = mergedSeries.slice(0, 18).map(basicItem);
        data['Persian Dubbed'] = mergedDubbed.slice(0, 18).map(basicItem);
        cb({ success: true, data: data });
      });
    }).catch(function (e) { cbError(cb, e); });

    function defineProperty(site, url) {
      var m = {};
      m[site] = url;
      return m;
    }

    function basicItem(raw) {
      return new MultimediaItem({
        title: stripTags(raw.title).replace(/دانلود (فیلم|سریال|انیمیشن)\s*/i, '').trim(),
        url: mergedUrl((function () { var m = {}; m[raw.site] = raw.url; return m; })()),
        posterUrl: raw.poster,
        type: typeFor(raw.title, raw.url),
        year: raw.year || null,
        score: raw.score || null
      });
    }
  }

  function search(query, cb) {
    Promise.all([
      withTimeout(SOURCES.doostihaa.search(String(query || '')), 25000, []),
      withTimeout(SOURCES.filmdoon.search(String(query || '')), 25000, []),
      withTimeout(SOURCES.moviesho.search(String(query || '')), 25000, []),
      withTimeout(SOURCES.cinamatic.search(String(query || '')), 25000, [])
    ]).then(function (results) {
      var all = (results[0] || []).concat(results[1] || [], results[2] || [], results[3] || []);
      // group by normalized title
      var groups = {};
      var order = [];
      all.forEach(function (r) {
        var k = mergeKey(r.title);
        if (!groups[k]) { groups[k] = { raws: [] }; order.push(k); }
        groups[k].raws.push(r);
      });

      var keys = order.slice(0, 20);
      var qWords = mergeKey(String(query || '')).split(' ').filter(Boolean);
      function relevance(k) {
        if (!qWords.length) return 0;
        var hit = 0;
        qWords.forEach(function (w) { if (k.indexOf(w) !== -1) hit += 1; });
        var exact = k === mergeKey(String(query || '')) ? 3 : 0;
        var starts = qWords.length && k.indexOf(qWords[0]) === 0 ? 1 : 0;
        return hit * 2 + exact + starts;
      }
      keys.sort(function (a, b) { return relevance(b) - relevance(a); });
      keys = keys.slice(0, 15);
      Promise.all(keys.map(function (k) {
        var g = groups[k];
        var best = g.raws[0];
        var year = null;
        g.raws.forEach(function (r) { if (r.year) year = r.year; });
        var urlMap = {};
        g.raws.forEach(function (r) { if (!urlMap[r.site]) urlMap[r.site] = r.url; });
        return withTimeout(tmdbLookup(best.title, year, typeFor(best.title, best.url) === 'movie'), 7000, null)
          .then(function (meta) {
            var it = buildItemFromTmdb(meta, null, best.title, best.poster, year);
            var isSeries = g.raws.some(function (r) { return typeFor(r.title, r.url) === 'series'; });
            return new MultimediaItem({
              title: it.title,
              url: mergedUrl(urlMap),
              posterUrl: it.poster,
              bannerUrl: it.banner,
              type: isSeries ? 'series' : 'movie',
              year: it.year,
              description: it.overview,
              score: it.rating
            });
          });
      })).then(function (items) {
        cb({ success: true, data: items.filter(Boolean) });
      }).catch(function (e) { cbError(cb, e); });
    }).catch(function (e) { cbError(cb, e); });
  }

  function load(url, cb) {
    var map = parseMergedUrl(url);
    var jobs = [];
    if (map.d) jobs.push(SOURCES.doostihaa.loadDetail(map.d));
    if (map.f) jobs.push(SOURCES.filmdoon.loadDetail(map.f));
    if (map.m) jobs.push(SOURCES.moviesho.loadDetail(map.m));
    if (map.c) jobs.push(SOURCES.cinamatic.loadDetail(map.c));
    if (!jobs.length) return cb({ success: false, errorCode: 'NOT_FOUND', message: 'no sources for this item' });

    Promise.all(jobs.map(function (j) { return withTimeout(j, 30000, null); })).then(function (details) {
      details = details.filter(Boolean);
      if (!details.length) return cb({ success: false, errorCode: 'NOT_FOUND', message: 'load failed on all sources' });

      var bestTitle = details[0].rawTitle;
      var year = null;
      details.forEach(function (d) { if (d.year) year = d.year; });
      var posterGuess = null;
      details.forEach(function (d) { if (!posterGuess && d.poster) posterGuess = d.poster; });

      var epMap = {};   // 's:e' -> [links]
      var movieLinks = [];
      var anySeries = false;
      details.forEach(function (d) {
        if (d.isSeries) anySeries = true;
        Object.keys(d.episodes || {}).forEach(function (key) {
          if (!epMap[key]) epMap[key] = [];
          d.episodes[key].forEach(function (l) { epMap[key].push(l); });
        });
        if ((d.movieLinks || []).length) {
          movieLinks = movieLinks.concat(d.movieLinks);
        }
      });

      withTimeout(tmdbLookup(bestTitle, year, !anySeries), 7000, null).then(function (meta) {
        // Series split across per-season posts: find sibling posts of the same
        // show (same TMDB id) and merge their episodes in.
        var seriesMeta = (!anySeries && Object.keys(epMap).length === 0 && movieLinks.length && meta && meta.id && !/film|movie/i.test(bestTitle)) ? null : (anySeries ? meta : meta);
        var needSeasonMerge = anySeries && meta && meta.id && meta.name && map.d;

        var mergeJob = needSeasonMerge
          ? mergeSiblingSeasons(meta, map.d, epMap)
          : Promise.resolve(epMap);

        mergeJob.then(function (mergedMap) {
          epMap = mergedMap;
          var it = buildItemFromTmdb(meta, null, bestTitle, posterGuess, year);
          var isMovie = !anySeries;
          var logoJob = (meta && meta.id) ? withTimeout(logoLookup(meta.id, isMovie), 7000, null).catch(function () { return null; }) : Promise.resolve(null);
          logoJob.then(function (logoUrl) {
            var item = new MultimediaItem({
              title: it.title,
              url: url,
              posterUrl: it.poster,
              bannerUrl: it.banner,
              logoUrl: logoUrl || undefined,
              description: it.overview || stripTags(details[0].rawTitle),
              year: it.year,
              score: it.rating,
              type: (anySeries || Object.keys(epMap).length > 0) ? 'series' : 'movie'
            });

            var episodes = [];
            if (Object.keys(epMap).length) {
              var keys = Object.keys(epMap).map(function (k) {
                var parts = k.split(':');
                return { s: parseInt(parts[0], 10), e: parseInt(parts[1], 10) };
              }).sort(function (a, b) { return a.s - b.s || a.e - b.e; });

              keys.forEach(function (k) {
                var best = epMap[k.s + ':' + k.e].map(function (l) {
                  return qualityOf(l.label + ' ' + l.url).h;
                }).reduce(function (a, b) { return Math.max(a, b); }, 0);
                episodes.push(new Episode({
                  name: 'S' + k.s + ' · Episode ' + k.e + (best ? ' · ' + best + 'p' : ''),
                  url: JSON.stringify(epMap[k.s + ':' + k.e]),
                  season: k.s,
                  episode: k.e
                }));
              });
            } else if (movieLinks.length) {
              var bestH = movieLinks.map(function (l) {
                return qualityOf(l.label + ' ' + l.url).h;
              }).reduce(function (a, b) { return Math.max(a, b); }, 0);
              episodes.push(new Episode({
                name: 'Full Movie' + (bestH ? ' · ' + bestH + 'p' : ''),
                url: JSON.stringify(movieLinks),
                season: 1,
                episode: 1
              }));
            }

            if (!episodes.length) return cb({ success: false, errorCode: 'NOT_FOUND', message: 'no playable links found' });
            item.episodes = episodes;
            cb({ success: true, data: item });
          }).catch(function (e) { cbError(cb, e); });
        }).catch(function (e) { cbError(cb, e); });
      }).catch(function (e) { cbError(cb, e); });
    }).catch(function (e) { cbError(cb, e); });
  }

  /* Find other doostihaa posts of the SAME series (same TMDB id) and merge
   * their season episodes into epMap. doostihaa publishes one post per season. */
  function mergeSiblingSeasons(meta, doostihaaUrl, epMap) {
    var latin = latinQuery(meta.name).replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
    if (!latin || latin.length < 2) return Promise.resolve(epMap);
    var base = 'https://www.doostihaa.com';
    var searchUrl = base + '/wp-json/wp/v2/posts?search=' + encodeURIComponent(latin) +
      '&per_page=20&_fields=id,link,title,date';
    return httpGet(searchUrl, { Accept: 'application/json' }, 15000, 0).then(function (res) {
      var posts;
      try { posts = JSON.parse(res.body); } catch (e) { posts = []; }
      var wanted = latin.toLowerCase();
      var seasonWords = /^(?:فصل|season|س?$|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم|یازدهم|دوازدهم|\d+|قسمت|دوبله|فارسی|زیرنویس|دانلود|سریال|فیلم|complete|pack)$/i;
      var siblings = (Array.isArray(posts) ? posts : []).filter(function (p) {
        if (!p || !p.link) return false;
        var u = absUrl(p.link, base);
        if (u === doostihaaUrl) return false; // base post already merged
        var t = String(p.title && p.title.rendered ? p.title.rendered : '');
        var lt = latinQuery(t).toLowerCase();
        if (lt.indexOf(wanted) !== -1) return true; // title contains series name
        // Persian-only titles: allow if every latin word is season/noise OR title has season words
        var rest = lt.replace(wanted, ' ').replace(/\b(19|20)\d{2}\b/g, ' ');
        var leftovers = rest.split(/\s+/).filter(function (w) { return w && !seasonWords.test(w); });
        return leftovers.length === 0 && /فصل|season|اول|دوم|سوم|چهارم|پنجم|ششم|هفتم|هشتم|نهم|دهم/.test(t);
      }).slice(0, 10);

      if (!siblings.length) return epMap;
      return Promise.all(siblings.map(function (p) {
        var u = absUrl(p.link, base);
        var t = stripTags(p.title && p.title.rendered ? p.title.rendered : '');
        return withTimeout(tmdbLookup(t, yearFrom(t), false), 7000, null).then(function (m2) {
          if (!m2 || !m2.id || m2.id !== meta.id) return null; // different show (Korea etc.)
          return withTimeout(SOURCES.doostihaa.loadDetail(u), 25000, null);
        });
      })).then(function (sibDetails) {
        sibDetails.forEach(function (d) {
          if (!d) return;
          Object.keys(d.episodes || {}).forEach(function (key) {
            if (!epMap[key]) epMap[key] = [];
            d.episodes[key].forEach(function (l) {
              var dup = epMap[key].some(function (x) { return x.url === l.url; });
              if (!dup) epMap[key].push(l);
            });
          });
        });
        return epMap;
      });
    }).catch(function () { return epMap; });
  }

  function loadStreams(data, cb) {
    Promise.resolve().then(function () {
      var links = data;
      if (typeof data === 'string' && data.charAt(0) === '[') links = JSON.parse(data);
      else if (data && typeof data === 'object' && data.url && typeof data.url === 'string' && data.url.charAt(0) === '[') links = JSON.parse(data.url);
      else if (data && typeof data === 'object' && data.url) links = [{ src: 'Source', url: data.url, label: data.name || '' }];
      if (!Array.isArray(links) || !links.length) return [];
      return buildStreams(links);
    }).then(function (streams) {
      cb({ success: true, data: streams });
    }).catch(function (e) {
      cbError(cb, e);
    });
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
  globalThis.PersianStream = { getHome: getHome, search: search, load: load, loadStreams: loadStreams };
})();
