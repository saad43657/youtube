// ═══════════════════════════════════════════════════════════
//  YTDrop — YouTube Downloader  |  by SAAD KHAN
//  server.js — Node.js + Express backend
// ═══════════════════════════════════════════════════════════
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { exec, spawn } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DL_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DL_DIR)) fs.mkdirSync(DL_DIR, { recursive: true });

// ── Find yt-dlp ───────────────────────────────────────────
const YTDLP = (() => {
  const candidates = [
    path.join(__dirname, 'yt-dlp.exe'),  // Windows local
    path.join(__dirname, 'yt-dlp'),      // Linux local
    '/usr/local/bin/yt-dlp',             // Linux system (Railway/Render)
    '/usr/bin/yt-dlp',                   // Linux system alt
    'yt-dlp.exe', 'yt-dlp'              // PATH fallback
  ];
  for (const c of candidates) try { if (fs.existsSync(c)) return c; } catch {}
  return 'yt-dlp';
})();

// ── Find ffmpeg (from ffmpeg-static npm package) ──────────
const FFMPEG = (() => {
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) return p; } catch {}
  return 'ffmpeg';
})();

// ── Helpers ───────────────────────────────────────────────
const isYT = u => /(?:youtube\.com\/(?:watch|shorts)|youtu\.be\/)/.test(u);

const safeName = n => (n || 'video')
  .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
  .replace(/[^\x20-\x7E]/g, '_')
  .replace(/\s+/g, '_')
  .slice(0, 50) || 'video';

const contentDisp = fn => {
  const a = fn.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '_');
  return `attachment; filename="${a}"; filename*=UTF-8''${encodeURIComponent(fn).replace(/'/g, '%27')}`;
};

const sseOpen = res => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
};

const emit = (res, d) => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

// ── Base yt-dlp args (speed + unthrottle) ─────────────────
// KEY: player_client=android gets unthrottled CDN URLs from YouTube
// Without this, YouTube throttles to 100-200 KB/s intentionally
const BASE_ARGS = [
  '--no-playlist', '--no-warnings', '--no-check-certificates',
  '--extractor-args', 'youtube:player_client=android,web',
  '--extractor-retries', '3',
  '--fragment-retries', '10',
  '--concurrent-fragments', '4',
];

// ── /api/status ───────────────────────────────────────────
app.get('/api/status', (req, res) => {
  exec(`"${YTDLP}" --version`, (err, out) => {
    if (err) return res.json({ ok: false, message: 'yt-dlp not found. Place yt-dlp.exe in the project folder.' });
    res.json({ ok: true, version: out.trim(), ffmpeg: fs.existsSync(FFMPEG) });
  });
});

