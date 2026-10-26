# Import speed investigation

Research only (2026-10-26). No source file was changed; nothing is committed. Every number below was measured on this machine unless it says "estimate" or "not measured". Scratch files, scripts and logs are in the session scratchpad, not in the repo.

## Short answer

- The whole wait before the transcript starts is **one step: the 480p proxy**. On the 91-minute iPhone file it took **19.0 min** (measured, full length). The audio the transcript needs takes **10.5 s** to pull from the same file. Nothing about the transcript needs the proxy.
- **The original plays fine without a proxy** in the app's own Chromium (Electron 44 / Chrome 152): the full 22 GB iPhone file and the 17 GB DJI file played 4K at 30 fps, 0 dropped frames, hardware decoded, seeks about 50 ms. Four 4K files at once also held 30 fps. The editor already falls back to the original (`proxyPath || originalPath`) while there is no proxy, so you can drag and watch a clip today; what is missing is the app *saying so* and the later steps not waiting.
- One real catch: **iPhone HDR (HLG) looks more orange from the original** than the export will (one-frame sample: green -17, blue -23 levels). The proxy tagging in `proxyTags.ts` fixes that for proxies only. DJI footage matched.
- The proxy itself can be made about 25-35 % faster for 30 fps footage and **2.8x faster for 60 fps** footage (the shipped 60 fps path decodes 4K in software, 1x real time; hardware decoding is 2-3x quicker here). Contrary to the code comment in `toLowResolution`.
- A keyframe-only "storyboard" picture of the whole 91-minute file takes **50 s** instead of 19 min. It is enough for the filmstrip, thumbnails and frame sheets.
- Per-camera transcripts at import: on the podcast set that is about **183 minutes of audio transcribed, 91 used** (if the iPhone is the main sound).

## Machine and method

| | |
|---|---|
| Machine | MacBook Pro 16 GB, **Apple M1 Pro** (MacBookPro18,1), 10 cores (8P+2E), macOS 27.0 (26A428) |
| ffmpeg | the bundled `vendor/ffmpeg/ffmpeg` 9.0.1; hwaccel `videotoolbox`; encoders `h264_videotoolbox`, `hevc_videotoolbox`, `prores_videotoolbox`; also libx264/libx265 |
| Chromium | Electron 44.0.0 (Chrome 152.0.7977.54), run as a standalone scratch app with the same range-serving as `media-protocol.ts` (not the FrameFlow window itself) |
| Disk | internal SSD, 3 GB read in 0.63 s (about 5 GB/s). Reading is never the limit. |
| iPhone | `IMG_4913.MOV`: 91:16, 22.5 GB, 4K 30 fps HEVC Main10 **HLG** (BT.2020), 32 Mbps; audio AAC stereo plus an Apple APAC 4-channel track; keyframe every 0.93 s |
| DJI | `DJI_..._0022_D.MP4` 43:25, 17.2 GB (also `_0023_D` 17.2 GB, `_0024_D` 5:21 2.1 GB): 4K 29.97 fps HEVC Main10 BT.709, 50 Mbps, AAC stereo; keyframe every 1.0 s |
| Navid's live DJI file | 12:52, 8.8 GB, **4K 59.94 fps**, about 100 Mbps, on Google Drive (read-only, only 40 s was copied for the 60 fps test) |
| Method | 5-minute stream-copy cuts (iPhone from 30:00, DJI from 10:00) for the matrix; one full-length run for the proxy; each trial run on its own |

Honest caveats on the measurements:

- Navid's own FrameFlow was running a proxy encode (his 4K60 DJI file) when I started. My first runs (71 s and 78 s per 5 min) were slowed by it and are **discarded**. I waited for it to finish and reran everything; the numbers below are from a quiet machine, except that `mediaanalysisd` (macOS) used about one core throughout.
- 5-minute results scale to long files only roughly: the full 91-minute proxy ran at 4.8x real time, the 5-minute cut at 5.2x.

## 1. The pipeline today

