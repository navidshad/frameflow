import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { registerEffects } from '@shared/effects'
import { parsePack, starterManifest, STARTER_LOOKS, toCube } from '@shared/packs'

/**
 * The filesystem half of packs: find them, read them, register what they
 * describe. Everything about WHAT a pack may express is in `@shared/packs`,
 * which is a parser rather than an evaluator — a pack ships a LUT or a preset
 * of an effect this build already has, and never a filter string.
 *
 * Layout, one directory per pack:
 *
 *   <userData>/packs/starter-looks/pack.json
 *   <userData>/packs/starter-looks/starter-teal-orange.cube
 */

const LUT_SIZE = 17

const packsDir = () => path.join(app.getPath('userData'), 'packs')

/**
 * Write the looks this app ships, if they are not already there.
 *
 * They go through the pack loader like anything else rather than being
 * registered directly, so the seam a third-party pack will use is the one
 * exercised on every launch — the alternative is a loader nobody runs until
 * the day it matters.
 */
function ensureStarterPack(): void {
	const dir = path.join(packsDir(), 'starter-looks')
	const manifestPath = path.join(dir, 'pack.json')
	if (fs.existsSync(manifestPath)) return

	fs.mkdirSync(dir, { recursive: true })
	for (const look of STARTER_LOOKS) {
		fs.writeFileSync(path.join(dir, `${look.kind}.cube`), toCube(look.label, LUT_SIZE, look.map), 'utf-8')
	}
	fs.writeFileSync(manifestPath, `${JSON.stringify(starterManifest(), null, '\t')}\n`, 'utf-8')
	console.log('[packs] wrote the starter pack to', dir)
}

/**
 * Load every pack on disk into the effect registry.
 *
 * A bad pack is skipped with a reason on the console, never thrown: one broken
 * manifest must not stop the app opening, and a project that used an effect
 * from a pack you no longer have still loads — `effectChain` skips a kind it
 * does not know.
 */
export function loadPacks(): { packs: number; effects: number } {
	let packs = 0
	let effects = 0
	try {
		ensureStarterPack()
	} catch (error) {
		console.warn('[packs] could not write the starter pack:', error)
	}

	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(packsDir(), { withFileTypes: true })
	} catch {
		return { packs: 0, effects: 0 } // no packs directory yet, which is fine
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const dir = path.join(packsDir(), entry.name)
		const manifestPath = path.join(dir, 'pack.json')
		if (!fs.existsSync(manifestPath)) continue
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
			const parsed = parsePack(manifest, (name) => {
				// Resolved inside the pack directory and checked to still be
				// inside it, so a manifest cannot walk out with `../`.
				const file = path.resolve(dir, name)
				if (!file.startsWith(path.resolve(dir) + path.sep)) return null
				return fs.existsSync(file) ? file : null
			})
			for (const problem of parsed.problems) {
				console.warn(`[packs] ${entry.name}: skipped "${problem.entry}" — ${problem.reason}`)
			}
			if (!parsed.effects.length) continue
			const replaced = registerEffects(parsed.effects)
			if (replaced.length) {
				console.warn(`[packs] ${entry.name} overrode: ${replaced.join(', ')}`)
			}
			packs++
			effects += parsed.effects.length
		} catch (error) {
			console.warn(`[packs] ${entry.name}: unreadable —`, error)
		}
	}

	if (packs) console.log(`[packs] loaded ${effects} effect(s) from ${packs} pack(s)`)
	return { packs, effects }
}

/**
 * The packs on disk, as data the renderer can parse for itself.
 *
 * An `EffectDef` carries a `build` function, so it cannot cross IPC. What
 * crosses instead is the manifest plus the absolute path of every file it
 * legitimately refers to — and the renderer runs the SAME `parsePack` over it.
 * One parser, one set of rules, two processes.
 */
export function packManifests(): { manifest: unknown; files: Record<string, string> }[] {
	const out: { manifest: unknown; files: Record<string, string> }[] = []
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(packsDir(), { withFileTypes: true })
	} catch {
		return out
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue
		const dir = path.join(packsDir(), entry.name)
		const manifestPath = path.join(dir, 'pack.json')
		if (!fs.existsSync(manifestPath)) continue
		try {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
			const files: Record<string, string> = {}
			for (const name of fs.readdirSync(dir)) {
				if (name.toLowerCase().endsWith('.cube')) files[name] = path.join(dir, name)
			}
			out.push({ manifest, files })
		} catch { /* reported already by loadPacks */ }
	}
	return out
}