// ── /api/info — fetch all formats for a video ─────────────
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url || !isYT(url)) return res.status(400).json({ error: 'Not a valid YouTube URL.' });

  let out = '', err = '';
  const proc = spawn(YTDLP, [...BASE_ARGS, '--dump-json', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  proc.on('close', code => {
    if (code !== 0) return res.status(500).json({ error: 'Could not fetch video info. ' + err.slice(0, 200) });
    try {
      const info = JSON.parse(out);
      const fmts = info.formats || [];

      // Codec helpers
      const cname = c => !c ? '' :
        (c.startsWith('avc') || c.startsWith('h264')) ? 'H.264' :
        (c.startsWith('vp9') || c.startsWith('vp09')) ? 'VP9' :
        c.startsWith('av01') ? 'AV1' : '';
      const cprio = c => !c ? 9 :
        (c.startsWith('avc') || c.startsWith('h264')) ? 1 :
        (c.startsWith('vp9') || c.startsWith('vp09')) ? 2 :
        c.startsWith('av01') ? 3 : 4;

      // Deduplicate video formats by height+fps, keep best codec/bitrate
      const vids = fmts.filter(f => f.vcodec && f.vcodec !== 'none' && f.height && f.height >= 144);
      const byKey = new Map();
      for (const f of vids) {
        const fps = Math.round(f.fps || 30), fb = fps >= 50 ? fps : 30;
        const key = `${f.height}_${fb}`;
        const cur = byKey.get(key);
        if (!cur) { byKey.set(key, { ...f, _fb: fb }); continue; }
        const nb = f.tbr || f.vbr || 0, cb = cur.tbr || cur.vbr || 0;
        if (nb > cb * 1.05 || (nb >= cb * 0.95 && cprio(f.vcodec) < cprio(cur.vcodec)))
          byKey.set(key, { ...f, _fb: fb });
      }

      const sorted = [...byKey.values()].sort((a, b) =>
        b.height !== a.height ? b.height - a.height : b._fb - a._fb
      );
      if (!sorted.length) sorted.push({ format_id: 'best', height: 1080, _fb: 30, fps: 30, filesize: null, vcodec: 'avc1' });

      const makeLabel = (h, fps) => {
        const ft = fps >= 50 ? ` ${fps}fps` : '';
        if (h >= 2160) return `4K Ultra HD${ft}`;
        if (h >= 1440) return `2K Quad HD${ft}`;
        if (h >= 1080) return `Full HD 1080p${ft}`;
        if (h >= 720)  return `HD 720p${ft}`;
        if (h >= 480)  return `480p${ft}`;
        if (h >= 360)  return `360p${ft}`;
        return `${h}p${ft}`;
      };

      const audios = fmts
        .filter(f => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none' && (f.abr || f.tbr))
        .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
        .slice(0, 4);

      res.json({
        id: info.id, title: info.title,
        channel: info.uploader || info.channel || '',
        duration: info.duration, durationStr: info.duration_string || '',
        thumbnail: info.thumbnail,
        viewCount: info.view_count, likeCount: info.like_count,
        url: info.webpage_url || url,
        videoFormats: sorted.map(f => ({
          formatId: f.format_id, height: f.height,
          fps: f._fb || Math.round(f.fps || 30),
          codec: cname(f.vcodec),
          filesize: f.filesize || f.filesize_approx || null,
          label: makeLabel(f.height, f._fb || Math.round(f.fps || 30))
        })),
        audioFormats: audios.map(f => ({
          formatId: f.format_id, ext: f.ext || 'm4a',
          abr: Math.round(f.abr || f.tbr || 0),
          filesize: f.filesize || f.filesize_approx || null,
          label: `MP3 · ${Math.round(f.abr || f.tbr || 0)}kbps`
        }))
      });
    } catch (e) { res.status(500).json({ error: 'Parse error: ' + e.message }); }
  });
});

// ═══════════════════════════════════════════════════════════
//  DOWNLOAD — bulletproof video+audio pipeline
//
//  The only reliable way to get video WITH audio from YouTube:
//  1. Download video-only stream  →  _V temp file
//  2. Download audio-only stream  →  _A temp file
//  3. Our own ffmpeg merges them  →  final .mp4
//
//  Both downloads run IN PARALLEL (Promise.all) = full speed.
//  We call ffmpeg ourselves (not yt-dlp internal) = no merge bugs.
// ═══════════════════════════════════════════════════════════

function dlStream(url, fmt, outTpl, onProg) {
  return new Promise((resolve, reject) => {
    const args = [
      ...BASE_ARGS,
      '--newline', '--progress',
      '-f', fmt,
      '-o', outTpl,
      url
    ];

    let dest = null, oBuf = '', eBuf = '', totalF = 0, doneF = 0;
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const onLine = raw => {
      const t = raw.trim();
      if (!t) return;
      if (t.startsWith('[download] Destination:')) {
        dest = t.slice('[download] Destination:'.length).trim();
        return;
      }
      // Fragment-based: "[download] Downloading fragment 3 of 100"
      const mf = t.match(/Downloading fragment (\d+) of (\d+)/);
      if (mf) {
        doneF = +mf[1]; totalF = +mf[2];
        if (onProg) onProg(totalF ? (doneF / totalF) * 100 : 0, '', '', '');
        return;
      }
      // Percent-based: "[download]  45.3% of 89.45MiB at 3.21MiB/s ETA 00:23"
      const mp = t.match(/\[download\]\s+(\d+\.?\d*)%(?:.*?of\s+~?\s*([\d.]+\s*\S+))?(?:.*?at\s+([\d.]+\s*\S+\/s))?(?:.*?ETA\s+(\S+))?/);
      if (mp && onProg) onProg(+mp[1], (mp[2]||'').trim(), (mp[3]||'').trim(), (mp[4]||'').trim());
    };

    proc.stdout.on('data', d => { oBuf += d; const ls = oBuf.split('\n'); oBuf = ls.pop(); ls.forEach(onLine); });
    proc.stderr.on('data', d => { eBuf += d; const ls = eBuf.split('\n'); eBuf = ls.pop(); ls.forEach(onLine); });

    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`yt-dlp failed [${fmt}] code ${code}`));
      if (dest && fs.existsSync(dest)) return resolve(dest);
      const base = path.basename(outTpl).replace('.%(ext)s', '');
      const found = fs.readdirSync(DL_DIR).filter(f => f.startsWith(base) && !f.endsWith('.part')).map(f => path.join(DL_DIR, f));
      if (found.length) return resolve(found[0]);
      reject(new Error('Output file not found after download'));
    });
  });
}

