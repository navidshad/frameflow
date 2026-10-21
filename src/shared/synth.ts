/**
 * Sound, made from nothing: every effect and the ambient bed are an ffmpeg
 * filter graph, synthesised the same way on every machine. Seeded noise, no
 * downloads, no recordings, nothing to license.
 *
 * The recipes are the palette from the Lumi studio's `synth.mjs` (itself the
 * source of every effect a Lumi video plays), ported as pure functions of a
 * `SoundRecipe`. This file only BUILDS graph text; running it is the main
 * process's job (`main/editor/synth.ts`), so everything here is testable
 * without a binary and usable by the renderer and the MCP tools alike.
 *
 * A recipe is a handful of numbers a person (or an agent) can read and change:
 * which sound, which variant of it, how far to move its pitch, how loud, how
 * much air, and the seed the noise comes from. The same recipe always renders
 * the same samples.
 */

/** Every sound is rendered at 48 kHz. */
export const SR = 48000

export type SoundKind =
	| 'click' | 'key' | 'send' | 'pop' | 'tick' | 'blip' | 'confirm'
	| 'appear' | 'whoosh' | 'swish' | 'flight' | 'rise' | 'land'
	| 'chime' | 'success' | 'resolve'
	| 'bed'

export type SoundGroup = 'UI' | 'Motion' | 'Musical' | 'Ambient'

export interface SoundRecipe {
	kind: SoundKind
	/** Which take of the sound: `key` has five, `appear` two, the rest one. */
	variant?: number
	/** Move the pitch, in semitones. Notes and carriers move; clicks do not. */
	pitch?: number
	/** How loud the sound is: its peak, in dBFS. Defaults to the preset's own level. */
	levelDb?: number
	/** How much airy noise rides on a whoosh-like sound, 0..1. */
	air?: number
	/** Which noise. The same seed is the same sound on every machine. */
	seed?: number
	/** How long, for the sounds that follow a motion (`flight`, `rise`) and the bed. */
	durationSec?: number
}

export interface SoundPreset {
	kind: SoundKind
	label: string
	group: SoundGroup
	description: string
	/** The peak, in dBFS, the sound is made at unless the recipe says otherwise. */
	level: number
	/**
	 * How early the sound should start so its hit lands on the cue, in seconds.
	 * A whoosh swells before it peaks; a click lands at once.
	 */
	lead: number
	variants: number
	/** The length follows what it is for (a motion's length, the project). */
	follows: boolean
	/** Which cue this sound is a good answer to (see shared/sound.ts). */
	for: string
}

export const DEFAULT_AIR = 0.4
export const DEFAULT_FOLLOW_SEC = 0.6

// ---------------------------------------------------------------- graph pieces

type Ctx = { pitch: number; seed: number; airMul: number; variant: number; dur: number; ratio: number }

const ctxOf = (r: SoundRecipe): Ctx => ({
	pitch: r.pitch ?? 0,
	seed: Math.max(0, Math.floor(r.seed ?? 0)),
	airMul: Math.max(0, (r.air ?? DEFAULT_AIR) / DEFAULT_AIR),
	variant: Math.max(0, Math.floor(r.variant ?? 0)),
	dur: Math.max(0.1, r.durationSec ?? DEFAULT_FOLLOW_SEC),
	ratio: 2 ** ((r.pitch ?? 0) / 12)
})

/** An aevalsrc of `expr` (mono, `len` s); quoted, so commas and `;` stay inside it. */
const tone = (expr: string, len: number) => `aevalsrc='${expr}':s=${SR}:d=${len}:c=mono`
/** Seeded noise (deterministic), shaped per sample by `env` (aeval: `t` is the sample's time). */
const noise = (len: number, seed: number, color: string, filters: string, env: string) =>
	`anoisesrc=d=${len}:c=${color}:r=${SR}:a=1:seed=${seed},${filters ? filters + ',' : ''}aeval='val(0)*(${env})':c=same`
/** A quick attack, so no sample starts on a step (a click of its own). */
const atk = (rate: number) => `(1-exp(-t*${rate}))`
/** Mix labelled branches without scaling. */
const sum = (labels: string[], out: string, post = '') =>
	`${labels.map((l) => `[${l}]`).join('')}amix=inputs=${labels.length}:normalize=0${post ? ',' + post : ''}[${out}]`
