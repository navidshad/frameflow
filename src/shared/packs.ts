import { effectDef, num, type EffectDef, type EffectParams } from './effects'

/**
 * Packs: extra looks, as data on disk.
 *
 * The whole format is deliberately narrow. A pack may ship a **LUT file** or a
 * **preset of an effect this build already has** — and nothing else. In
 * particular it may NOT supply a raw ffmpeg filter string, which would be an
 * injection hole the moment anyone downloads a pack: `movie=`, `subtitles=` and
 * friends read the filesystem, and a filtergraph is not a sandbox.
 *
 * So this is a parser, not an evaluator. Everything a pack can express is a
 * value the app already knew how to render.
 */

export interface PackLutEntry {
	kind: string
	label: string
	group?: string
	description?: string
	/** A `.cube` file, resolved relative to the pack directory. */
	lut: string
}

export interface PackPresetEntry {
	kind: string
	label: string
	group?: string
	description?: string
	/** The kind of a built-in effect this is a preset of. */
	base: string
	params?: EffectParams
}

export type PackEntry = PackLutEntry | PackPresetEntry

export interface PackManifest {
	name: string
	version?: number
	author?: string
	effects: PackEntry[]
}

export interface PackProblem {
	entry: string
	reason: string
}

export interface ParsedPack {
	name: string
	effects: EffectDef[]
	/** Entries that were rejected, with why. Surfaced, never swallowed. */
	problems: PackProblem[]
}

const isLut = (entry: PackEntry): entry is PackLutEntry =>
	typeof (entry as PackLutEntry).lut === 'string'

/** A kind must be a plain slug: it becomes a registry key and appears in saved documents. */
const KIND = /^[a-z0-9][a-z0-9-]{1,63}$/

/**
 * Escape a path for `lut3d=file=...`, which sits behind the same two parsers
 * `subtitles=` does — see escapeSubtitlesPath in captions.ts, and the colon
 * that used to break every export.
 */