function ffmpegMerge(vFile, aFile, outFile) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, [
      '-i', vFile, '-i', aFile,
      '-c:v', 'copy',       // stream-copy video = zero re-encode, instant
      '-c:a', 'aac',        // encode audio → AAC (mp4 compatible)
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', outFile
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errOut = '';
    proc.stderr.on('data', d => errOut += d);
    proc.on('close', code => {
      if (code !== 0 || !fs.existsSync(outFile))
        return reject(new Error('ffmpeg merge failed: ' + errOut.slice(-300)));
      resolve(outFile);
    });
  });
}

app.get('/api/download', (req, res) => {
  const { url, type, title } = req.query;
  if (!url || !isYT(url)) return res.status(400).json({ error: 'Invalid YouTube URL' });

  sseOpen(res);
  const isAudio = type === 'audio';
  const h       = parseInt(req.query.height) || 0;
  const ts      = Date.now();
  const name    = safeName(title || 'video');
  let   dead    = false;

  emit(res, { type: 'progress', percent: 1, speed: '', eta: '', size: 'Starting...' });
  console.log(`\n▶ [${type}] h=${h} ${url.slice(0, 70)}`);

  // ── AUDIO ONLY ────────────────────────────────────────
  if (isAudio) {
    const outTpl = path.join(DL_DIR, `${name}_${ts}.%(ext)s`);
    const args = [
      ...BASE_ARGS,
      '--newline', '--progress',
      '--ffmpeg-location', FFMPEG,
      '-f', 'bestaudio/best',
      '-x', '--audio-format', 'mp3', '--audio-quality', '0',
      '-o', outTpl, url
    ];
    let dest = null, oBuf = '', eBuf = '';
    const proc = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const onLine = t => {
      t = t.trim();
      if (t.startsWith('[download] Destination:')) { dest = t.slice('[download] Destination:'.length).trim(); return; }
      const m = t.match(/\[download\]\s+(\d+\.?\d*)%(?:.*?of\s+~?\s*([\d.]+\s*\S+))?(?:.*?at\s+([\d.]+\s*\S+\/s))?(?:.*?ETA\s+(\S+))?/);
      if (m) emit(res, { type: 'progress', percent: +m[1], size: (m[2]||'').trim(), speed: (m[3]||'').trim(), eta: (m[4]||'').trim() });
    };
    proc.stdout.on('data', d => { oBuf += d; const ls = oBuf.split('\n'); oBuf = ls.pop(); ls.forEach(l => onLine(l)); });
    proc.stderr.on('data', d => { eBuf += d; const ls = eBuf.split('\n'); eBuf = ls.pop(); ls.forEach(l => onLine(l)); });
    proc.on('close', code => {
      if (code !== 0) { emit(res, { type: 'error', message: 'Audio download failed.' }); return res.end(); }
      if (!dest || !fs.existsSync(dest)) {
        const f = fs.readdirSync(DL_DIR).find(f => f.startsWith(`${name}_${ts}`) && !f.endsWith('.part'));
        if (f) dest = path.join(DL_DIR, f);
      }
      if (!dest || !fs.existsSync(dest)) { emit(res, { type: 'error', message: 'File not found.' }); return res.end(); }
      const fn = path.basename(dest);
      emit(res, { type: 'progress', percent: 100, speed: '', eta: '', size: 'Done!' });
      emit(res, { type: 'done', filename: fn, downloadUrl: `/api/file/${encodeURIComponent(fn)}` });
      res.end();
    });
    req.on('close', () => { dead = true; try { proc.kill(); } catch {} });
    return;
  }

  // ── VIDEO + AUDIO (parallel download → ffmpeg merge) ──
  const cap      = h > 0 ? h : 9999;
  const vFmt     = cap < 9999 ? `bestvideo[height<=${cap}]` : 'bestvideo';
  const aFmt     = 'bestaudio[ext=m4a]/bestaudio';
  const vTpl     = path.join(DL_DIR, `${name}_${ts}_V.%(ext)s`);
  const aTpl     = path.join(DL_DIR, `${name}_${ts}_A.%(ext)s`);
  const outFile  = path.join(DL_DIR, `${name}_${ts}.mp4`);
  const cleanup  = (...files) => files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });

  // Combined progress: video = 65% weight, audio = 35%
  let vPct = 0, aPct = 0;
  const sendProg = (speed, eta, size) => {
    if (!dead) emit(res, {
      type: 'progress',
      percent: Math.min(Math.round(2 + (vPct * 0.65 + aPct * 0.35) * 0.88), 90),
      speed, eta, size
    });
  };

  // Download BOTH streams at the same time
  Promise.all([
    dlStream(url, vFmt, vTpl, (p, size, speed, eta) => { vPct = p; sendProg(speed, eta, size); }),
    dlStream(url, aFmt, aTpl, (p) => { aPct = p; })
  ])

  // Merge with our own ffmpeg call
  .then(([vFile, aFile]) => {
    if (dead) return Promise.reject(new Error('cancelled'));
    console.log(`  V: ${vFile}\n  A: ${aFile}`);
    emit(res, { type: 'progress', percent: 92, speed: '', eta: '', size: 'Merging...' });
    return ffmpegMerge(vFile, aFile, outFile)
      .then(out => { cleanup(vFile, aFile); return out; });
  })

  // Success
  .then(finalFile => {
    const fn = path.basename(finalFile);
    const sz = fs.statSync(finalFile).size;
    console.log(`  ✓ ${fn}  (${(sz/1024/1024).toFixed(1)} MB)`);
    emit(res, { type: 'progress', percent: 100, speed: '', eta: '', size: 'Done!' });
    emit(res, { type: 'done', filename: fn, downloadUrl: `/api/file/${encodeURIComponent(fn)}` });
    res.end();
  })

  // Error
  .catch(err => {
    if (dead) return;
    console.error('  ✗', err.message);
    const leftovers = fs.readdirSync(DL_DIR).filter(f => f.includes(`_${ts}`)).map(f => path.join(DL_DIR, f));
    cleanup(...leftovers);
    emit(res, { type: 'error', message: err.message || 'Download failed.' });
    res.end();
  });

  req.on('close', () => { dead = true; });
});

