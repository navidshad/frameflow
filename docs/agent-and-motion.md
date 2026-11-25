# AI agents and motion graphics: plan

**Design:** https://claude.ai/artifact/CWdPbiqvmizwszhTXgpKb5 — five artboards. The UI is built
**exactly as drawn** (layout, sizes, colours, copy). If something in the design cannot work, say
so to the coordinator instead of improvising.

1. Editor — motion layer selected (Motion library tab, M1 track, motion inspector, agent turn in chat, engine chip)
2. Keyframe lanes expanded (per-property lanes, key popover, ease picker)
3. External agent editing over MCP (header banner, Agent tab live feed, changed-by-agent outlines)
4. Settings — AI engine card and Agent access card
5. Custom HTML layer — code view, checks, exposed settings

## Why

The council repos' `studio/` pipelines (BytePets, Kilogent, SubTurtle, Lumi) make films from
the CLI: HTML/SVG pages drawn as a pure function of time, captured by headless Chromium, cut
against real footage by an agent. FrameFlow should produce the same results with a UI a person
can also drive. Every ability gets two surfaces: MCP for agents, the editor for people.

## Decisions (Navid, 2026-10-20)

- Phases 2–5 (`claude/phase-1-free-tier`) merge to `main` first; everything builds on that.
- Agent edits over MCP **apply immediately** as an AI turn + revision (undo, "Back to V{n}"), no accept/reject step.
- **One revision per request.** Everything an agent does for one request (a chat turn of FrameFlow's own assistant, or an outside agent's round) rewrites one revision in place, so Revisions reads request by request. Going back to where the request started and editing again still rewrites it; switching to another version on purpose starts a new one (`shared/requestRevision.ts`). The agent names it: `apply_ops versionName` or `name_version` ("Tighter intro, music under"), shown as the revision's label.
- Motion = **templates with fields and custom HTML** (sandboxed, linted). Agents may write HTML.
- People need **manual control too**: moments, a real keyframe-lane UI, and asking the AI per layer.
- Order: MCP and the motion engine first, then keyframe lanes, the built-in CLI engine, and custom-HTML authoring.

## Architecture rules