/** A band of noise around a moving carrier: low-passed noise times a sine at the carrier's phase (cycles). */
const band = (len: number, seed: number, width: number, phase: string, env: string, label: string) =>
	[
		`anoisesrc=d=${len}:c=pink:r=${SR}:a=1:seed=${seed},lowpass=f=${width},lowpass=f=${width}[${label}n]`,
		`${tone(`sin(2*PI*(${phase}))`, len)}[${label}c]`,
		`[${label}n][${label}c]amultiply,aeval='val(0)*(${env})':c=same[${label}]`
	].join(';')
/** Phase (cycles) of an exponential chirp f0 → f1 over `T` s, holding f1 after. */
const chirp = (f0: number, f1: number, T: number) =>
	`${f0}*${T}/log(${f1 / f0})*(pow(${f1 / f0},min(t,${T})/${T})-1)+${f1}*max(t-${T},0)`
/** A mallet note at `f` starting `at` s in: the fundamental, a 3.93× partial (a marimba's), a little 2nd. */
const mallet = (f: number, at: number, decay: number, amp = 1) => {
	const x = `(t-${at})`
	return `${amp}*gte(t,${at})*(1-exp(-${x}*700))*(sin(2*PI*${f}*${x})*exp(-${x}*${decay})+0.22*sin(2*PI*${3.93 * f}*${x})*exp(-${x}*${decay * 3.2})+0.08*sin(2*PI*${2 * f}*${x})*exp(-${x}*${decay * 1.6}))`
}
/** A bell partial set at `f` starting `at` s in. */
const bell = (f: number, at: number, amp = 1) => {
	const x = `(t-${at})`
	return `${amp}*gte(t,${at})*(1-exp(-${x}*900))*(sin(2*PI*${f}*${x})*exp(-${x}*3)+0.3*sin(2*PI*${2 * f}*${x})*exp(-${x}*6.5)+0.12*sin(2*PI*${3 * f}*${x})*exp(-${x}*11)+0.05*sin(2*PI*${4.2 * f}*${x})*exp(-${x}*16))`
}

/** Notes as semitones from A4 (440 Hz), all in A major pentatonic. */
const N = { A4: 0, Cs5: 4, E5: 7, A5: 12, B5: 14, E6: 19, A6: 24, B6: 26 }
const note = (c: Ctx, semi: number) => 440 * 2 ** ((semi + c.pitch) / 12)

// ---------------------------------------------------------------- the palette

interface Voice {
	preset: SoundPreset
	len: (c: Ctx) => number
	graph: (c: Ctx) => string
}

const P = (
	kind: SoundKind, label: string, group: SoundGroup, description: string, level: number, lead: number,
	variants: number, follows: boolean, forCue: string
): SoundPreset => ({ kind, label, group, description, level, lead, variants, follows, for: forCue })

