# Multicam

Several cameras recording the same moment (a podcast, an interview), synced to one clock so the edit can cut between angles while the sound plays on, unbroken.

## How it works

**Finding the cameras.** On import FrameFlow suggests files that look like one recording: their recording windows overlap (from start times in file names such as `DJI_20260717171155_…`, or the file's own `creation_time`), or they sit in camera-named folders (`Cam01`, `B-cam`) and run about as long. Two files from ONE camera follow each other and never overlap, which is why overlap is the strong signal. A suggestion is only a suggestion: the user (Media panel) or an agent (`make_multicam`) confirms, and the sync proves it.

**Syncing by sound.** `src/main/multicam/` — the standard method (Premiere, Resolve, Final Cut, PluralEyes):

1. Decode each file's ORIGINAL sound to mono 8 kHz (never the proxy: its encode can shift the sound) and band-pass it to the speech band.
2. Coarse: cross-correlate 100 Hz onset envelopes of the WHOLE recordings, so a camera that started minutes late is found as easily as one a second late.
3. Fine: GCC-PHAT on 10 s windows every 15–90 s along the recording, searching ±0.5 s around the coarse answer.
4. Fit a line through the windows' lags, dropping outliers: its height is the offset, its slope the clock drift (ppm).
5. Confidence: strong (≥3 windows agree within 20 ms, at least half of those measured), weak, or failed (falls back to the recording times and says so).

Measured against real ffmpeg (`sync.test.ts`): a planted 1.37 s offset is found within 5 ms, 100 ppm of drift within 5 ppm.

**Cameras made of several files.** Cameras split long recordings (the DJI on the first real shoot cut 91 minutes into three files). Files that share a folder (or, all in one folder, a file-name prefix) and follow one another without overlapping are one CAMERA (`MulticamMember.camera`). Every file is still synced on its own, against the LONGEST file (the reference: it overlaps the most); joins measured within a quarter second are sealed (`sealCameraJoins`), because a few milliseconds of measurement noise would otherwise click in the sound and slip the picture at every join. A file the sound cannot place (its camera kept recording after the reference stopped) continues from its camera's neighbouring file (`method: 'continued'`). Number keys pick cameras, numbered by name (Cam01 = 1); which file plays is decided by time, and a join is not a cut (`shotRun`).

Measured on the real shoot (an iPhone and a DJI in three files, 2.6 h of sound, synced in 36 s): DJI file 1 at −50.183 s against the iPhone, files 2 and 3 meeting it to within 3 and 7 ms, drift +5 to +6 ppm, every file "strong". The cameras' clocks were about 8 minutes apart, so recording-time tags alone would have placed them wrongly.

**The model.** `src/shared/multicam.ts`. A `MulticamGroup` on the document (undoable, in every revision, like motion kits) lists its members (files); each sits on the group clock by `group = offset + source × rate`. On the timeline a group is ORDINARY clips tagged `multicam: { groupId, role }`:

- SHOTS on a video track, one angle each, muted;
- one SOUND clip on an audio track: the main sound.

Their `in`/`out` are plain source seconds worked out from the group's line, so export, preview, transitions and captions need nothing new (the PRD rules out nested sequences). A drifting angle plays at `sound.rate / angle.rate` (e.g. 0.99994×), which keeps a one-hour uncut shot locked to the last frame.

**Edits.** `src/shared/multicamEdits.ts` maps `placeMulticam`, `switchAngles`, `setMainSound` and `nudgeAngle` to a diff. The SAME function serves MCP's `apply_ops` and the editor's controls, so a number-key cut and an agent's cut are the same edit. Rules that keep sync:

- A switch to an angle that was not recording all of a stretch switches the part it recorded; the rest stays on its angle (cameras stop at different times).
- A ripple delete of a shot cuts the same stretch out of the group's sound (`groupRippleCut`), in the editor and over MCP.
- Dragging a group's clip moves the whole group.
- A shot, for number keys, Alt + number and the angle tiles, is what the viewer sees as one shot: pieces of one camera that touch, look the same and carry on from each other on the group's clock (`shotRun`). A file join is not a cut; a punch-in, a reframe or time trimmed out is, so a click changes exactly the clip you chose.
- Switching a clip to another camera drops its transform and framing: a punch-in was made for the camera it framed.
- Retiming controls are hidden for group clips.
- Re-sync, a nudge or a new main sound re-derive every clip of the group from the old line to the new one; a clip that would need footage from before a camera started loses that sliver, not the whole clip.

## In the editor

- Media panel: the suggestion card (Sync as multicam / Not now), progress while syncing, one row per group (Add to timeline, Re-sync, Ungroup), and "Group cameras…" to pick files by hand.
- Monitor: the ANGLES toggle shows every angle live under the program picture. Click one, or press **1–9**, to cut at the playhead; **Alt + 1–9** (or Alt-click) changes the whole shot.
- Inspector, on a group clip: the angle tiles, the main-sound picker with each source's measured quality ("voices 37 dB over the room", the clearest marked), and the sync of each member with one-frame nudges.

## Who speaks when

**Why.** To cut a talk an agent needs a speaker per sentence. "The loudest microphone" cannot give it: in a shared room every microphone hears everyone, and a microphone's level swings with its gain (on the first real shoot the DJI read loudest at 10 of 12 sampled moments, whoever spoke). So the group can be listened to once (Media → the Inspector's **Speakers** → *Find speakers*, or MCP `find_speakers`), and the result lives on the group as `MulticamGroup.speakers`: the voices (`people`: id, name, camera, framing, colour, pitch, talk time) and their `turns` on the group clock (`start`, `end`, `speaker` or `null` = unsure, `confidence`, `fixed`). It is diffed, undoable and in every revision like the rest of the group.

