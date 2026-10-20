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
| `apply_ops` | Gains `addSounds`, `setSounds` and `setTrackRoles`. Making or changing a sound needs the **Make sounds with the built-in synth** permission (on by default; free and offline). |

Providers that cost money (generated sound, voice) are a separate permission that is off by default and arrives with the provider slot.