Entry: the Media panel / MCP `import_media` call `importMediaFromFile` (`src/main/editor/importMedia.ts`), which creates the asset (`assets.ts` `createMediaAsset`: one ffprobe, the file is referenced in place, **no copy**) and fires `preprocessMediaAsset` (`src/main/editor/preprocess.ts`). One chain per asset; chains of different assets run side by side.

The default chain, strictly one step after another (`DEFAULT_STEPS`, preprocess.ts:46):

| # | Step | Reads | What it does | Code |
|---|---|---|---|---|
| 0 | probe | original | ffprobe: duration, size, codec, fps, hasAudio | `assets.ts:119`, `ffmpeg/index.ts:126` |
| 1 | **proxy** | **original (full decode)** | 480p H.264 2 Mbps with audio. Skipped if the file is already <= 480p. Mac: VideoToolbox decode + encode, **but software decode when the source is above 30 fps** (the `fps=30` filter path) | `preprocess.ts:248`, `ffmpeg/index.ts:207` |
| 2 | filmstrip | proxy | 120 px frames, one per `max(1 s, duration/300)` | `preprocess.ts:972`, `ffmpeg/index.ts:584` |
| 3 | audio | **proxy** | `toAudio`: mp3, no resampling, so 128 kbps stereo 48 kHz | `extraction.ts:25`, `ffmpeg/index.ts:309` |
| 4 | transcript | the mp3 | loudness pass to find pauses (16 kHz mono), windows of about 20 min (25 max) for the word model, **cut and sent one at a time**, then pieces are derived from the text | `preprocess.ts:772`, `gemini/utils.ts:170-293` |
| 5 | scenes | proxy | `scdet` over the whole proxy; pieces only if there is no transcript | `preprocess.ts:284`, `scenedetect/index.ts` |
| 6 | thumbnails | proxy | one ffmpeg process per piece (midpoint frame) | `preprocess.ts:561` |

Concurrency: a global cap of 3 "heavy" ffmpeg jobs (`MAX_CONCURRENT_HEAVY`, preprocess.ts:64) shared by all assets and all steps. The transcript step takes no slot.

Other readers of the media, outside the chain:

- Multicam sync: `decodeMono` of each **original** to mono 8 kHz (`sync.ts:26`); speakers (`diarize.ts:64`) decode each original again.
- Waveform and loudness (`audioAnalysis.ts`): two more ffmpeg passes over the original, on demand.
- `find-silence`, `mediaSheet` (frame sheets for agents), `get_angles` (`contactSheet`, one ffmpeg per frame): proxy if there is one, otherwise the original.
- Preview (monitor), `AngleStrip`, the audio of a camera used as main sound: `proxyPath || originalPath`. Export at full quality always reads the original; export at "preview" quality reads the proxy.

What the user sees: the file row appears at once (the probe is 0.1-0.2 s) with per-step bars (`AssetRow.vue:52`). It is draggable as soon as it has a duration (`canPlace`). **The clip tray stays empty, the AI chat input stays off (`hasReadyMedia`, editorStore.ts:1136) and MCP agents wait, until the whole chain ends** and the file has pieces. The "PAUSED / Processing was interrupted / RESUME" state is `prepStatus`: the stored state is "running" but no live chain; **nothing resumes at launch** and a proxy that was interrupted restarts from zero (`runProxyStep` only skips when `proxyPath` was saved, which happens after the encode ends).

### Timeline for the 91-minute iPhone file (measured stage times, one file alone)

| Time | What happens today |
|---|---|
| 0:00 | row appears; original already plays in the monitor |
| 0:00 - 19:00 | proxy (measured 1137 s). Filmstrip, audio, transcript, scenes, thumbnails all wait. |
| 19:00 - 19:50 | filmstrip from the proxy (about 50 s; 2.8 s per 5 min of proxy) |
| 19:50 - 20:45 | audio from the proxy (about 55 s; 3.1 s per 5 min) |
| 20:45 + | **transcript starts**: loudness pass about 9 s, then 5 windows one after another. Calls not measurable (see the end). Progress bar sits at 10 % the whole time (see section 4). |
| after it | scenes about 50 s, thumbnails about 0.11 s per piece, chain `completed`, AI chat and agents unlock |