**How.** `src/main/multicam/diarize.ts` (files), `diarizeTracks.ts` and `diarizeMath.ts` (the arithmetic, tested without ffmpeg). Every camera's microphone is measured on the GROUP clock, so a camera in three files or one that started late is one continuous track. Per 50 ms frame:

- **Closeness**: each microphone's level above ITS OWN noise floor (10th percentile of that microphone), the microphones compared at the same instant. This replaces "louder than its own median".
- **Pitch** (autocorrelation, 70–420 Hz) and **timbre** (12 mel-cepstral coefficients, mean-normalised per microphone so each microphone's own colour cancels).
- **Averaged over seconds.** One frame says what is being said; a few seconds of it say who is saying it. Averaging each frame's features over ±3.5 s is the difference between ~74 % (single frames, even trained on the labels) and ~90 % (windows, no labels at all) for two men on one microphone.
- The averaged frames are clustered into N voices (a Gaussian mixture, best of five starts, deterministic), the labels are smoothed over time (a hidden Markov model: staying is cheap, switching costs, and less across a pause), and a second pass adds a short-window model of closeness and pitch only, which pins down where a change of speaker is (the first pass blurs it by seconds).
- Turns shorter than 0.6 s that the model is not sure of are folded into the turn around them; a turn the model is under 60 % sure of is `unsure` (speaker `null`), never a guess. Each turn keeps its confidence.

**The count of people has to be known.** The mixture has no clean elbow (on the real shoot, 3 people, the likelihood keeps improving to 6), so `find_speakers` takes `speakers`; left out it estimates, and says in `warnings` that it is a guess. Too many voices is cheap to undo (`mergeSpeakers`); too few is not (run again).

**Naming.** The sound can tell voices apart; it cannot know whose they are, or which camera they are on (every microphone hears everyone, so "closest microphone" is rarely a clear signal and is only suggested when it is). `get_speakers` returns each voice's best sample moments with one frame per angle, so an agent (or a person) can look and then `setSpeaker {speaker, name, camera, framing}`. A re-run keeps names, cameras, framing and every turn fixed by hand (`setSpeakerTurns`), matching the new voices to the old by pitch.

**What it can and cannot do** (honest limits; numbers below):

- People at DIFFERENT pitches or on different microphones are separated reliably. The woman against the men on the first shoot is the easy case.
- TWO PEOPLE ON ONE CAMERA (the two men side by side in the DJI two-shot) are told apart by voice alone: pitch, timbre and how they sound to the OTHER camera's microphone. It works when the voices differ and degrades toward a guess when they do not. Expect mix-ups in short turns and at the start of a turn; the confidence and `unsure` say where. The analysis warns when two voices share a pitch range and overlap (`sound alike`) and when a "pair" never takes turns (probably one voice that drifted, split in two).
- It cannot tell WHICH man is which: that is a look at a frame, by an agent or a person.
- Overlapping speech and laughter get a confident-looking label for whoever dominates, or `unsure`. Backchannels under about a second are usually folded into the turn.
- It listens; it does not look. Lip movement would tell the two men apart better (and is the obvious next signal), but costs decoding the video.

**Measured on the real shoot** (iPhone + a DJI in three files, 92 min, 3 people, run end to end; rough ground truth from the Gap-time edit session):

| What | Result |
|---|---|
| The woman (iPhone) against the men | **93.5 %** of 2,351 s of labelled speech right. The labels are pitch-derived (`turns.json`: S ≥ 165 Hz), so this is partly the method checking itself; the voices came out at 212 Hz (her), 147 Hz and 128 Hz. |
| Which man (Navid on the right, the guest on the left), labels chosen by eye on frames | **84.6 %** of 803 s right (Navid's voice 506 s right / 95 s wrong; the guest's 174 right / 29 wrong). A per-frame method with the same features, even trained on these labels, reaches 74 %. |
| Where a change of speaker lands (woman ↔ man, 69 changes) | median 1.2 s off; 48 % within 1 s, 59 % within 2 s. Good enough to choose a shot per turn, not to cut on the word: refine a cut with the transcript's words. |
| Left "unsure" | 2.2 % of the talk. Confidence is honest in order: between the two men, turns under 0.9 were right 24 % of the time, under 0.97 54 %, from 0.97 up 88 %; long turns are surer (≥ 20 s 91 %, under 5 s 74 %). |
| Cost | 4 files, 2.6 h of sound: about 20 s of decoding per hour and under 3 s of clustering, run in the main process; the whole thing (sync + speakers) took 68 s. |
| It also noticed | the iPhone's microphone as the woman's (`camera: Cam02`), and warned that the two men "sound alike". |

How to reproduce: `FF_MULTICAM_FOOTAGE=… FF_MULTICAM_FILES=Cam02/IMG_4913.MOV,Cam01/DJI_…_0022_D.MP4,… FF_MULTICAM_SPEAKERS=3 FF_MULTICAM_TRUTH=~/Movies/FrameFlow-podcast-edit/data FF_MULTICAM_REPORT=/tmp/speakers.json npx vitest run src/main/multicam/realFootage.test.ts` (the report goes to the file because the test runner swallows console output). The labels are the Gap-time edit session's rough ground truth, not a labelled corpus.

## For agents

One transcript per group (the main sound's, on the group clock): every camera heard the same conversation. The intended loop: `find_camera_groups` → `make_multicam` → `find_speakers` (once, with the number of people) → `get_speakers` and `apply_ops setSpeaker` to name the voices → `get_multicam` (transcript with a `speaker` on every line, shots; `turns: true` for the turns) → `get_angles` over a stretch (every angle side by side, `speaking` at each moment) → `apply_ops switchAngles`.

## Not yet

- Each camera is still transcribed at import; only the main sound's transcript is used (on the real podcast set: about 183 minutes of audio transcribed for 91 used). Proposal, not built (the product choice is open): a setting "Transcribe when imported: always (today) / only when I ask". With "only when I ask", the transcript step marks the file "not transcribed yet" instead of calling Gemini (its pieces come from scene detection until a transcript arrives, which `mergeTranscriptIntoClips` already handles), and building a camera group (`buildCameraGroup`'s two callers: the `multicam-build` IPC and the MCP bridge) transcribes the main sound's files that have none. It touches settings, a Settings toggle, the transcript step, both group-build callers, the Media row's wording and what `wait {for: "media"}` tells an agent, so it waits for that choice and for the import-lane rework.
- The built-in AI (the chat's own engine) does not have the multicam ops; MCP agents do.
- A camera that really stopped and restarted (a gap of minutes) is one camera with a gap; the gap shows as "not recording". Nothing joins its files into one clip across that gap.
- The main-sound suggestion ranks voices-over-room and clipping; it does not yet use who speaks.
- Speakers are found from sound only. Lip movement in the two-shot would sharpen two people on one camera; and the speaker colour is shown in the Inspector's turn bar but not yet on the monitor's captions.
- Framed angles ("Cam01 · left single" = a camera plus a punch-in) that `switchAngles` could target by speaker are not built: today an agent maps speaker → angle itself.