// ── /api/file — serve downloaded file ─────────────────────
app.get('/api/file/:name', (req, res) => {
  const fn = decodeURIComponent(req.params.name);
  const fp = path.join(DL_DIR, fn);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  const stat = fs.statSync(fp);
  res.setHeader('Content-Disposition', contentDisp(fn));
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(fp).pipe(res);
  // Auto-delete after 20 minutes
  setTimeout(() => { try { fs.unlinkSync(fp); } catch {} }, 20 * 60 * 1000);
});

// ── /api/storage — list downloaded files ──────────────────
app.get('/api/storage', (req, res) => {
  try {
    const files = fs.readdirSync(DL_DIR)
      .filter(f => !f.endsWith('.part') && !f.includes('_V.') && !f.includes('_A.'))
      .map(f => { const s = fs.statSync(path.join(DL_DIR, f)); return { name: f, size: s.size, mtime: s.mtime }; })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(files);
  } catch { res.json([]); }
});

app.delete('/api/storage/:name', (req, res) => {
  try { fs.unlinkSync(path.join(DL_DIR, decodeURIComponent(req.params.name))); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  YTDrop  →  http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════╝`);
  console.log(`  yt-dlp  : ${YTDLP}`);
  console.log(`  ffmpeg  : ${FFMPEG}`);
  console.log(`  saves   : ${DL_DIR}\n`);
});