const VOICES: Record<SoundKind, Voice> = {
	click: {
		preset: P('click', 'Click', 'UI', 'A crisp press.', -6, 0.002, 1, false, 'ui'),
		len: () => 0.12,
		graph: (c) => [
			`${tone(`${atk(6000)}*(0.55*sin(2*PI*2000*t)*exp(-t*280)+0.35*sin(2*PI*600*t)*exp(-t*110))+gte(t,0.03)*(1-exp(-(t-0.03)*6000))*0.22*sin(2*PI*2600*(t-0.03))*exp(-(t-0.03)*330)`, 0.12)}[a]`,
			`${noise(0.12, 3 + c.seed, 'white', 'highpass=f=2500', `${atk(8000)}*exp(-t*500)+gte(t,0.03)*0.5*exp(-(t-0.03)*600)`)},volume=0.35[b]`,
			sum(['a', 'b'], 'out', 'highpass=f=120,lowpass=f=9000')
		].join(';')
	},
	key: {
		preset: P('key', 'Key', 'UI', 'A soft keystroke, five takes.', -18, 0.001, 5, false, 'ui'),
		len: () => 0.07,
		graph: (c) => {
			const k = [
				{ body: 360, nc: 3800, seed: 11 },
				{ body: 400, nc: 4300, seed: 12 },
				{ body: 445, nc: 3500, seed: 13 },
				{ body: 490, nc: 4700, seed: 14 },
				{ body: 230, nc: 2200, seed: 15, decay: 90 }
			][Math.min(c.variant, 4)]
			return [
				`${noise(0.07, k.seed + c.seed, 'white', `bandpass=f=${k.nc}:width_type=q:w=0.9`, `${atk(9000)}*exp(-t*420)`)},volume=0.9[n]`,
				`${tone(`${atk(5000)}*0.5*sin(2*PI*${k.body}*t)*exp(-t*${k.decay ?? 140})`, 0.07)}[b]`,
				sum(['n', 'b'], 'out', 'highpass=f=150')
			].join(';')
		}
	},
	send: {
		preset: P('send', 'Send', 'UI', 'A message leaving: a short rising swish.', -10, 0, 1, false, 'ui'),
		len: () => 0.36,
		graph: (c) => {
			const env = 'pow(min(t/0.13,1),2)*exp(-max(t-0.13,0)*22)'
			return [
				band(0.36, 21 + c.seed, 420, chirp(600 * c.ratio, 2400 * c.ratio, 0.24), env, 'w'),
				`${noise(0.36, 22 + c.seed, 'pink', 'highpass=f=4000', `${env}*${0.35 * c.airMul}`)}[air]`,
				sum(['w', 'air'], 'out', 'highpass=f=200,lowpass=f=10000')
			].join(';')
		}
	},
	pop: {
		preset: P('pop', 'Pop', 'UI', 'A bubble: something small arrives.', -7, 0.003, 1, false, 'out'),
		len: () => 0.2,
		graph: (c) => {
			const ph = `(${520 * c.ratio}*t+${360 * c.ratio}*(t-(1-exp(-t*45))/45))`
			return `${tone(`${atk(1500)}*exp(-t*35)*(sin(2*PI*${ph})+0.18*sin(4*PI*${ph}))`, 0.2)},lowpass=f=5000[out]`
		}
	},
	tick: {
		preset: P('tick', 'Tick', 'UI', 'A tiny clock tick, for counters.', -16, 0.001, 1, false, 'counter'),
		len: () => 0.05,
		graph: (c) => [
			`${tone(`${atk(8000)}*(0.6*sin(2*PI*3200*t)*exp(-t*420)+0.4*sin(2*PI*1600*t)*exp(-t*260))`, 0.05)}[a]`,
			`${noise(0.05, 61 + c.seed, 'white', 'highpass=f=5000', `${atk(9000)}*exp(-t*700)`)},volume=0.3[b]`,
			sum(['a', 'b'], 'out')
		].join(';')
	},
	blip: {
		preset: P('blip', 'Blip', 'UI', 'A high, short note.', -15, 0.002, 1, false, 'ui'),
		len: () => 0.1,
		graph: (c) => {
			const f = note(c, N.E6)
			return `${tone(`${atk(3000)}*(sin(2*PI*${f}*t)*exp(-t*55)+0.2*sin(4*PI*${f}*t)*exp(-t*110))`, 0.1)}[out]`
		}
	},
	confirm: {
		preset: P('confirm', 'Confirm', 'UI', 'A bright bell: that worked.', -9, 0.003, 1, false, 'done'),
		len: () => 0.25,
		graph: (c) => {
			const f = note(c, N.B6)
			return `${tone(`${atk(2500)}*(sin(2*PI*${f}*t)*exp(-t*32)+0.2*sin(2*PI*${2.76 * f}*t)*exp(-t*70))`, 0.25)},aecho=0.8:0.4:23:0.15[out]`
		}
	},
	appear: {
		preset: P('appear', 'Appear', 'Motion', 'A mallet note as something comes on screen, two takes.', -9, 0.004, 2, false, 'in'),
		len: () => 0.5,
		graph: (c) =>
			`${tone(mallet(note(c, c.variant === 1 ? N.A5 : N.E5), 0, 13), 0.5)},aecho=0.85:0.5:29|43:0.22|0.15,lowpass=f=7000[out]`
	},
	whoosh: {
		preset: P('whoosh', 'Whoosh', 'Motion', 'A falling sweep for a slide-in.', -17, 0.084, 1, false, 'in'),
		len: () => 0.5,
		graph: (c) => {
			const env = 'pow(min(t/0.12,1),1.6)*exp(-max(t-0.12,0)*9)*(1-pow(t/0.5,8))'
			return [
				band(0.5, 31 + c.seed, 500, chirp(1400 * c.ratio, 600 * c.ratio, 0.4), env, 'w'),
				`${noise(0.5, 32 + c.seed, 'pink', 'highpass=f=3500', `${env}*${0.4 * c.airMul}`)}[air]`,
				sum(['w', 'air'], 'out', 'highpass=f=150,lowpass=f=8000')
			].join(';')
		}
	},
	swish: {
		preset: P('swish', 'Swish', 'Motion', 'A quick rising sweep for a cut or a wipe.', -17, 0.02, 1, false, 'cut'),
		len: () => 0.3,
		graph: (c) => {
			const env = 'pow(min(t/0.07,1),1.5)*exp(-max(t-0.07,0)*16)'
			return [
				band(0.3, 41 + c.seed, 450, chirp(1100 * c.ratio, 2400 * c.ratio, 0.22), env, 'w'),
				`${noise(0.3, 42 + c.seed, 'pink', 'highpass=f=3500', `${env}*${0.55 * c.airMul}`)}[air]`,
				sum(['w', 'air'], 'out', 'highpass=f=250,lowpass=f=11000')
			].join(';')
		}
	},
	flight: {
		preset: P('flight', 'Flight', 'Motion', 'A swell that follows a card across the frame, as long as the move.', -15, 0, 1, true, 'move'),
		len: (c) => c.dur * 1.1 + 0.02,
		graph: (c) => {
			const D = c.dur.toFixed(4)
			// The carrier rises and falls with the card's arc; the swell peaks mid-flight, where it moves fastest.
			const phase = `${650 * c.ratio}*t+${850 * c.ratio}*${D}/PI*(1-cos(PI*min(t,${D})/${D}))`
			const env = `pow(sin(PI*min(t/(${D}*1.08),1)),1.6)`
			const len = c.dur * 1.1 + 0.02
			return [
				band(len, 51 + c.seed, 450, phase, env, 'w'),
				`${noise(len, 52 + c.seed, 'pink', 'highpass=f=3000', `${env}*${0.35 * c.airMul}`)}[air]`,
				sum(['w', 'air'], 'out', 'highpass=f=150,lowpass=f=7000')
			].join(';')
		}
	},
	rise: {
		preset: P('rise', 'Rise', 'Motion', 'A glide upward while something builds, as long as the build.', -18, 0, 1, true, 'build'),
		len: (c) => c.dur + 0.35,
		graph: (c) => {
			const D = c.dur.toFixed(4)
			const f0 = note(c, N.A4)
			const f1 = note(c, N.E5)
			const env = `sin(PI/2*min(t/0.12,1))*exp(-max(t-${D},0)*7)`
			return `${tone(`st(0,${chirp(f0, f1, c.dur)});(sin(2*PI*ld(0))+0.25*sin(4*PI*ld(0))+0.2*sin(2*PI*1.003*ld(0)))*${env}`, c.dur + 0.35)},lowpass=f=5000[out]`
		}
	},
	land: {
		preset: P('land', 'Land', 'Motion', 'A soft thud with a note on top: it has arrived.', -5, 0.004, 1, false, 'done'),
		len: () => 0.4,
		graph: (c) => {
			const ph = `(${70 * c.ratio}*t+${90 * c.ratio}*(1-exp(-t*28))/28)`
			return [
				`${tone(`${atk(900)}*exp(-t*14)*(sin(2*PI*${ph})+0.35*sin(4*PI*${ph}))+0.3*${atk(1500)}*sin(2*PI*${note(c, N.E5)}*t)*exp(-t*40)`, 0.4)}[a]`,
				`${noise(0.4, 71 + c.seed, 'pink', 'lowpass=f=900', `${atk(3000)}*exp(-t*60)`)},volume=0.4[b]`,
				sum(['a', 'b'], 'out', 'highpass=f=45')
			].join(';')
		}
	},
	chime: {
		preset: P('chime', 'Chime', 'Musical', 'Two bell notes, ringing out.', -4, 0.004, 1, false, 'hit'),
		len: () => 2.0,
		graph: (c) =>
			`${tone(`${bell(note(c, N.A5), 0, 0.85)}+${bell(note(c, N.E6), 0.15)}`, 2.0)},aecho=0.8:0.55:37|61|89:0.3|0.2|0.12,lowpass=f=9000,afade=t=out:st=1.6:d=0.4[out]`
	},
	success: {
		preset: P('success', 'Success', 'Musical', 'Two quick mallet notes, rising: done.', -8, 0.003, 1, false, 'done'),
		len: () => 0.45,
		graph: (c) =>
			`${tone(`${mallet(note(c, N.E6), 0, 16, 0.8)}+${mallet(note(c, N.A6), 0.07, 16)}`, 0.45)},aecho=0.85:0.45:31:0.18,lowpass=f=9000[out]`
	},
	resolve: {
		preset: P('resolve', 'Resolve', 'Musical', 'A soft chord that settles: the end.', -5, 0.01, 1, false, 'end'),
		len: () => 3.4,
		graph: (c) => {
			const notes: [number, number, number][] = [
				[N.A4, 0, 0.6], [N.Cs5, 0.06, 0.5], [N.E5, 0.12, 0.5], [N.A5, 0.18, 0.42], [N.B5, 0.26, 0.25]
			]
			const voice = ([semi, at, amp]: [number, number, number]) => {
				const f = note(c, semi)
				const x = `(t-${at})`
				return `${amp}*gte(t,${at})*(1-exp(-${x}*120))*(sin(2*PI*${f}*${x})*exp(-${x}*1.25)+0.18*sin(2*PI*${2 * f}*${x})*exp(-${x}*2.6)+0.06*sin(2*PI*${3 * f}*${x})*exp(-${x}*4))`
			}
			return `${tone(notes.map(voice).join('+'), 3.4)},aecho=0.8:0.6:53|89|131|181:0.32|0.24|0.17|0.11,lowpass=f=6500,afade=t=out:st=2.6:d=0.8[out]`
		}
	},
	bed: {
		preset: P('bed', 'Ambient bed', 'Ambient', 'A slow pad of chords under everything, as long as the project.', -14, 0, 1, true, 'bed'),
		len: (c) => c.dur,
		graph: (c) => bedGraph(c)
	}
}