export function escapeFilterPath(filePath: string): string {
	const normalized = /^[A-Za-z]:[\\/]/.test(filePath) ? filePath.replace(/\\/g, '/') : filePath
	const option = normalized.replace(/([\\':])/g, '\\$1')
	return option.replace(/([\\'[\],;])/g, '\\$1')
}

/**
 * Turn a manifest into effect definitions.
 *
 * `resolveFile` maps a manifest-relative filename to an absolute path, and
 * returns null when the file is not there — so this stays pure and the
 * filesystem half lives in main.
 */
export function parsePack(
	manifest: unknown,
	resolveFile: (name: string) => string | null
): ParsedPack {
	const problems: PackProblem[] = []
	const effects: EffectDef[] = []

	const m = manifest as PackManifest
	if (!m || typeof m !== 'object' || typeof m.name !== 'string' || !Array.isArray(m.effects)) {
		return { name: 'unreadable pack', effects: [], problems: [{ entry: '(manifest)', reason: 'not a pack manifest' }] }
	}

	const group = m.name
	for (const entry of m.effects) {
		const id = (entry && typeof entry.kind === 'string' ? entry.kind : '(unnamed)')
		const reject = (reason: string) => problems.push({ entry: id, reason })

		if (!entry || typeof entry.kind !== 'string' || !KIND.test(entry.kind)) {
			reject('kind must be a lowercase slug')
			continue
		}
		if (typeof entry.label !== 'string' || !entry.label.trim()) {
			reject('missing label')
			continue
		}
		const common = {
			kind: entry.kind,
			label: entry.label.trim(),
			group: entry.group?.trim() || group,
			stream: 'video' as const,
			description: entry.description?.trim() || `From ${m.name}.`,
			params: []
		}

		if (isLut(entry)) {
			// Only a .cube, and only inside the pack: a manifest naming
			// `../../.ssh/id_rsa` must not reach ffmpeg.
			if (!/^[\w.-]+\.cube$/i.test(entry.lut)) {
				reject('lut must be a .cube file in the pack directory')
				continue
			}
			const file = resolveFile(entry.lut)
			if (!file) {
				reject(`missing file ${entry.lut}`)
				continue
			}
			const filter = `lut3d=file=${escapeFilterPath(file)}`
			effects.push({ ...common, build: () => filter })
			continue
		}

		const base = effectDef((entry as PackPresetEntry).base)
		if (!base) {
			reject(`unknown base effect "${(entry as PackPresetEntry).base}"`)
			continue
		}
		// The preset's values are baked in at parse time, clamped by the base's
		// own parameter definitions — a pack cannot smuggle a value past them.
		const fixed: EffectParams = {}
		for (const param of base.params) {
			const supplied = (entry as PackPresetEntry).params?.[param.key]
			fixed[param.key] = param.kind === 'number'
				? num({ [param.key]: supplied ?? param.default }, param)
				: (typeof supplied === 'string' ? supplied : param.default)
		}
		const filter = base.build(fixed)
		if (!filter) {
			reject('preset changes nothing')
			continue
		}
		effects.push({
			...common,
			build: () => filter,
			...(base.css ? { css: () => base.css!(fixed) } : {})
		})
	}

	return { name: m.name, effects, problems }
}

// ===== Generating a starter pack =====

/**
 * A `.cube` is a plain-text cube of RGB samples, R varying fastest.
 *
 * Generated rather than sourced, so every look this app ships is owned
 * outright — and so the pack loader is exercised by default instead of only by
 * a pack somebody might one day install.
 */
export function toCube(
	title: string,
	size: number,
	map: (r: number, g: number, b: number) => [number, number, number]
): string {
	const lines = [`TITLE "${title.replace(/"/g, "'")}"`, `LUT_3D_SIZE ${size}`, '']
	const step = 1 / (size - 1)
	for (let bi = 0; bi < size; bi++) {
		for (let gi = 0; gi < size; gi++) {
			for (let ri = 0; ri < size; ri++) {
				const out = map(ri * step, gi * step, bi * step)
				lines.push(out.map((v) => Math.max(0, Math.min(1, v)).toFixed(6)).join(' '))
			}
		}
	}
	return `${lines.join('\n')}\n`
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b
/** S-curve around the midpoint; `k` above 1 steepens it. */
const contrast = (v: number, k: number) => Math.max(0, Math.min(1, (v - 0.5) * k + 0.5))

/** The looks the starter pack ships, each a pure function of a colour. */
export const STARTER_LOOKS: {
	kind: string
	label: string
	description: string
	map: (r: number, g: number, b: number) => [number, number, number]
}[] = [
	{
		kind: 'starter-teal-orange',
		label: 'Teal & Orange',
		description: 'Cool shadows, warm skin. The blockbuster grade.',
		map: (r, g, b) => {
			const l = luma(r, g, b)
			// Shadows lean teal, highlights lean orange, midtones stay put.
			const shadow = 1 - Math.min(1, l * 2)
			const highlight = Math.max(0, l * 2 - 1)
			return [
				contrast(r + highlight * 0.10 - shadow * 0.05, 1.08),
				contrast(g + highlight * 0.03 + shadow * 0.02, 1.08),
				contrast(b - highlight * 0.08 + shadow * 0.10, 1.08)
			]
		}
	},
	{
		kind: 'starter-bleach',
		label: 'Bleach Bypass',
		description: 'Desaturated and hard. Gritty documentary.',
		map: (r, g, b) => {
			const l = contrast(luma(r, g, b), 1.35)
			return [mix(l, contrast(r, 1.2), 0.35), mix(l, contrast(g, 1.2), 0.35), mix(l, contrast(b, 1.2), 0.35)]
		}
	},
	{
		kind: 'starter-warm-film',
		label: 'Warm Film',
		description: 'Lifted blacks and a golden cast, like scanned stock.',
		map: (r, g, b) => [
			mix(r, 1, 0.06) * 1.02,
			mix(g, 1, 0.045),
			mix(b, 1, 0.03) * 0.97
		]
	},
	{
		kind: 'starter-cold-steel',
		label: 'Cold Steel',
		description: 'Blue and clinical, with the reds pulled back.',
		map: (r, g, b) => [
			contrast(r * 0.94, 1.12),
			contrast(g * 0.98, 1.12),
			contrast(Math.min(1, b * 1.06 + 0.02), 1.12)
		]
	}
]

/** The manifest that goes beside those files. */
export const starterManifest = (): PackManifest => ({
	name: 'Starter Looks',
	version: 1,
	author: 'FrameFlow',
	effects: STARTER_LOOKS.map((look) => ({
		kind: look.kind,
		label: look.label,
		group: 'Starter Looks',
		description: look.description,
		lut: `${look.kind}.cube`
	}))
})
