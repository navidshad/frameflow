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

### 5. Hand-editing a cut — "Open in Editor"
Any video node (and the root media node) can be forked into a real timeline project via **`src/main/editor/promote.ts`**. The root node opens the full source with its pieces in the tray; a result node opens with that node's AI cut already laid out on V1. The fork reuses the chat thread's existing proxy, audio, transcript and scene artifacts, so nothing is re-encoded or re-transcribed. A **Manual Edit** node appears in the graph edged from the node it came from, and the editor header shows a breadcrumb back to the source.

---

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