// ---------------------------------------------------------------- the ambient bed

/** MIDI note → Hz (69 = A4), moved by the recipe's pitch. */
const hz = (c: Ctx, midi: number) => 440 * 2 ** ((midi - 69 + c.pitch) / 12)
/** A soft saw-like voice at `f`: four harmonics falling 1, 0.45, 0.22, 0.1. */
const voice = (f: number) => `(sin(2*PI*${f}*t)+0.45*sin(4*PI*${f}*t)+0.22*sin(6*PI*${f}*t)+0.1*sin(8*PI*${f}*t))`

/** Four chords in A major pentatonic that loop: A, F#m, D, E. Four seconds each. */
const CHORDS = [
	[57, 61, 64, 69],
	[54, 61, 66, 69],
	[50, 57, 62, 66],
	[52, 59, 64, 68]
]
export const BED_CHORD_SEC = 4
/** Scales the summed voices so four notes of two detuned voices peak well under full scale. */
const BED_TRIM = 0.05

/**
 * The bed is a chain of pad chords, each its own short source delayed to its
 * place, summed and faded out at the end. Per channel two voices sit a fraction
 * of a percent apart (a wide, slow chorus); each chord swells in over 0.6 s and
 * releases over its own length plus a tail, so one chord crossfades into the
 * next rather than stepping.
 */
