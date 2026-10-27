# PersianStream | دوبله فارسی — SkyStream Plugin

A SkyStream (Gen 2) plugin that streams **Persian-dubbed / Persian-subbed movies & series**
from **four scraper sources** — plain HTTP streams, **no torrents**.

## Sources

| Provider | What it gives you | Playback from outside Iran |
|---|---|---|
| **دوستی‌ها / Doostihaa** | Huge dubbed library, series with per-episode HLS + 1080p direct files (WordPress REST API) | ✅ works (HLS proxy + irdanlod CDN); newest posts may fall back to Iran-IP |
| **فیلمدون / Filmdoon** | Movies/series/anime, direct MP4 480p/720p/1080p (pishtaz CDN) | ✅ works |
| **نماگیت / Namagate** | Direct MP4 up to 1080p BluRay (upera CDN) | ⚠️ needs an Iranian IP (upera geo-blocks; VPN with IR exit works) |
| **آپارات / Aparat** | Community-hosted Persian dubbed uploads, public JSON API | ✅ works worldwide |

Each provider is a separate entry in the plugin — enable/disable them individually in
**SkyStream → Extensions → plugin settings**.

## Features

- Home dashboard: latest movies/series rows + dubbed-only rows + TMDB-enriched Trending hero
- Full-text search on every source (Persian or English titles)
- Movie/series detail pages with poster, year, rating, description (TMDB enrichment, cached)
- Series: season/episode grouping (قسمت/Farsi + S01E01 patterns), per-episode quality variants
- Streams sorted best-quality first; HLS masters returned as one adaptive `Auto` source
- Domain failover per site (mirror lists baked in, healthy host cached)
- Request timeouts + retries everywhere; a dead source never breaks the others
- TMDB metadata is best-effort and fully optional — scraping works without it

## Install (SkyStream app)

1. Open **SkyStream → Extensions → Add Source**.
2. Paste:
   ```
   https://raw.githubusercontent.com/DEM9N101/skystream-persian/main/repo.json
   ```
3. Install **PersianStream | دوبله فارسی**, open its settings and enable the providers you want.

## Repo layout

```
repo.json                     ← add THIS url in SkyStream
dist/plugins.json             ← plugin index
dist/com.dem9n101.persianstream.sky  ← the plugin package (zip of plugin.json + plugin.js)
plugin.json / plugin.js       ← source
test/harness.js               ← Node harness that shims the SkyStream JS runtime
                                 and verifies getHome/search/load/loadStreams + live streams
```

## Development

```bash
cd test
npm install linkedom
node harness.js          # runs all 4 providers against the live sites + verifies streams (Range GET)
```

## Notes

- `namagate` and the newest doostihaa posts use the **upera** CDN which only serves Iranian
  IPs — those entries show a "قطع VPN" page outside Iran. Use any VPN with an Iranian exit,
  or just use the other providers (toggle namagate off).
- Persian subtitle tracks are usually hard-coded (چسبیده) into the videos by these sites.
- All streams are direct HTTP(S) (mp4/mkv/HLS). No torrents, no magnet links.