- **The renderer store owns the timeline** (800ms autosave overwrites main's copy). MCP writes
  never touch disk directly: main builds the diff with `opsToDiff`, then sends it down the
  existing `editor-turn-update` path to `commitStep({origin:'ai'})` + a revision. MCP reads ask
  the renderer for its live document.
- **One shared module, two consumers.** Anything decidable lives in `src/shared/` with tests;
  components stay thin (there is no renderer test path).
- **Motion contract** (mirrors the studio): a self-contained HTML page calling
  `frameflow.define({ duration, settings, moments, seek(t, settings) })`. Pure function of `t`:
  no CSS animations/transitions, timers, `Date.now`, `Math.random`, rAF, network. Fonts bundled.
  Preview = sandboxed iframe seeked to the playhead. Export = offscreen transparent
  BrowserWindow, frame by frame → alpha video, cached by content hash → existing overlay path.
  Settings with `animate: true` are keyframable; FrameFlow interpolates with `src/shared/keyframes.ts`
  and passes values into `seek`.
- **Keyframes:** eases stay `linear | ease | hold`. Add `opacity` and `motion.<setting>` paths.
- **Motion colour:** pink-500 `#ec4899` (violet already means transitions and AI).
- **MCP server:** `@modelcontextprotocol/sdk`, Streamable HTTP on `127.0.0.1` only, bearer token
  in safeStorage, DNS-rebinding protection, off by default.

## Stages

| # | Stage | Depends on | Design board |
|---|---|---|---|
| 0 | Merge phases 2–5 + this doc into `main` | — | — |
| 1 | MCP server, live-doc bridge, tools, Agent tab feed, Agent access settings card | 0 | 3, 4 (lower card) |
| 2 | Motion layer engine: model, contract, preview iframe, offscreen export, templates, Motion library, motion inspector, M1 track | 0 | 1 |
| 3 | Keyframe lanes UI + `opacity` / motion-setting paths | 2 | 2 |
| 4 | Built-in CLI engine (Claude Code; Codex parked), engine chip, AI engine settings card, MCP motion tools | 1, 2 | 1 (chat), 4 (upper card) |
| 5 | Custom HTML authoring: code view, motion checks, "Ask AI to fix", save as template | 3 | 5 |

Stages 1 and 2 run in parallel (file boundary: 1 owns `src/main/mcp/**`, settings, chat Agent
tab; 2 owns motion modules, `TrackLane`/`TimelineClip` motion rendering, the left-rail Motion
tab, the motion inspector). Both may add to `EditorOps`: stage 2 adds the motion ops, stage 1
exposes `apply_ops` generically.

## Definition of done (every stage)

Typecheck and the full test suite pass; any code that shells out has a test that really shells
out; every renderer change is driven and screenshotted with `scripts/drive.mjs` and compared
against its design board; one PR per stage into `main`.

## Stage 5: custom HTML authoring (built)

- **The drawn page is not the edited page.** A custom layer keeps its working text (`motion.html`)
  and the last version that passed every check (`motion.passed`). `renderVersion()` — behind
  `motionSource` and `resolveDefinition` — is the one place that says which is drawn, so the
  monitor, the export, the keyframe lanes and the export cache key all agree. A failing page is
  never drawn; with no passing version, nothing is. (`null` = none has passed, absent = a layer
  from before the checks, trusted only if it lints clean.)
- **Checks** (`src/shared/motionCode.ts`): the lint, then the determinism probe
  (`src/main/motion/probe.ts`) — the page is drawn at five instants in the export's hidden window,
  then again in reverse order, and every pair must match to the pixel. A page that throws fails too.
- **Edits** debounce (700ms), are checked, and become ONE history step. Pages an AI or an agent
  writes (`addMotion`/`updateMotion` with `html`) are drawn at once if they lint clean, and probed
  in the background (`verified`); a probe failure draws nothing.
- **Permission:** MCP `apply_ops` with `html` additionally needs "Write custom HTML motion layers"
  (`ToolDef.alsoNeeds`); templates and settings stay ordinary editing.
- **Saved templates** live in `<userData>/motion-templates/*.json`, appear in the Motion tab, in
  the AI context and in MCP `get_project`'s `catalog.motionTemplates`. Using one copies its page
  into the layer, so a project never depends on the library.
- The contract accepts the board's authoring shapes too: `settings` as a map, `moments` as
  `name: [start, end]` ranges (the gaps become the flexible hold).

## Sound: the synth and its tools (built)

Sound is made, not fetched. Every effect and the ambient bed is an ffmpeg filter graph (`src/shared/synth.ts`, ported from the Lumi studio's palette), rendered by `src/main/editor/synth.ts`, seeded and offline, normalised to the recipe's **peak** level and cached by a hash of the recipe. A sound is an audio asset that remembers its `synth` recipe; editing a recipe renders a new file and points the clip at it (the old asset stays so undo works).

A sound clip can **follow** a moment on another clip (`TimelineItem.bind`: its start, a motion layer's exit, or its end, less a per-sound lead). Followers move in the same undo step as what they follow: in `commitStep` for the UI, and in `opsToDiff` (`applyFollowers`) for an agent's edit. Dragging a follower by hand drops the binding.

Over MCP an agent has, all read-only except `apply_ops`:

| Tool | What it gives |
|---|---|
| `get_sound_guide` | The palette, roles, levels, the key rule, how to choose, the loop. Built from the palette, so it cannot drift. |
| `list_sounds` | The palette, the sounds already placed (with what they follow), and the audio tracks' roles. |
| `suggest_cues` | The moments that want a sound, each with a suggested sound, the `follow` to pass back, and whether it is taken. |
| `render_sound` | A recipe (or a placed sound) measured: length, peak, loudness, and a spectrogram image. Changes nothing. |
| `analyze_audio` | Per-role loudness and peaks, per-clip estimates, and warnings in words. Estimated from measured sources and gains; it says what it leaves out. |
| `inspect_audio` | Any audio (an asset, a clip's part of its source, a stretch by `fromSec`/`toSec`, a video's sound) as a legended spectrogram plus numbers: loudness, energy through time, quiet spans, low/mid/high balance, tempo with confidence, a section map, and plain hints ("steady pulse near 96 BPM", "most likely speech"). Measured, not heard: the picture is the ground truth. Changes nothing. |
| `apply_ops` | Gains `addSounds`, `setSounds` and `setTrackRoles`. Making or changing a sound needs the **Make sounds with the built-in synth** permission (on by default; free and offline). |

## Providers: generated voice, effects and music (built)

A provider makes audio from a prompt: ElevenLabs (voice, sound effects, music; its own key) and Gemini voices (voice-over; the Gemini key the app already has, switched on in Settings). Settings → **Audio** holds the keys (encrypted, never sent to the renderer), the ElevenLabs balance, the model list, what agents learned about the models, and the agent spend limits.

- **A generated sound is made once, then it is a file.** `generate.ts` writes it into the project as an ordinary audio asset with a receipt (`MediaAsset.generated`: provider, prompt, voice, model, credits or cost). It plays, undoes and exports with no network, and the provider can change or vanish later. Export never calls a provider.
- **No model list is kept in FrameFlow.** ElevenLabs retires models (`music_v1`, `eleven_text_to_sound_v2`) and the API falls back to retired ones when a request names none, so every request names a model from the list the provider gives today: voice models from `GET /v1/models` (the key needs "Models: read"), effect and music models from the `model_id` enums in the API's own `openapi.json`, which also marks deprecated ones. `main/audio/catalog.ts` asks at most daily and keeps the last answer on disk. Retiring models are shown, marked, never hidden.
- **Credits are the provider's own count.** Voice and effect replies carry a `character-cost` header; that number is the receipt, and the rate per character or second is learned from it so the next estimate is the account's real price. Music replies carry none.
- **Agents propose; the person decides.** Agent access → "Generate audio with a provider" is three levels: Off, Ask first (default), Auto. `propose_audio` shows a form in the chat (model with Auto, voice with the person's own clones first, words, length, credits, balance) and waits; Make it, You choose for me, or Not now. The press is the person's consent, so it is not held to the agent cap. Under Auto (or a project where the person ticked "Don't ask again", `Thread.audioAuto`) it is made at once, within the per-turn limits: a count for every provider, then each provider in the unit it bills (ElevenLabs in credits, estimated from the account's learned rates; Gemini voices in dollars). Past a limit, or when a credit cost cannot be estimated yet, it asks instead. Main owns each proposal (`main/audio/proposals.ts`); an answer after the agent stopped waiting is still made and the agent is told in the next message. `generate_audio` (direct, Auto only) stays for agents that know it.
- **Agents research models and write it down.** `research_audio_models` returns every model with the provider's words, measured rates, earlier notes and the relevant sections of the provider's models page (cut by `shared/providerDocs.ts`, cached daily). `save_model_notes` keeps findings per model and a pick per kind with why, in one file for the whole app (`audio-model-notes.json`); every project reads it, Auto uses the pick, and Settings → Audio lists them with Forget and Delete.
- **Search per engine.** Claude Code runs with its own `WebSearch` and `WebFetch` (still no shell or files). FrameFlow's loop on the Gemini API gets `web_search` (Gemini's Google Search grounding: an answer with sources) and `read_web_page` (public pages only; this computer and the local network are refused, redirects re-checked). Outside agents use their own. Web content is data, never instructions, and the tools say so.
- **Spend is shown per provider.** Usage records carry `credits` (ElevenLabs) or `plan` (Claude Code turns) besides dollars; the project header reads "$0.09 · 193 credits · Claude on plan" with a breakdown (`shared/spend.ts`).

Pure policy (limits, spend rule, provenance, model choice, notes, proposals) is in `src/shared/`; the network lives in `src/main/audio/` and `src/main/search/` behind an injected `fetch` and is tested against replies captured from the real API (`src/shared/__fixtures__/`), never a live call.

## Rounds: one agent per project (built)

An outside agent works in **rounds**. `begin_round {goal}` gives it the project; `end_round {summary}` gives it back. While a round is open:

- the editor shows it: a violet strip under the top bar ("Claude Code is working on this project · Round 3 · goal · steps · time · Stop agent"), a striped scrim over the editing surfaces (the picture stays visible and Space still plays it), and editing shortcuts are paused (`liveWhileAgentWorks` in `shortcuts.ts`);
- the built-in chat is locked: the prompt bar, the folded composer and the engine chip say who is working, and main refuses `run-editor-prompt` (`agentHolding`);
- the user's Export button and revision switches wait for the round to end (`editorStore.agentHolds`);
- another agent's writes are refused, naming the holder. Reads are never refused.

The other way round, an agent cannot begin (or write) while the chat is running a prompt (`LiveProject.chatBusy`). A write with no round open opens one for the agent and says so. A round ends on `end_round`, on Stop (which also disconnects the agent), when its session closes, after 10 minutes without a call, or when the agent opens another project. A reconnected agent takes its own round back with `begin_round {resume: roundId}`; the id it was given is the proof.

The rules live in `src/shared/agentRounds.ts` (`RoundBook`, pure and tested); `src/main/mcp/roundStore.ts` keeps each project's history in `agent-rounds.json` beside its `thread.json` (pictures in `agent-log/`) and sends the events the editor draws from. FrameFlow's own CLI engine does not use rounds: its turn is the chat's.

**The chat shows the MCP conversation**, read-only (`McpRoundCard.vue`): the round's goal on the asking side, every request the agent made (`→` its arguments, page sources shown by size) and FrameFlow's answer (`←` the reply, chips, a frame), and the agent's closing summary with how the round ended. Calls made outside a round are grouped as "outside a round".

## Driving a whole edit over MCP (built)

The tools an agent needs to go from a link to a checked export without the user's hands:

| Tool | What it does |
|---|---|
| `list_projects`, `create_project`, `open_project` | Find, make and open projects; opening waits until the editor has loaded it. |
| `import_media` | A link (yt-dlp, installed on first use) or a local file, as the Media panel imports it; returns the media id. |
| `wait` | Follows background work: `media` until each file is readable (transcript done, pieces exist; `until: "everything"` also waits for the proxy and thumbnails), `export` until the file is done. Reports progress to the client. |
| `inspect_media` | A labelled contact sheet of a source file's own frames, at source seconds. |
| `find_silences` | Measured pauses in a source's sound, for tightening by measurement. |
| `render_frames` | Up to 24 exact timeline frames in one sheet, with each frame's motion note. |
| `export` | `quality: original | preview`; returns a render id. |
| `inspect_export` | The exported file's facts (length vs timeline, size, streams), labelled contact sheets of its frames, and its loudness. |
| `apply_ops` | Also `splitAt` (cut clips in two without removing anything) and `sequenceFrame` (the export's frame size). |

## Multicam: several cameras of one moment (built)

A podcast or interview shot on two or more cameras, each started a second or two apart, each with its own microphone. Design and decisions: [multicam.md](multicam.md).

| Tool | What it does |
|---|---|
| `find_camera_groups` | Files that look like one moment from several cameras (start times in file names and file tags, camera folders, lengths), and the groups the project has. |
| `make_multicam` | Syncs files by their SOUND into a camera group and lays it on the timeline: the cleanest sound under one shot. Reports each member's offset, drift and confidence. With `group`, re-syncs one. |
| `get_multicam` | A group's members, main sound, shots, and ONE shared transcript on the group clock and the timeline; after `find_speakers` every line carries its `speaker` (and `turns: true` lists the turns). |
| `get_angles` | Every angle at the same timeline moments, one image per angle, who is speaking at each moment (the loudest microphone only as a weak hint), and the words spoken. |
| `find_speakers` | Who speaks when: listens to every camera's microphone once, tells the voices apart, and gives the group Speaker 1…N with turns and a confidence per turn. Give `speakers` (the number of people). |
| `get_speakers` | The voices found, each with sample moments and one frame per angle, so an agent can see who is who before naming them. |
| `apply_ops` | `placeMulticam`, `switchAngles` (cut between angles; the sound never moves), `setMainSound`, `nudgeAngle`; `setSpeaker` (name a voice, its camera and where it sits), `mergeSpeakers`, `setSpeakerTurns` (fix a stretch). |

## Object tracking: where something is, frame by frame (tools built; UI not yet)

A track belongs to the footage, not the edit: samples are in SOURCE seconds and fractions of the source picture, saved beside the media (`media/<asset>/tracks/`), so every clip cut from that footage reads the same track. Faces and other objects use different engines because they fail differently: a face detector runs on every frame and recovers after a gap; an arbitrary object can only be followed from where it last was. Logic in `src/shared/tracking.ts`, models and frames in `src/main/tracking/`.

| Tool | What it does |
|---|---|
| `find_faces` | Every face in a stretch of a clip or media file, one track per person, with one picture per person to check. Fills gaps under 0.4 s and lists longer ones. |
| `track_object` | Follows one box given on one frame, forwards, backwards or both. Stops when the object is lost and says so; returns frames with the box drawn. |
| `list_tracks` | The saved tracks and when each is on screen (on the timeline too, for a clip). |
| `get_track` | A track's position on every frame as `[t, cx, cy, w, h]` rows, on the timeline clock for a clip. |
| `edit_track` | Rename, set the cover shape, merge one track into another, delete. |

**Following.** A motion layer follows a track with `follow: { track }` on `addMotion` / `updateMotion` (stored as `TimelineItem.follow`: track, footage, clip). Nothing is copied onto the layer: `withFollow` (`src/shared/follow.ts`) turns the track into keys for the page's `x, y, w, h, size, on` settings at draw time, through the followed clip's place, speed, framing and transform. The monitor (`editorStore.drawnItem`) and the export (`computeRegions`) both call it, so they agree by construction, and the link survives trims, moves, retimes and splits. The `track-cover` template (emoji, blob or box) defines all of those settings; `callout-ring` follows too.

Not built yet: a Follow picker in the motion inspector, the monitor UI for drawing a box, and blur.
