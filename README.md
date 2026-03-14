# YTDrop — YouTube Downloader
**by SAAD KHAN**

Fast YouTube downloader — 4K, 2K, 1080p, 720p, MP3. Video + Audio always combined.

---

## ⚠️ GitHub Pages CANNOT run this app

GitHub Pages = **static files only**. This app needs a **Node.js server** to run.  
That's why you get "unexpected doctype" — GitHub Pages returns an HTML error page instead of your API response.

**Use Railway instead — free, and deploys directly from GitHub in 2 minutes.**

---

## 🚀 Deploy to Railway (Free — Recommended)

1. Push this repo to GitHub
2. Go to **[railway.app](https://railway.app)** → Login with GitHub
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your `ytdrop` repo
5. Railway reads `nixpacks.toml` and auto-installs yt-dlp + ffmpeg
6. Click **Deploy** — takes ~2 minutes
7. You get a live URL: `https://ytdrop-xxx.up.railway.app`

---

## 🌐 Deploy to Render (Alternative)

1. Go to **[render.com](https://render.com)** → New Web Service → Connect GitHub repo
2. Build Command:
   ```
   npm install && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp
   ```
3. Start Command: `node server.js`
4. Deploy

---

## 💻 Run Locally (Windows)

1. Install [Node.js](https://nodejs.org) LTS
2. Download `yt-dlp.exe` from [yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest)
3. Place `yt-dlp.exe` in this folder
4. Double-click `start.bat`
5. Open `http://localhost:3000`

---

## Why "Unexpected DOCTYPE" happens

GitHub Pages only serves static files. Every `/api/*` call returns GitHub's 404 HTML page (which starts with `<!DOCTYPE html>`). Your app expects JSON — so it crashes with "unexpected doctype".

Fix: **Railway or Render** actually run your Node.js server.

---

## Folder structure

```
ytdrop/
├── server.js        ← Node.js backend
├── package.json
├── nixpacks.toml    ← Railway: auto-installs yt-dlp + ffmpeg
├── render.yaml      ← Render config
├── Procfile         ← Heroku config
├── start.bat        ← Windows launcher
├── .gitignore
└── public/
    └── index.html   ← Frontend UI
```