function bedGraph(c: Ctx): string {
	const total = c.dur
	const count = Math.max(1, Math.ceil(total / BED_CHORD_SEC))
	const parts: string[] = []
	const labels: string[] = []
	for (let i = 0; i < count; i++) {
		const midis = CHORDS[i % CHORDS.length]
		const held = BED_CHORD_SEC
		const env = `pow(sin(PI/2*min(t/0.6,1)),2)*if(lt(t,${held}),1,exp(-(t-${held})*3.5))*${BED_TRIM}`
		const ch = (a: number, b: number) =>
			`(${midis.map((m) => `${voice(hz(c, m) * a)}+${voice(hz(c, m) * b)}`).join('+')})*${env}`
		const len = held + 1.5
		const ms = Math.round(i * BED_CHORD_SEC * 1000)
		parts.push(`aevalsrc='${ch(0.9955, 1.0015)}|${ch(1.0045, 0.9985)}':s=${SR}:d=${len}:c=stereo,lowpass=f=2200,adelay=${ms}|${ms}[c${i}]`)
		labels.push(`c${i}`)
	}
	const fadeStart = Math.max(0, total - 1.5)
	const mixed = count === 1
		? `[c0]atrim=duration=${total},afade=t=out:st=${fadeStart}:d=1.5[out]`
		: `${labels.map((l) => `[${l}]`).join('')}amix=inputs=${count}:normalize=0:duration=longest,atrim=duration=${total},afade=t=out:st=${fadeStart}:d=1.5[out]`
	return [...parts, mixed].join(';')
}

