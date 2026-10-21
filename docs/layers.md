# 🧬 Layers — opening up the footage

Every AI video editor on the market today treats a shot as an **opaque
rectangle**. It can be cut, moved, retimed, graded and decorated *around* — but
never opened. This document argues that decomposing a shot into layers, and
letting the AI direct all of them, is FrameFlow's strongest available
differentiator, and sets out what it would cost.

Status: **direction, not a commitment.** Lands as Phase 5 of the build plan and is
gated on the compositor built in Phase 3.

---

## 🎯 The thesis

Take a talking-head shot. Today every editor sees one thing: a rectangle of
pixels with a person somewhere inside it. FrameFlow should see three:

1. **The subject** — the speaker, with a real alpha edge.
2. **The background** — replaceable, and generatable: an animated canvas, a
   different shot, a solid colour, a scene.
3. **Content objects** — motion graphics that arrive on the beat of what is
   being said, and that can pass **behind** the speaker as well as in front.

That third point is the demo. An object travelling behind a speaker is instantly
legible to anyone watching, and it is structurally impossible for the tools
listed below. It is not a stylistic flourish — it is proof that the tool can
address the pixels rather than the frame.

---

## 🔍 What the competition actually does

The reference point is [OpenChatCut](https://github.com/0xsline/OpenChatCut) —
AGPL, ~253k lines, the most complete open-source AI editor available, and the
closest thing to a direct competitor. It was read in full for this document.

It ships **three of the four pieces** above, and is missing exactly the one that
matters.

### What it has

| Piece | Implementation |
|---|---|
| Animated canvas layer | AI generates React/Remotion components; evaluated in `src/template-host.ts`, rendered as a real clip |
| Footage as a layer | Multi-track, PiP B-roll, transforms, keyframes, blend modes |
| Narration-synced objects | Mature — see below |

The narration sync is further along than one might assume. Their
`talking-head-guide` skill instructs the agent: *"The MG should land with the
relevant speech beat or section boundary, not trail after the speaker has already
made the point. Use `find_transcript`; pass `includeWordTimestamps: true` when
the MG has internal rhythm such as list items appearing one by one."*

That is the "pop objects out relative to that moment of the narration" idea,
working today, in a competitor.

### What it does not have

**Subject extraction.** Not partially — not at all.

Their feature is advertised as "in-browser person segmentation and face-safe
zones", which sounds like the missing piece. It is not.
`src/geometry/mediapipe.ts` runs MediaPipe's selfie segmenter and a short-range
face detector **on the CPU, at 2 fps, at 512px, capped at 420 frames per asset**,
and returns:

```ts
segment: (canvas: HTMLCanvasElement) => { face: GeomRect | null; occ: Uint8Array }
```

`occ` is an occupancy grid of `GEOM_GRID_W × GEOM_GRID_H` = **18 × 32 = 576
cells** for the entire frame. That is not a matte and cannot become one. The
file's own comment settles the intent:

> geometry is an enhancement, never a blocker.

It answers **"where is the person, so I can avoid them"** — never *"which pixels
are the person."* Everything built on top follows from that limit:

- `place_graphics_in_safe_zone` picks "the largest safe rect" in the clip's time
  window and guarantees "face is never covered".
- `apply_caption_avoidance` routes subtitles around the speaker.
- `auto_reframe` moves a crop window to follow the subject.

Their keying is entirely manual and geometric — `chroma-key.frag` (needs a real
green screen), `luma-key`, `circle-mask`, `rect-mask`, `hsl-qualify`. Their
`backgroundFill` is a **blurred copy of the same clip**, used to fill letterbox
bars. The ONNX models they ship are beat detection, voice activity and speech
recognition — **there is no matting model anywhere in the repository**. An alpha
render path exists (ProRes 4444, alpha WebM) but only for exporting a motion
graphic to a file; footage never carries alpha.

### The strategic read

**Their entire safe-zone architecture exists because they cannot composite behind
the subject.** Caption avoidance, safe-zone placement and subject-following
reframe are the negative space of the feature described here — an elaborate,
well-engineered system for routing content *around* a person, built by a team
that would obviously rather put content *behind* them.

They can place a graphic beside a speaker. They can replace the speaker entirely
with a full-frame graphic. They cannot put anything behind them, and no
incremental change to an 18×32 grid gets them there.

---

## 💰 Why the gap exists

Not oversight — cost. Per-pixel matting at 30 fps over ten minutes is ~18,000
inference passes. OpenChatCut's 2 fps / 512px / CPU / 420-frame ceiling is that
arithmetic, made explicit and then declined.

**Two things have changed.** Matting models in the RVM / MODNet / BiRefNet class,
and the video-segmentation families with temporal propagation, now produce a
usable edge at a cost that is no longer absurd on a modern machine. And more
importantly:

**The alpha only has to be computed once per asset.** It is a property of the
footage, not of the edit. Compute it at import, cache it, and every subsequent
cut, retime and re-render reads it for free.

That is not a workaround. It is the same bargain FrameFlow already makes for
transcripts and scene detection, and it is precisely the bargain OpenChatCut
declined to make.

---

## 🏗 What FrameFlow already has

Two things fit well. One genuinely blocks.

### ✅ The matte is just another preprocessing step

`src/main/editor/preprocess.ts` runs per asset, skip-if-exists, with progress
reporting and soft-fail handling:

```ts
const DEFAULT_STEPS: PreprocessStep[] = ['proxy', 'audio', 'transcript', 'scenes', 'thumbnails']
```

A matte is step six. The expensive work is amortised once at import — exactly
like the transcript — rather than paid per frame at playback. The pipeline that
makes this affordable is already built, tested and shipping.

### ✅ The render model already anticipated layers

`src/main/editor/render.ts:270`:

> `videoLayers[1..n]` are the compositing seam (PiP/overlay, deferred).

`computeRegions` already slices at the union of every item boundary and collects
**every overlapping layer** per region. Only `videoLayers[0]` is rendered today.
The data model was designed for this; the Phase 3 `overlay` graph is the thing
that consumes it.

### ❌ The preview cannot composite

`src/renderer/src/editor/composables/useEdlPlayback.ts` plays through an A/B pair
of `<video>` elements — one visible, one buffering the next segment — plus a pool
of `<audio>` elements slaved to the playhead. It shows **one video at a time.**

Compositing a matted subject over a generated background needs a canvas or WebGL
compositor. That is a replacement of the playback engine, not an extension of it.

**This collides with a standing decision.** The roadmap lists *"Real-time
composited preview"* under **Not in this plan**, on the grounds that "the monitor
approximates, the export is exact," which is the bargain every proxy-based editor
makes. That decision is correct for transitions, colour and text — a dissolve
that snaps in preview and ramps on export is a tolerable lie.

It is **not** tolerable here. If the monitor shows the original rectangle and the
export shows the speaker over a generated background, the user cannot direct the
work at all — they are writing prompts blind and waiting on a render to find out.
Layer work is the one case where the approximation destroys the feature.

Phase 3 already carries a "third preview element for PiP", which is the same
pressure arriving early. **Phase 5 should be where that entry is formally
revisited**, not quietly contradicted.

---

## 🔧 What it would touch

Surfaces, not implementation. Each is a design task in its own right.

- **Preprocessing** — a matte step in `preprocess.ts`, producing a per-asset
  alpha artifact. Stored as a compressed greyscale sidecar rather than baked
  RGBA: seekable, far smaller, and it leaves the original untouched.
- **Quality gate** — the matte step must be able to report *"this footage will
  not matte well"* and decline, the way the transcript step already records
  `TranscriptHealth`. Shipping a bad edge is worse than shipping no feature.
- **Types** — `MediaAsset` gains a matte reference; `TimelineItem` gains a layer
  role so an item can declare itself subject, background or overlay. Both are
  additive; neither reshapes the document.
- **Render** — an FFmpeg alpha-merge and overlay graph consuming
  `Region.videoLayers[1..n]`. This is the Phase 3 compositor with one extra
  input, not a second engine.
- **Preview** — a compositing monitor. The largest single cost on this page.
- **Generated backgrounds** — a canvas/HTML layer type that renders to frames.
  The node graph already generates images; this is the moving version.
- **Ops schema** — the AI contract gains the ability to say *"put this behind the
  subject."* Given a layer role on the item, that is a field, not an
  architecture.
- **Context** — the AI must know a matte exists for an asset before it can
  compose against it.

**One composition description, two consumers.** The fade code already carries
this warning:

> the preview mirror of the export's `fadeA` builder

Two implementations of one behaviour, kept in sync by hand. Layer compositing
multiplies that risk. Preview and export should consume a single declarative
composition description — decided before the compositor is built, not after.

---

## ⚠️ Risks

1. **Matte quality is the whole product.** Hair, motion blur, fast gesture,
   glasses, low light. A bad edge looks worse than no effect at all, and this is
   what kills consumer versions of this feature. The quality gate above is not
   optional polish.
2. **Two compositors drift.** Addressed by the shared composition description —
   but only if that is decided up front.
3. **Storage.** An alpha sidecar per asset, alongside the proxy, audio, frames
   and thumbnails already retained.
4. **Compute stays local.** Consistent with the local-first pitch, and it must
   stay that way — this is exactly the feature that would tempt a cloud
   dependency, and cloud rendering is already ruled out.

---

## 🧭 Why this, and why now

The honest counter-argument is that FrameFlow has no effects, transitions,
transforms or text yet — those are still typed stubs in
`src/shared/types.ts:322` — and that layer decomposition is a large leap from
that starting line.

The answer is that **every one of those features needs the same thing this needs:
a compositor.** It is being built either way, in Phase 3.

So the choice is not *"layer decomposition or catch up on effects."* It is:

> Build the compositor once, then aim it at something a competitor cannot copy —
> rather than at a text-overlay feature they already shipped, arriving second.

Phases 1–3 buy parity. Phase 4 lets the AI reach that parity. **Phase 5 is the
first capability on the roadmap that nothing else on the market can answer.**
