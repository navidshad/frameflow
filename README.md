  # 🌊 FrameFlow

<img src="./docs/screenshots/motion-layer-selected.png" width="100%" alt="The FrameFlow editor: side rail, program monitor with a motion lower third selected, chat, inspector, and a timeline with a pink motion track above the video track" />

---

  **FrameFlow** is a high-fidelity multimedia platform that bridges the gap between raw video/image assets and creative intelligence. By fusing **Google Gemini's** multimodal brain with precise **FFmpeg** engineering, FrameFlow transforms how you consume, extract, and generate media.

<div>
  
  [![License: PolyForm Noncommercial](https://img.shields.io/badge/License-PolyForm%20Noncommercial-orange.svg)](LICENSE)
  [![Platform: Electron](https://img.shields.io/badge/Platform-Electron-lightgrey.svg)](https://www.electronjs.org/)
  [![Framework: Vue 3](https://img.shields.io/badge/Framework-Vue%203-4fc08d.svg)](https://vuejs.org/)
  [![AI: Google Gemini](https://img.shields.io/badge/AI-Google%20Gemini-4285F4.svg)](https://deepmind.google/technologies/gemini/)

</div>

---

## 🚀 The Three Pillars of FrameFlow

FrameFlow splits work by **what you are making**, not by what you upload. Video and
audio go to a timeline; images go to a node graph.

### 1. 🎞️ Video → Video (the timeline editor)
A real multi-track timeline with an AI editor sitting next to it.
- **Say what you want, at any length**: *"cut the filler but keep the whole lecture"* and
  *"make a 2-minute highlight"* are both just prompts — nothing presets a runtime.
- **Always editable**: the AI proposes a timeline, not a rendered file, so you can drag
  any edge it got wrong instead of re-prompting.
- **Branchable history**: every AI turn becomes a revision you can switch to or branch
  from, viewable as a list or a graph.
- **Manual tools too**: split, ripple-delete, retime, markers, chapters, silence finder,
  transitions, effects you can switch on and off to compare, and edit-on-canvas handles
  (move, scale, rotate) in the monitor.
- **Motion graphics**: lower thirds, titles and custom HTML/SVG layers on their own **M1 track**,
  with a Motion library, per-layer settings, and keyframe lanes (see below).
- **Sound**: waveforms, audio clip inspector, track roles, and a Sound tab with synthesised
  effects you can drop on the timeline.
- **Multicam**: sync cameras by sound, find who is speaking when, and cut between angles
  with the number keys. See [docs/multicam.md](docs/multicam.md).
- **Fast import**: the transcript starts from the original audio at once, while the proxy is
  built beside it. You can edit before everything is ready. See [docs/import-lanes.md](docs/import-lanes.md).
- **Exports tab**: every finished export is listed per project, to reveal or open.

### 2. 📸 Video → Thumbnail
Generate a cover image from footage.
- **Frame-aware**: the video is sampled and analysed, so you can say *"use the moment at
  the train station"* and it knows which one you mean.
- **Designed, not just rendered**: composition rules (rule of thirds, contrast, subject
  consistency) are baked into the generator.

### 3. 🎨 Images → Image (the node graph)
Branching exploration for still images.
- **Compare, then branch**: generate several variants side by side and continue from the
  one that worked — which is what a canvas is good at and a linear chat is not.
- **Multimodal fusion**: combine your own images with frames pulled from a reference video.
- **Prompt-driven refinement**: iterate in natural language, with every result kept.

---

## 🤖 AI agents and motion graphics

**Your own AI, driving the editor.** FrameFlow runs a local **MCP server** (off by default,
`127.0.0.1` only, bearer token) so agents such as Claude Code and Codex can read and edit your
open project. An agent's work lands as one **round**: a revision you can undo or branch from,
with the conversation in the chat and its changes outlined on the timeline. Turn it on under
**Settings → Agent access**.

**Built-in engines.** Pick Claude Code or Gemini as the editing engine from the chat box's engine chip
(**Settings → Video editing**). Both edit through FrameFlow's own MCP tools, in as many steps as the
request needs, and each turn shows its steps. Claude Code runs on your own plan; Gemini runs a loop
inside FrameFlow on your Gemini key and shows what each turn cost.

<div align="center">
  <img src="./docs/screenshots/settings-ai-engine.png" width="80%" alt="Settings: the AI engine card" />
</div>

**HTML motion layer.** A motion layer is an HTML page drawn as a pure function of time, so
preview and export match frame for frame. Start from a template, or write custom HTML with a
code view, automatic checks and "save as template". Text in Persian and Arabic works (Vazirmatn is bundled).

<div align="center">
  <img src="./docs/screenshots/keyframe-lanes-motion-path.png" width="100%" alt="Keyframe lanes expanded under a motion layer on the timeline" />
</div>

Plan and decisions: [docs/agent-and-motion.md](docs/agent-and-motion.md).

---

## 🧩 Supported Inputs

FrameFlow handles a wide range of media formats and sources:

- **Video Formats**: Native support for `.mp4`, `.avi`, `.mov`, and `.webm`.
- **Audio**: `.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg` — audio-only projects work on the timeline too.
- **Online Sources**: YouTube, Google Drive, and direct media URLs (via `yt-dlp`).
- **Images**: High-fidelity `.jpg`, `.png`, and `.webp` for structural reference and multimodal generation.
- **Optimization**: High-res videos are automatically downscaled (480p) to ensure lightning-fast AI analysis without losing metadata.

---

## 🎨 Premium Experience (UX)

FrameFlow isn't just a tool; it's an iterative workspace:

- **Timeline Editor**: Multi-track editing with a program monitor, filmstrip/context views,
  a left side rail (Media, Motion, Sound and more), an Inspect tab, full-height chat, and an
  AI prompt bar where you pick the engine, model and effort (Claude Code or Gemini API).
- **First-run setup & Settings**: a first-launch wizard, a two-road Home, and a seven-section
  Settings page (General, Connections, Video editing, Image editing, Audio, Agent access, Usage and pricing).
- **Vue Flow Graph Interface**: Branch image generations — and browse your edit history as
  a revision tree — visually.
- **Live Metrics**: Monitor AI token usage and processing costs in real-time.
- **Zero-Config Preprocessing**: Automatic scene detection and transcript extraction.
- **Flat, dark-mode-first design**: flat surfaces, one dialog style, and a light theme.

---

## 🧭 Navigation & Setup

| Section | Link | Purpose |
| :--- | :--- | :--- |
| 🏗 **Architecture** | [**Deep-Dive**](./docs/architecture.md) | The two workflows, media pre-processing, and the editor's AI contract. |
| 🚀 **Installation** | [**Setup Guide**](./docs/setup.md) | Node.js, Gemini API, FFmpeg, and yt-dlp setup. |
| 🎨 **UI/UX** | [**Design Overview**](./docs/ui_ux.md) | Frontend components and interaction flow. |
| 📦 **Releasing** | [**Build & Signing**](./docs/releasing.md) | Cutting a release, code signing, and notarisation. |

---

## ⬇️ Downloads

Installers are on the [**Releases**](https://github.com/navidshad/frameflow/releases) page:

| Platform | File |
| :--- | :--- |
| 🍎 **macOS** (Apple Silicon) | `.dmg` — signed and notarised |
| 🪟 **Windows** (x64) | `.exe` — not signed yet, SmartScreen will warn |
| 🐧 **Linux** (x64) | `.AppImage` or `.deb` |

**Intel Mac?** There is no prebuilt installer, but you can build one yourself.
On an Intel Mac, or on Apple Silicon (it cross-builds), from a clone of this repo:

```bash
npm_config_arch=x64 npm ci
npm run build && npx electron-builder --mac --x64
```

The installer lands in `dist/`. Without a Developer ID certificate it is
unsigned, so macOS will ask you to right-click → Open the first time.

---

## 📸 Interface Preview

**Starting a project** — one composer. Say what you want, attach files, go.

<div align="center">
  <img src="./docs/screenshots/02_home.jpg" width="100%" alt="The FrameFlow home composer: a Video/Images purpose toggle, a prompt box, and attach buttons" />
</div>

**The node graph** — branching image generation, where each result keeps the reference
images it was built from, so you can compare variants and continue from the one that worked.

<div align="center">
  <img src="./docs/screenshots/04_graph.jpg" width="80%" alt="The FrameFlow node graph: a thumbnail conversation branching into a generated result with its reference frames, model feedback, and upscaling options" />
</div>

---

## 📜 License

FrameFlow is **source-available, not open source.** You can read, run, modify and share
the code for **noncommercial** purposes under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). Commercial use needs a separate license:
contact navidshad72@gmail.com. Contributions are welcome — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

Releases up to and including v1.1.23 were published under the MIT License and remain
available under those terms. The MIT notice and all other third-party attributions are in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md), which must ship with every binary.

Original project created by [navidshad](https://github.com/navidshad), Somayeh Roohani and
Esat Can Karabag at Vilnius Gediminas Technical University (VGTU).

---

> [!TIP]
> **Pro Choice:** Check the **[Architecture Deep-Dive](./docs/architecture.md)** to see how the AI proposes edits as validated *ops* rather than touching media directly.
