/**
 * How to use sound well, written for an agent that cannot hear.
 *
 * The motion guide taught the lesson that prose alone changes an agent's
 * process but not its taste: what helps is something concrete to copy. So this
 * is built from the palette itself (every sound, its length, its level, what it
 * is for) and from numbers the mix can check (`analyze_audio`), not from
 * adjectives.
 */
import { MASTER_LUFS, TRACK_ROLES } from './audio'
import { SOUND_GROUPS, SOUND_PRESETS, soundLength, type SoundPreset } from './synth'

const row = (p: SoundPreset): string => {
	const len = p.follows ? 'as long as it is asked' : `${soundLength({ kind: p.kind }).toFixed(2)} s`
	const takes = p.variants > 1 ? `, ${p.variants} takes (variant 0-${p.variants - 1})` : ''
	return `- ${p.kind}: ${p.description} ${len}, peak ${p.level} dB, starts ${Math.round(p.lead * 1000)} ms early${takes}.`
}

export function soundGuideText(): string {
	const groups = SOUND_GROUPS.map((g) => `${g}\n${SOUND_PRESETS.filter((p) => p.group === g).map(row).join('\n')}`).join('\n\n')
	const roles = TRACK_ROLES.map((r) => `- ${r.id}: ${r.description}${r.offsetLU ? ` About ${Math.abs(r.offsetLU)} LU under the voice.` : ''}`).join('\n')
	return `SOUND GUIDE

You cannot hear, so read numbers: render_sound gives a sound's length, peak and loudness and a spectrogram picture; analyze_audio gives how each role sits in the mix. Use them, and keep to the rules below.

WHAT THE SYNTH IS
Every sound is a recipe (a sound, a take, a pitch, a level, an amount of air, a seed) that FrameFlow renders with ffmpeg: offline, free, the same sound on every computer. Nothing is spent and nothing is downloaded. A recipe is not a file you can edit sample by sample: change the numbers and it renders again.

THE PALETTE
${groups}

"peak" is the level the sound is made at, in dB under full scale. "starts early" is how far ahead of the moment the sound begins so its hit lands ON the moment; follow handles it, so you do not subtract it yourself.

ROLES
${roles}
Put sounds on audio tracks with the sfx role (apply_ops addSounds does it for you, on a free lane). Mark a voice track voice and a music bed music with setTrackRoles; a music bed ducks under speech by itself.

LEVELS
- The finished video is normalised to ${MASTER_LUFS} LUFS when Loudness is on, so what matters is how roles sit AGAINST each other.
- Effects about 10 LU under the voice, a music bed about 12 LU under. analyze_audio warns when they are not.
- Peaks stay under −1 dBTP. Raise or lower a recipe's levelDb, or a clip's gain, not both.

KEY
The palette is in A major pentatonic, so every note agrees. Moving pitch moves them all together: use the SAME pitch on every pitched sound (appear, chime, success, resolve, blip, confirm, rise, land) and on the bed, or they will not agree. Pitch never needs to move for effects without a note (click, whoosh, swish, pop).

CHOOSING
- Fewer is better. Sound the moments that matter (a title coming in, a cut to something new, the end), not every one. One sound per moment; never a whoosh AND a swish on the same cut.
- A slide-in is a whoosh; its exit is a pop. A card appearing is an appear. A number building is a rise (durationSec = the build) and a success when it lands. A cut is a swish. The very end is one resolve.
- Do not put a sound on a word being said: keep effects off the stretches where the voice is speaking unless they are the point.
- A bed (ambient) as long as the project, under everything, at its default level. Do not add one if the project already has music.

HOW
1. get_project, get_timeline: see what is there.
2. suggest_cues: the moments on the timeline that want a sound, each with a suggested sound. Skip the ones you do not want.
3. apply_ops with addSounds: one entry per sound, each with follow {item, at} so it lands on its moment and stays there if the clip moves. Use setSounds to change a sound (kind, pitch, levelDb, seed) or its moment; setTrackRoles for roles.
4. render_sound a recipe BEFORE adding it if you are unsure; analyze_audio AFTER, and fix what it warns about. render_frame as usual for the picture.
5. revert_to_version if it is wrong. Every apply_ops is a revision the user can undo.`
}