The transcript starts 20.8 minutes after import for a 91-minute file. It could start 20 seconds after import.

## 2. Measured cost of each stage

5-minute cuts (300 s), serial, quiet machine. "x RT" = how many times faster than real time.

### Proxy

| Trial | iPhone 4K30 HLG | DJI 4K30 | |
|---|---|---|---|
| **App command** (VT decode, scale on CPU, h264_videotoolbox 2 Mbps) | **57.2 s** (5.2x) | **62.5 s** (4.8x) | full iPhone file: **1137 s = 19.0 min (4.8x)** |
| Hardware decode only (no encode) | 54.6 s | 56.5 s | the decoder is the limit; encode and scale cost 3-6 s |
| Software decode only | 95.7 s (3.1x) | **222.4 s (1.35x)** | |
| App command with software decode | 96.2 s | | |
| GPU scale (`scale_vt`) + h264_videotoolbox | 43.9 s | 43.8 s | -23 % / -30 % |
| GPU scale + 2 concurrent halves | 38.6 s | | -33 % |
| GPU scale + 3 concurrent thirds | 38.6 s | | -33 % (no more than 2) |
| CPU scale, 2 concurrent hardware halves | 40.7 s | | -29 % |
| CPU scale, 4 concurrent hardware quarters | 42.1 s | | -26 % |
| Hardware half + software half | 51.4 s | | little gain, burns all cores |
| 360p, fast_bilinear scale, no audio, no `-realtime` | 56-60 s | | no change, so resolution and flags do not matter |
| **Keyframe-only storyboard** (`-skip_frame nokey`, HW decode, 480p, no audio) | **3.3 s** | | full iPhone file: **50.0 s**; full DJI 43 min: **33.8 s** |

Proxy files: about 80 MB per 5 min (2 Mbps); the full iPhone proxy is 1.46 GB. The storyboard for the full iPhone file came out 684 MB at the encoder's default quality, which can be made much smaller (not tuned).

