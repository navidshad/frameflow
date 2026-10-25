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
- Retiming controls are hidden for group clips.
- Re-sync, a nudge or a new main sound re-derive every clip of the group from the old line to the new one; a clip that would need footage from before a camera started loses that sliver, not the whole clip.

## In the editor

- Media panel: the suggestion card (Sync as multicam / Not now), progress while syncing, one row per group (Add to timeline, Re-sync, Ungroup), and "Group cameras…" to pick files by hand.
- Monitor: the ANGLES toggle shows every angle live under the program picture. Click one, or press **1–9**, to cut at the playhead; **Alt + 1–9** (or Alt-click) changes the whole shot.
- Inspector, on a group clip: the angle tiles, the main-sound picker with each source's measured quality ("voices 37 dB over the room", the clearest marked), and the sync of each member with one-frame nudges.

## For agents

One transcript per group (the main sound's, on the group clock): every camera heard the same conversation. The intended loop: `find_camera_groups` → `make_multicam` → `get_multicam` (transcript, shots) → `get_angles` over a stretch (every angle side by side, who is speaking) → `apply_ops switchAngles`.

## Not yet

- Each camera is still transcribed at import; only the main sound's transcript is used.
- The built-in AI (the chat's own engine) does not have the multicam ops; MCP agents do.
- A camera that really stopped and restarted (a gap of minutes) is one camera with a gap; the gap shows as "not recording". Nothing joins its files into one clip across that gap.
- The main-sound suggestion ranks voices-over-room and clipping; it does not yet listen for which microphone is closest to each speaker.