// ---------------------------------------------------------------- reading a recipe

export const SOUND_PRESETS: readonly SoundPreset[] = (Object.values(VOICES) as Voice[]).map((v) => v.preset)

export const isSoundKind = (value: unknown): value is SoundKind =>
	typeof value === 'string' && Object.prototype.hasOwnProperty.call(VOICES, value)

export const presetOf = (kind: SoundKind): SoundPreset => VOICES[kind].preset

export const SOUND_GROUPS: readonly SoundGroup[] = ['UI', 'Motion', 'Musical', 'Ambient']

/** A recipe with every default written out, so two spellings of the same sound are one. */
export function normaliseRecipe(r: SoundRecipe): Required<SoundRecipe> {
	const preset = presetOf(r.kind)
	const c = ctxOf(r)
	return {
		kind: r.kind,
		variant: Math.min(c.variant, preset.variants - 1),
		pitch: Math.round(c.pitch * 100) / 100,
		levelDb: Math.round((r.levelDb ?? preset.level) * 10) / 10,
		air: Math.round(((r.air ?? DEFAULT_AIR)) * 100) / 100,
		seed: c.seed,
		durationSec: preset.follows ? Math.round(c.dur * 1000) / 1000 : 0
	}
}

/** The same sound is the same key: what the cache and the asset id are named by. */
export function recipeKey(r: SoundRecipe): string {
	const n = normaliseRecipe(r)
	return [n.kind, n.variant, n.pitch, n.levelDb, n.air, n.seed, n.durationSec].join('|')
}

/** How long the rendered sound lasts. */
export function soundLength(r: SoundRecipe): number {
	const n = normaliseRecipe(r)
	return VOICES[r.kind].len(ctxOf(n))
}

/** How early to start it so its hit lands on the cue. */
export const soundLead = (r: SoundRecipe): number => presetOf(r.kind).lead

/**
 * The filter graph for a recipe. Ends at `[out]`, mono except the bed (stereo);
 * the renderer adds the level and the limiter after it.
 */
export function soundGraph(r: SoundRecipe): string {
	const n = normaliseRecipe(r)
	return VOICES[r.kind].graph(ctxOf(n))
}

/**
 * What the renderer appends to every graph: a stereo pair, nothing else. The
 * LEVEL is applied after the fact, by the renderer, because it needs to know how
 * loud the sound came out: a recipe's `levelDb` is the sound's PEAK in dBFS, so
 * "−17 dB" means the same thing for a click and a chime.
 *
 * The stereo pair is made HERE, in the graph, with `pan`. Asking for it with the
 * output's `-ac 2` instead crashes the bundled ffmpeg (a segfault) on the
 * noise-and-sweep sounds: the converter it inserts after `aeval` does not
 * survive them. A test renders every sound, so a build that regresses this fails.
 */
export function soundFinish(r: SoundRecipe): string {
	return r.kind === 'bed' ? '[out]anull[final]' : '[out]pan=stereo|c0=c0|c1=c0[final]'
}

/** The peak the recipe wants, in dBFS. */
export const soundPeakDb = (r: SoundRecipe): number => normaliseRecipe(r).levelDb

/** Words for a person (or an agent) to read: "whoosh, pitch +2, −17 dB". */
export function describeRecipe(r: SoundRecipe): string {
	const n = normaliseRecipe(r)
	const preset = presetOf(r.kind)
	const bits = [preset.label.toLowerCase()]
	if (preset.variants > 1) bits.push(`take ${n.variant + 1}`)
	if (n.pitch) bits.push(`pitch ${n.pitch > 0 ? '+' : '−'}${Math.abs(n.pitch)}`)
	bits.push(`${n.levelDb.toString().replace('-', '−')} dB`)
	if (n.seed) bits.push(`seed ${n.seed}`)
	return bits.join(', ')
}