The 4K 59.94 fps, 100 Mbps case (Navid's real file, 40 s slice):

| | time for 40 s of video |
|---|---|
| As shipped (software decode + `fps=30,scale`) | **39.7 s (1.0x)**. His live run: 772 s of video took about 11.8 min (1.09x). |
| Hardware decode + `fps=30,scale` on CPU | 17.9 s (2.2x faster than shipped) |
| Hardware decode + `scale_vt` + `-r 30` | **14.1 s (2.8x faster)** |
| Decode only: hardware / software | 16.7 s / 40.0 s |

The code comment at `ffmpeg/index.ts:230-235` says hardware decode is slower once frames are dropped. On this machine at 4K it is much faster. The comment's benchmark was probably smaller footage.

Estimate for the podcast set at today's speed (proxy only, 30 fps files, each at 4.8x): iPhone 19.0 min (measured), two DJI files about 9 min each, the short one about 1 min: **about 38 min of work, about 28 min wall** with three at a time (four hardware jobs at once ran 1.35x faster than one in my test; a three-file full-length run was not done).

### The other stages

| Stage (300 s of footage) | Today's way | Alternative |
|---|---|---|
| Audio, pulled from the **proxy** as 128 kbps stereo mp3 | 3.1 s (about 56 s per 91 min) | |
| Audio from the **original**, 48 kbps mono 16 kHz mp3 | | **0.6-0.7 s**; full iPhone 91 min: **10.5 s** (cold); full DJI 43 min: 10.1 s. 33 MB instead of 88 MB. |
| Audio wav 16 kHz mono / opus 24 kbps | | 0.4 s / 2.2 s |
| Sync decode (mono 8 kHz float, original) | 0.5 s per 5 min | full iPhone 5.8 s, full DJI 2.7 s |
| Filmstrip, 300 frames, from proxy | **2.8 s** | |
| ... same from the original, software / hardware / keyframes only | | 87.1 s / 54.7 s / 17.5 s |
| Filmstrip of the *full* iPhone file by seeking the original (300 frames, 120 px, 18 s apart) | | 4 processes at once 103.7 s; one at a time about 182 s (24.3 s for 40 frames) |
| Scene detect (`scdet`) on proxy / on original | **2.7 s** / 83.4 s | |
| One frame (`-ss` before `-i`), 12 frames | proxy 1.3 s (0.11 s each) | original: software 6.2 s (0.5 s each), hardware 3.9 s |
| One frame from the **full** originals at deep offsets | | iPhone 0.5-0.8 s, DJI 4K30 1.3 s |
| Proxy + audio + filmstrip in **one** decode | | 63.6 s vs 60.6 s separate: **no gain**, because the extras read the small proxy, not the 4K file |

### Passes over the 4K original today

Video: **one** full decode (the proxy), as it should be. The other stages read the small proxy. A retry after an interruption pays the full decode again. Audio-only passes over the original (sync, speakers, waveform, loudness): about five of them, 3-10 s each per hour of footage; all together under a minute. Sharing one audio extract between them would save well under a minute, so it is not worth a change by itself (it would be a by-product of "audio first").

## 3. Navid's ideas

### 1. Audio first, transcript in parallel with the proxy: works

- The transcript code takes **a file path to an mp3** (`transcribeOne` / `runWordWindow`, `adapter.uploadFile(file, 'audio/mpeg')`), re-cuts it into windows with `extractAudioSegment` and does not look at video. It never needs the proxy. The only reason the audio comes from the proxy is the step order; `convertToAudio` simply uses `lowResVideoPath || videoPath`, which is the original if no proxy exists yet.
- Cost: 10.5 s for the 91-minute file (10 s for the 43-minute DJI file).
- Saving: the whole proxy time before the transcript can even start: **19 min** on the iPhone file, about 9 min per DJI file.
- Also free: audio taken from the original matches what the sync and speaker finder use (`sync.ts` says it avoids the proxy because the proxy's encode can shift sound), so transcript times and sync times are on the same clock.
- Smaller upload: Gemini downsamples audio to 16 kbps and merges channels to mono (published doc: ai.google.dev/gemini-api/docs/audio), so the 128 kbps stereo 48 kHz mp3 is mostly wasted bytes. 48 kbps mono 16 kHz was 33 MB for 91 min (today 88 MB).
- What it needs in the code: two lanes in `preprocessMediaAsset` instead of one list. Lane A: audio, transcript, pieces. Lane B: picture steps. Thumbnails must wait for **both** a source of frames and the pieces. The single `preprocessState` flag, "interrupted" detection and the "completed" gate on the AI need a decision (section 7).
- Risks: low. Pieces appear before their thumbnails (tiles need a placeholder for a while). Two chains patching one asset is fine (`patchAsset` takes an updater function).

### 2. Use the full-quality video without a proxy: works for these files, with one exception

Measured in Electron 44 on the real files (hidden window, `media://`-style range serving, 12 random seeks each, 8 s of playback):

| File | Hardware decode | Start | Playback | Seek to frame |
|---|---|---|---|---|
| Full iPhone 91 min, 22.5 GB | yes | metadata 116 ms, first frame 330 ms | 30.0 fps, 0 dropped | median 53 ms, max 73 ms |
| Full DJI 43 min, 17.2 GB | yes | 45 ms / 136 ms | 30.0 fps, 0 dropped | median 49 ms, max 70 ms |
| Four 4K files (iPhone + 3 DJI) playing at once | yes | | 300 frames in 10 s each, 0 dropped | |
| Dragging the playhead (30 seeks, 100 ms apart) | | | 30 of 30 frames painted | |
| 480p proxy, for comparison | yes | 11 ms | same | about 15 ms |

Both cameras write a keyframe every 1 s, which is why seeking the big files is as fast as the proxy.

Deciding which files can skip the proxy by probing: `navigator.mediaCapabilities.decodingInfo` separates them correctly in this Chromium.

| Codec | supported | smooth | hardware |
|---|---|---|---|
| HEVC Main10 4K30, 4K60 100 Mbps, even 8K30 | yes | yes | yes |
| H.264 4K30, 1080p60 | yes | yes | yes |
| VP9 4K | yes | yes | yes |
| AV1 4K | yes | yes | **no (software)** |
| ProRes 422 HQ, MPEG-4 part 2, VVC | **no** | no | no |

So the rule can be "supported and smooth and hardware, then no proxy"; anything else keeps one. A fixed list (h264/hevc in mp4/mov on a Mac) is simpler and gives the same answer for the camera files here. Windows or Linux without HEVC support would fall into "needs a proxy" automatically if the probe is used. Not tested on those systems.

Risks and what is **not** fine:

- **HDR colour.** One frame at 0:100: from the original in Chromium the iPhone frame averages R160 G131 B101; the same frame decoded the way the export does it (plain ffmpeg to RGB) is R161 G148 B124. An untagged 480p proxy in Chromium shows the same orange as the original (R161 G130 B101); only the tagged proxy (`proxyTags.ts`) matches the export. DJI SDR: R122 G119 B111 against R121 G118 B111, no difference. So iPhone HDR from the original would look different from what exports (single-frame sample, not a full colour study).
- Export at "preview" quality and agent frame sheets use the proxy when there is one; without one they use the original. Frame sheets are fine (0.5-1.3 s per frame). Preview-quality export of 4K originals was not measured.
- Real editing compositions (effects, motion layers, several tracks over multicam) were not tested, only plain playback.
- 4K playback is hardware decode on this Mac; a software-decode case (AV1) would be slow, which is what the probe is for.

### 3. Other optimizations (measured)

- **Hardware decode for all sources, GPU scaling** (`scale_vt`): iPhone 57 to 44 s (-23 %); 60 fps 4K 39.7 to 14.1 s (2.8x). With two jobs at once 38.6 s (-33 %). Cheap change in one function (`toLowResolution`), and the existing "retry with software decode" fallback stays. The colour output of `scale_vt` was not compared against the CPU scaler and must be render-checked.
- **A storyboard instead of a proxy for the analysis steps**: 50 s for the whole 91-minute file. Frames are ~1 s apart (the keyframes), so a thumbnail for a piece could be up to half a second from the midpoint, and scene detection would run at about 1 fps. A frame-by-frame proxy (playable, 480p) can still be built later, in the background, or never. A storyboard is not playable as video; the original is what plays.
- **Filmstrip without a proxy**: for the long files the strip is only 300 frames, so seeking the original takes 1.7-3 min; from a storyboard about the same 50 s it took to build.
- **Skip stages the user has not asked for**: scene detection runs even when a transcript already made the pieces (it only matters with no transcript, or on a sensitivity re-run); it costs about 50 s per hour from a proxy and is 30 times that from the original. Thumbnails run once per piece (a podcast transcript can make a thousand pieces; about 2 minutes from a proxy, 8+ from the original).
- **Chunked proxy**: possible (a fragmented MP4 cut to its first 40 % of bytes loaded and played in Chromium, duration 120 s of 300), which means a growing file could be played as it is written, but I did not test a live-growing file. Not recommended as the first step: if the original plays, nobody needs to wait for the proxy.

## 4. The big-file problems seen so far

| Problem | Cause found | Fixed by |
|---|---|---|
| Transcript "running" with no percent for 30+ min | Windows run **one at a time**; the status text is "Transcribing part 2 of 5" and `progressFromStatus` (preprocess.ts:138) only reads "N%" or "a / b", so the bar stays at the 10 % set at the start. The transcript call time itself I could not measure. | Report `done/total` windows (small); run 2-3 windows at once (savings unmeasured, depends on Gemini's rate limits) |
| Transcript starts late | Waits for proxy, filmstrip, audio-from-proxy | Audio first, two lanes |
| Proxy interrupted, shows PAUSED / RESUME, restarts from zero | The proxy only counts when the encode ends; nothing resumes at launch | Make the proxy optional/background (the damage is smaller); or segment files that resume; or resume at launch |
| Thumbnails / filmstrips "seek the 4K originals slowly" | Only if they run before the proxy: 0.5-1.3 s per frame, up to 8+ min for a thousand pieces, 3 min for the filmstrip | Keep them behind a picture source (proxy or storyboard) |
| `get_angles` about 100 s per 8 frames | **Not reproduced.** Eight frames from the full DJI take 9.5 s idle, 16.0 s with three software-decode proxies running (1.7x slower), and 13.6 s with three hardware proxies (1.4x). Frames from the Google Drive copy of the 4K60 file took 0.6-0.9 s each (it is cached locally now). The remaining suspects are a cold Google Drive file (cloud streaming on first read), or the live app's main process being busy; neither measured. | Not explained by CPU contention alone; an earlier stage order would only help if the cause is the proxies |
| Machine slow while importing | A software-decode proxy uses all 10 cores (load average reached 15-28 in my parallel tests); three can run at once | Hardware decode for all sources; cap software jobs at one |

## 5. Options, ranked

Saving is for the 91-minute iPhone file unless noted. Effort: S = hours, M = a day or two, L = more.

| # | Option | Saving | Effort | Risk |
|---|---|---|---|---|
| 1 | **Audio first + two lanes** (audio and transcript at import, pictures in parallel) | transcript starts at 0:20 not 20:45 (-20 min); the same on every file | M | low-medium: state model (`preprocessState`, interrupted, retry), thumbnails need frames and pieces |
| 2 | **Usable at once**: say "ready to edit" as soon as the probe works and the codec plays; unlock the AI and agents when the transcript is ready, not when the whole chain ends | the clip is usable at 0:00 and the AI from the transcript's end, not from about 25+ min | S-M | medium for iPhone HDR colour (see questions); codec support must be probed |
| 3 | **Storyboard as the picture source for analysis** (filmstrip, thumbnails, frame sheets), full proxy optional/background | 50 s instead of 19 min for everything that needs frames | M | low-medium: thumbnails within +/-0.5 s, scene detection coarser, preview-quality export falls back to originals (unmeasured) |
| 4 | **Faster proxy**: hardware decode for 60 fps sources, `scale_vt`, two jobs at once | iPhone proxy 19 min to about 13 min (estimate from the 5-min result); 4K60 sources 2.8x | S | low-medium: colour of `scale_vt`, VideoToolbox quirks (a software fallback exists) |
| 5 | **Transcript**: real progress, 2-3 windows in parallel, lean mono audio for upload | up to 2-3x on the call part (unmeasured); upload 88 to 33 MB | S | low: rate limits (already retried), word-model window limit stays 30 min |
| 6 | **Multicam: transcribe only the main sound** (or on request) | podcast set: 183 to 91 minutes of audio transcribed, about half the calls | S | low; product choice (see questions) |
| 7 | Cap and prioritise heavy jobs (one software decode at a time, lower priority, frames for the user first) | smoother app while importing; frame grabs under load were about 1.7x slower, not the 12x seen | S | low |
| 8 | Resumable / chunked proxy, resume unfinished preparation at launch | no loss after an interruption | M-L | medium; matters less once the proxy is off the critical path |
| 9 | One shared audio extract for sync, waveform, speakers, transcript | under a minute | M | low; by-product of option 1 |

### Recommended order

1. **Options 1 + 2 together.** This is the change you feel: start the transcript at once and let the clip be used at once.
2. **Option 4** in the same week: it is one function and also helps the part that remains (the proxy that still gets built).
3. **Option 6** and **5** (the transcript side), with real progress first.
4. **Option 3** after you answer the proxy question below; it is what lets you stop building 19-minute proxies by default.
5. Options 7-9 later.

Estimated result for the iPhone file, with 1, 2, 4: transcript starts about 20 s after import, clip usable at once, background proxy about 13 min. With 3 as well: pictures (filmstrip, thumbnails) available after about a minute and no multi-minute proxy by default.

## 6. What I could not measure

- **The Gemini calls** (upload time, call time per window, rate limits, parallel windows): no API calls were made. With a call allowed I would time: upload of the 33 MB and 88 MB files, one 20-minute window at 1, 2 and 3 at once, and total transcript time for the 91-minute file.
- **FrameFlow itself end to end**: I did not start my own app instance; the playback tests used a standalone Electron 44 with the same range serving. The real monitor, compositions, effects and several tracks over multicam were not tested.
- Three full-length proxies at once; the effect of `nice`/thread limits on UI responsiveness; thermal throttling over a long run.
- `scale_vt` colour against the CPU scaler; HDR sources through the GPU path.
- The cause of the 100 s `get_angles` case (see section 4).
- Preview-quality export from originals; a growing (still being written) proxy file; non-Mac systems; footage other than these cameras (ProRes, 10-bit 4:2:2, variable frame rate phones).
- `-skip_frame nonref` with hardware decode was rejected by ffmpeg (not pursued).

## 7. Open questions for Navid

1. **iPhone HDR look.** From the original, iPhone HDR clips look more orange in the monitor than in the export. Which do you want? (a) Show the original as is and swap to a proxy when it is ready; (b) always build a background proxy for HDR clips only and show "colours not final" until then; (c) change the export to tone-map HDR so the monitor and export agree.
2. **What does "ready" mean?** (a) Can place and watch the clip; (b) transcript is readable; (c) the AI and agents can start. Today (c) is the only one that is announced, and it waits for the end. Should each get its own status in the Media panel?
3. **Transcripts for several cameras.** At import: (a) transcribe every file as now, (b) only the first/longest file, (c) none until you press Transcribe or make the group (then the main sound's only).
4. **The 480p proxy.** (a) Keep building it for every file, in the background, at lower priority; (b) only for files that cannot play (and HDR if you pick 1b); (c) never by default, and a quick storyboard for filmstrip and thumbnails.
5. **Scene detection.** Keep running it even when a transcript already made the pieces, or only when there is no speech?
6. **Interrupted preparation.** Resume automatically when the app starts, or keep the manual RESUME button?
7. **Machine use while importing.** Finish as fast as possible (the app may feel slow), or keep the editor smooth (slower import)?
8. **Windows / Intel.** Does import speed matter off Apple Silicon? The hardware-decode and GPU-scaling work in this report is Mac-only.

## Appendix: how to reproduce

Proxy as the app builds it: `ffmpeg -hwaccel videotoolbox -i IN -vf scale=-2:480 -c:v h264_videotoolbox -b:v 2M -realtime true -threads 0 OUT.mov`.
GPU path: `ffmpeg -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i IN -vf scale_vt=w=854:h=480 -c:v h264_videotoolbox -b:v 2M -realtime true OUT.mov` (add `-r 30` for 60 fps sources).
Storyboard: `ffmpeg -skip_frame nokey -hwaccel videotoolbox -i IN -an -vf scale=-2:480 -c:v h264_videotoolbox -b:v 1M OUT.mov`.
Lean audio: `ffmpeg -i IN -vn -map 0:a:0 -ac 1 -ar 16000 -b:a 48k OUT.mp3`.
5-minute cut: `ffmpeg -ss 1800 -i IN -t 300 -map 0:v:0 -map 0:a:0 -c copy OUT`.
Playback test: a throwaway Electron 44 main script that registers a `media`-like protocol with byte ranges, plays each file in a `<video>` for 8 s, does 12 random seeks and a 30-seek scrub, and reads `getVideoPlaybackQuality()` and `mediaCapabilities.decodingInfo()`.
