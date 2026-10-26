# Importing a video: two lanes

What shipped from the import-speed investigation (options 1, 2 and 4 of its ranked list; the report itself is `docs/import-speed-investigation.md` where it has been committed). Numbers are from an M1 Pro, the scratch-profile app, and 5-minute cuts of the real podcast footage.

## What changed for the user

- **The transcript starts at once.** Audio is pulled from the *original* file (mono, 16 kHz, 48 kbps, about 10 s for a 91-minute file) and goes straight to the transcript. It no longer waits for the 480p proxy.
- **The clip can be placed and watched the moment it is read.** The monitor plays the original until a proxy exists.
- **The Media panel says what is ready**: "Ready to edit", "Transcript in progress" / "Transcript ready", "Proxy 40%", "Colours not final".
- **The AI unlocks when the transcript is ready**, not when the whole import ends. Chat has an opt-in "Start without waiting for the transcript". An agent's `wait {for: "media"}` returns at the same point (`until: "everything"` also waits for the proxy).
- **A faster proxy** (hardware decode for every source, GPU scaling, two proxies at once).
- Export is unchanged: full quality still reads the originals.

## The lanes

```
words    audio (original → lean mp3) → transcript → pieces
picture  proxy → filmstrip → scenes ──┐
                                      ├─ wait for the words lane → pieces from scenes if none → thumbnails
```

They meet at the **pieces**. A piece comes from the transcript (words lane) or, for footage with no speech, from scene detection (picture lane). So the picture lane waits for the words lane before it derives pieces or cuts thumbnails: scenes can never make pieces ahead of a transcript that is still coming, and thumbnails wait for both a source of frames (the proxy) and the pieces.

Code: `src/main/editor/preprocess.ts` (`runLane`, `preprocessMediaAsset`).

### State

- `MediaAsset.prepLanes = { words?, picture? }`, each `{ state: running | completed | error, error? }`.
- `preprocessState` stays as the **summary**, written in the same patch as the lane (`summarizeLanes`): `running` while any lane runs; `error` only once nothing runs; else `completed`. Everything that read it before (clip tray, inspector, MCP) still works.
- A failure in one lane never hides or stops the other. A failed proxy leaves the transcript running; the asset says `error` only when both have ended, and the row shows which lane failed with its own Retry.
- **Interrupted** is per lane: a lane stored as `running` with nothing live is interrupted (`laneStatus`). The panel shows "Resume" on that lane only (`retryAsset(id, undefined, lane)`).
- Media imported before the lanes existed has no `prepLanes`: its one state stands for both (`laneRecord`).
- Named chains (Transcribe, Describe, re-detect scenes, repair) occupy the lane their steps belong to (`laneOfSteps`), so "Transcribe again" works while the proxy is still being made.
- Sound (audio-only files) keeps its single chain.

### Concurrency

One pool of 3 heavy ffmpeg slots (`MAX_CONCURRENT_HEAVY`) is shared by both lanes of every asset (`src/main/concurrency.ts`). Proxies may take at most 2 of the 3 (a third adds nothing on the video chip), so a quick job (the audio, which goes to the front of the line) is never stuck behind another file's proxy. Software proxies are capped at one at a time.

## The proxy (option 4)

`src/main/ffmpeg/proxyArgs.ts` plans it; `toLowResolution` runs it, trying the fastest way first and falling back one step at a time: **GPU** (VideoToolbox decode + `scale_vt`, `-r 30` for 60 fps) → **hardware decode, CPU scale** → **software**.

- Hardware decode is now used for sources above 30 fps too. The old comment saying it was slower there was wrong at 4K (60 fps 4K: 39.7 s → 14.1 s per 40 s of video).
- **`scale_vt` colours** (same frame, mean R/G/B at three times each): iPhone HLG 160/147/124 with CPU scaling and 160/147/124 with `scale_vt`; DJI 135/128/122 against 134/128/122. Differences are at most 1 level and the colour tags are copied through, so the GPU scaler is used.
- **`scale_vt` ignores a rotation tag.** A phone clip held upright came out 854×480 (sideways) instead of 270×480. A rotated source therefore keeps CPU scaling with hardware decode (`proxyModes`); a test covers it.

## Which files play without a proxy

`playsNatively` (`src/shared/mediaPrep.ts`) is a fixed rule so main, the renderer and the tests agree: H.264 and (on a Mac) HEVC in mp4/mov/m4v, VP9/VP8 in WebM, and not 4:2:2 or 4:4:4. ProRes, MPEG-4 part 2, VVC, AV1 and other containers are "needs the proxy": the clip can still be placed, the panel says "preview needs the proxy", and the monitor says so. It is a rule, not a live `navigator.mediaCapabilities` probe; a probe would be more exact on Windows and Linux (not tested there).

## The HDR policy (one function, easy to change)

Measured earlier: an iPhone HLG clip looks more orange from the original than in the export; only the tagged proxy matches. `hdrOriginalNeedsProxy(metadata)` in `src/shared/mediaPrep.ts` is the whole policy. While it is `true` and no proxy exists, the clip can be placed and played, the row and the monitor say "Colours not final", and the clip's proxy goes to the front of the proxy queue. The monitor shows the HDR original as-is until then. Changing the answer to `false` switches the note and the queue priority off. The three options Navid has not chosen between: (a) original as is and swap later, (b) this, (c) tone-map HDR in the export.

## Measured

Reproduction: `electron out/main/index.js --user-data-dir=<dir> --remote-debugging-port=9555`, import through `api.addMediaAsset` over CDP, read the `background-task-update` timestamps.

5-minute stream-copy cuts, one import at a time, same machine, old build (commit before this work) against new, seconds after the import call:

| | Old: transcript starts | New: audio starts / transcript starts | Old proxy | New proxy | Old: all done | New: all done |
|---|---|---|---|---|---|---|
| iPhone 4K30 HLG | 64.6 | 0 / 1.3 | 59.0 | 44.3 (-25 %) | 68.0 | 49.7 |
| DJI 4K30 | 70.0 | 0 / 0.7 | 64.2 | 44.5 (-31 %) | 73.9 | 52.1 |

With a real Gemini key on the iPhone cut: audio ready at 1.3 s, the transcript call ran 1.3 s to 24.5 s (114 pieces) while the proxy was still at 50 %, the proxy finished at 47.9 s and the import at 57.8 s. The lean audio file is 1.8 MB for the 5 minutes; the transcript's own timing check found no drift against the pauses (median onset offset 0.1 s). The old and the new transcript steps were not compared for text quality: the new audio is mono 16 kHz from the original, the old one stereo 48 kHz from the proxy, and one clip does not settle that.

Scaled to the 91-minute iPhone file (estimate, from the 5-minute ratios and the report's full-length proxy of 19.0 min): the transcript starts about 10 s after the import instead of about 21 minutes, and the proxy takes about 14 minutes instead of 19.

Not measured: a 4K 60 fps source in the app (Navid's file lives on Google Drive; the `-r 30` GPU path is covered by a real-ffmpeg test on a generated 720p60 clip), several files importing at once, full-length files, a window of the app being used while it imports.
