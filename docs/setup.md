# 🛠 Installation & Setup Guide

How to set up the environment and run **FrameFlow Pro** locally.

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v20 LTS (v18 is the minimum; CI builds on 20)
- **Google Gemini API Key** ([Google AI Studio](https://aistudio.google.com/app/apikey)) — entered in the app's settings, never committed

That is the whole list.

### 📦 No external tools required

FrameFlow Pro ships every media binary it needs inside the app bundle. There is
nothing to install with Homebrew, Chocolatey, or pip:

| Tool | How it ships |
|---|---|
| **FFmpeg / FFprobe** | bundled via `ffmpeg-static` / `ffprobe-static`, unpacked from the asar at build time |
| **Scene detection** | FFmpeg's native `scdet` filter — no separate binary |
| **yt-dlp** | bundled via `ytdlp-nodejs`, with a self-healing update when a stale binary fails |

> Earlier versions of this guide asked you to `brew install ffmpeg` and
> `pip install scenedetect`. Both are obsolete: FFmpeg was always bundled, and the
> Python scene detector was replaced by `scdet`. If you installed either for
> FrameFlow, you can remove them.

---

## 💻 Installation

1. **Clone the repository**

   ```bash
   git clone https://github.com/navidshad/frameflow-pro.git
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the app**

   ```bash
   npm run dev
   ```

> Use **npm**, not yarn. `package-lock.json` is the maintained lockfile; the
> `yarn.lock` still in the tree is stale and will install a different dependency
> set.

---

## 🧪 Development scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload |
| `npm test` | Run the vitest suite |
| `npm run typecheck` | Typecheck main, preload, shared and renderer |
| `npm run build` | Build renderer + main into `out/` |
| `npm run build:mac` / `build:win` / `build:linux` | Package an installer for one platform |

`npm run typecheck` and `npm test` are what CI gates on, so run both before
opening a pull request.
