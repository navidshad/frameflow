# 🎨 UI & User Experience

The front-end is built to feel premium, responsive, and data-rich, guiding the user through a complex AI workflow with ease.

## 🛠 Tech Stack
- **Framework**: Vue 3 with Vite.
- **UI Architecture**: PilotUI (Internal Component System) + Tailwind CSS.
- **Styling**: "Glassmorphism" aesthetic with ambient gradients, backdrop blur, and dark mode support.
- **State Management**: Pinia (Modules for Threads, Settings, and API configuration).

---

## 🧭 User Flow

### 1. Project Initialization
Users start by providing a **Gemini API Key** in the redesigned Settings. This is stored locally and used for all multimodal requests.

### 2. Starting a project (Home)
The Home view (`HomePage.vue`) is a single **composer**: pick a purpose (Video or Images), attach files, type a prompt, send. The purpose is explicit rather than inferred — it decides which attachments are the *subject* and which are *reference material*, and it sets `Thread.type`. Below the composer sits the list of **Thread Cards** for existing projects, each badged with its kind (Video / Images / Timeline). A secondary link starts a blank timeline project.

Videos can also come from a link: **`VideoLinkModal.vue`** carries the yt-dlp setup and download flow. **`SystemRequirementsBanner.vue`** surfaces missing FFmpeg/scenedetect and unsafe-storage warnings above the composer, before any file is committed.

### 3. Analysis
Sending the first turn creates the thread and starts the pipeline in one action, so users land on the graph with work already running.
- **Real-time Logs**: Users see exactly what the pipeline is doing (Extractions, Scene Detection).
- **Video Preview**: A low-res preview is generated for immediate playback.

### 4. Interactive Chat & Refinement
The heart of the app is the **node graph** (`src/renderer/src/pages/GraphChatPage.vue`).
- **Context-Aware Messages**: The AI remembers the video content and previous summary versions.
- **Version Tracking**: Every "Generate" command creates a new version of the video. Users can switch between versions to compare results.

### 5. Editing video — the timeline
Video work happens in the timeline editor, not the graph. Home's **Video** purpose
creates a project, imports the file, and leaves your prompt in the editor's prompt
bar until preprocessing finishes. The editor's AI produces an **editable timeline**
(see `src/main/editor/prompt.ts` and `ops.ts`), and every turn becomes a revision
you can switch to or branch from — list or graph view, in the Revisions tab.

Output length comes from your request. Personas describe style only.

### 6. Light and Pro
The editor's top bar carries a **`Light | Pro`** switch (`src/renderer/src/editor/editorMode.ts`). It is one editor in two amounts, not two editors.
- **Pro** is the whole editor.
- **Light** is the same editor with the advanced tools put away, because the assistant does that work for most people. Basic editing is in both: import, drag onto a track, move, trim, split, delete, titles, captions, loudness, markers, track controls, Inspect, thumbnail, export, the chat, and camera angles.

**What Light hides**
- **Animation**: the Keyframes button and its lanes, the key toggles in Inspect, the motion path on the picture, and a motion layer's Animate section and HTML tab.
- **Making advanced things by hand**: "Add a motion layer" and "Add a generated background" in the timeline toolbar.
- **The Motion, Transitions, Effects and Sound libraries** in the left rail, which leaves Media and Words.

**The rules**
- **Never a second version**: Light has no UI of its own. A tool is either there, looking and working exactly as it does in Pro, or it is not there.
- **Hide the making, keep the result**: Light hides the ways to *create or animate* advanced things by hand. Whatever is already on the timeline (motion layers, transitions, effects, sounds, keys) still plays, and can be selected, moved, trimmed and deleted.
- **The assistant is the same in both**: it keeps every tool in Light and in Pro. The mode changes what the person sees, never what the assistant can do.
- **Remembered per machine**: the mode lives in `localStorage['editor.mode']`, and switching keeps the project, playhead and selection. A machine that has never chosen opens in Light.

## 🧩 Key Components

- **`App.vue` (Shell)**: Manages global theme, ambient backgrounds, and navigation state using `AppRoot`.
- **`PageHeader.vue`**: A standardized header component used across pages for title, subtitle, and navigation actions.
- **`ChatMessage.vue`**: Handles both text bubbles and AI results. It embeds `VideoResult` for playback and `TimelineResult` for segment visualization. Includes token usage and cost metrics.
- **`ThreadCard.vue`**: A rich snippet card displaying video project metadata (thumbnail, status, last modified) on the home screen.
- **`TimelineResult.vue`**: Visualizes the AI-selected segments as an interactive list within the chat stream.

---

## ✨ Design Principles
- **Clarity**: High-contrast labels for "User" vs "AI" messages.
- **Transparency**: AI "Thinking" states are visible via status updates. Token usage and costs are explicitly shown.
- **Depth & Immersion**: Use of ambient colored blobs and glass-like surfaces to create a modern, high-end feel.
- **Efficiency**: Only the necessary parts of the UI re-render when a new video version is assembled.
