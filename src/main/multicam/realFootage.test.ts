import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import type { MediaAsset } from '@shared/types'
import { getFFprobeBinaryPath } from '../ffmpeg/binaries'
import { buildCameraGroup } from './group'
import { diarizeGroup } from './diarize'
import { syncRecordings } from './sync'

/**
 * Opt-in: syncs a real shoot. Point FF_MULTICAM_FOOTAGE at a folder of camera
 * files and list them, reference first, in FF_MULTICAM_FILES (comma separated):
 *
 *   FF_MULTICAM_FOOTAGE=footage FF_MULTICAM_FILES=Cam02/IMG_4913.MOV,Cam01/DJI_…MP4 \
 *     npx vitest run src/main/multicam/realFootage.test.ts
 *
 * Skipped everywhere else: the files are tens of gigabytes and never in git.
 */
const dir = process.env.FF_MULTICAM_FOOTAGE
const files = (process.env.FF_MULTICAM_FILES ?? '').split(',').filter(Boolean)
const truthDir = process.env.FF_MULTICAM_TRUTH
/** Where to write the numbers (the test runner may swallow console output). */
const reportFile = process.env.FF_MULTICAM_REPORT
const peopleCount = Number(process.env.FF_MULTICAM_SPEAKERS ?? 3)
const ready = !!dir && files.length >= 2 && files.every((f) => existsSync(join(dir, f)))

describe.skipIf(!ready)('a real shoot', () => {
	it('syncs every file against the first', async () => {
		const started = Date.now()
		const members = await syncRecordings(
			files.map((f) => ({ assetId: f, path: join(dir!, f) })),
			{ onProgress: (fraction, label) => console.log(`${Math.round(fraction * 100)}% ${label} (${((Date.now() - started) / 1000).toFixed(0)} s)`) }
		)
		for (const m of members) {
			console.log(JSON.stringify({
				file: m.assetId, offsetSec: Math.round(m.offset * 10000) / 10000, ppm: m.sync.driftPpm,
				confidence: m.sync.confidence, windows: m.sync.windows, residualMs: m.sync.residualSec !== undefined ? Math.round(m.sync.residualSec * 1000) : undefined,
				snrDb: m.quality ? Math.round(m.quality.snrDb * 10) / 10 : null, clipped: m.quality?.clipped
			}))
		}
		console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`)
		expect(members).toHaveLength(files.length)
	}, 1_800_000)
})

/**
 * Who speaks when, on the same shoot. Set FF_MULTICAM_SPEAKERS (the number of people, default 3) and
 * optionally FF_MULTICAM_TRUTH: a folder with the edit session's `turns.json` (speaker S = the woman,
 * M = a man, by pitch, inside the kept ranges, on the second listed file's clock) and `shots-final.json`
 * ([time, angle, "R"|"L"]: which man, chosen by eye on frames). That is a rough ground truth, not a
 * labelled corpus: the woman/man labels come from pitch, so they are not independent of this method's
 * own pitch feature; the right/left labels are.
 */
describe.skipIf(!ready)('who speaks when, on a real shoot', () => {
	it('finds the voices and scores them against the edit session\'s labels', async () => {
		const probe = (file: string) => Number(execFileSync(getFFprobeBinaryPath(),
			['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim())
		const media: MediaAsset[] = files.map((f) => ({
			id: f, kind: 'video', name: basename(f), originalPath: join(dir!, f),
			metadata: { duration: probe(join(dir!, f)), width: 3840, height: 2160, fps: 30, size: 1, codec: 'hevc', format: 'mp4', hasAudio: true },
			preprocessing: {}, clips: [], createdAt: 0
		}))
		let started = Date.now()
		const { group } = await buildCameraGroup(media, files, { name: 'Real shoot' })
		console.log(`sync took ${((Date.now() - started) / 1000).toFixed(0)} s`)
		started = Date.now()
		const speakers = await diarizeGroup(group, media, {
			speakers: peopleCount,
			onProgress: (fraction, label) => console.log(`${Math.round(fraction * 100)}% ${label} (${((Date.now() - started) / 1000).toFixed(0)} s)`)
		})
		console.log(`speakers took ${((Date.now() - started) / 1000).toFixed(0)} s`)
		console.log(JSON.stringify({
			people: speakers.people.map((p) => ({ id: p.id, pitchHz: p.pitchHz, talkMin: Math.round((p.talkSec ?? 0) / 6) / 10, camera: p.camera })),
			turns: speakers.turns.length, unsureShare: speakers.analysis.unsureShare, warnings: speakers.analysis.warnings
		}, null, 1))
		expect(speakers.people).toHaveLength(peopleCount)
		if (!truthDir) return

		// Truth is on the DJI's clock; the group's is the reference file's. The second listed file is the first DJI file.
		const shift = -group.members.find((m) => m.assetId === files[1])!.offset
		const turns = JSON.parse(readFileSync(join(truthDir, 'turns.json'), 'utf8')) as Array<{ who: 'S' | 'M'; s: number; e: number }>
		const shots = (JSON.parse(readFileSync(join(truthDir, 'shots-final.json'), 'utf8')) as Array<[number, number, 'R' | 'L' | null]>).sort((a, b) => a[0] - b[0])
		const who = (t: number) => turns.find((x) => x.s <= t && t < x.e)?.who
		const heard = (t: number) => {
			const turn = speakers.turns.find((x) => x.start <= t - shift && t - shift < x.end)
			return turn?.speaker ?? undefined
		}
		const tick = 0.1
		// 1. The woman against the men: each voice is mapped to the label it overlaps most, then scored.
		const sm = new Map<string, { S: number; M: number }>()
		for (const turn of turns) for (let t = turn.s; t < turn.e; t += tick) {
			const id = heard(t)
			if (!id) continue
			const c = sm.get(id) ?? { S: 0, M: 0 }
			c[turn.who]++
			sm.set(id, c)
		}
		const smLabel = (id: string) => ((sm.get(id)?.S ?? 0) > (sm.get(id)?.M ?? 0) ? 'S' : 'M')
		let smRight = 0, smAll = 0, smCovered = 0, smTruth = 0
		for (const turn of turns) for (let t = turn.s; t < turn.e; t += tick) {
			smTruth++
			const id = heard(t)
			if (!id) continue
			smCovered++
			smAll++
			if (smLabel(id) === turn.who) smRight++
		}
		// 2. Which man (R = Navid, right; L = the guest, left), where a man speaks and a punch-in was cut by eye.
		const rl = new Map<string, { R: number; L: number }>()
		const rlSamples: Array<[string, 'R' | 'L']> = []
		shots.forEach(([from, angle, side], i) => {
			if (angle !== 1 || !side || i + 1 >= shots.length) return
			for (let t = from + 0.5; t < shots[i + 1][0] - 0.5; t += tick) {
				const id = heard(t)
				if (who(t) !== 'M' || !id || smLabel(id) !== 'M') continue
				const c = rl.get(id) ?? { R: 0, L: 0 }
				c[side]++
				rl.set(id, c)
				rlSamples.push([id, side])
			}
		})
		const rlLabel = (id: string) => ((rl.get(id)?.R ?? 0) > (rl.get(id)?.L ?? 0) ? 'R' : 'L')
		const rlRight = rlSamples.filter(([id, side]) => rlLabel(id) === side).length
		// 3. How close the changes of speaker are, between the woman and a man.
		const mineChanges: number[] = []
		const real = speakers.turns.filter((t) => t.speaker)
		for (let i = 1; i < real.length; i++) {
			if (real[i].speaker !== real[i - 1].speaker && real[i].start - real[i - 1].end < 1.5) mineChanges.push((real[i].start + real[i - 1].end) / 2 + shift)
		}
		const errors: number[] = []
		for (let i = 1; i < turns.length; i++) {
			if (turns[i].who !== turns[i - 1].who && turns[i].s - turns[i - 1].e < 1.5) {
				const t = (turns[i].s + turns[i - 1].e) / 2
				errors.push(Math.min(99, ...mineChanges.map((c) => Math.abs(c - t))))
			}
		}
		errors.sort((a, b) => a - b)
		const within = (s: number) => errors.filter((e) => e < s).length / Math.max(1, errors.length)
		const report = {
			womanVsMen: { accuracy: +(smRight / smAll).toFixed(3), coveredShare: +(smCovered / smTruth).toFixed(3), seconds: Math.round(smAll * tick), voices: Object.fromEntries([...sm].map(([id, c]) => [id, `${smLabel(id)} (S ${Math.round(c.S * tick)} s / M ${Math.round(c.M * tick)} s)`])) },
			whichMan: { accuracy: +(rlRight / Math.max(1, rlSamples.length)).toFixed(3), seconds: Math.round(rlSamples.length * tick), voices: Object.fromEntries([...rl].map(([id, c]) => [id, `${rlLabel(id)} (R ${Math.round(c.R * tick)} s / L ${Math.round(c.L * tick)} s)`])) },
			changeOfSpeaker: { n: errors.length, median: +(errors[Math.floor(errors.length / 2)] ?? NaN).toFixed(2), within1s: +within(1).toFixed(2), within2s: +within(2).toFixed(2) }
		}
		console.log('ACCURACY', JSON.stringify(report, null, 1))
		if (reportFile) writeFileSync(reportFile, JSON.stringify({ report, people: speakers.people, warnings: speakers.analysis.warnings, unsureShare: speakers.analysis.unsureShare, turns: speakers.turns.length }, null, 1))
		expect(report.womanVsMen.accuracy).toBeGreaterThan(0.85)
		expect(report.whichMan.accuracy).toBeGreaterThan(0.7)
	}, 1_800_000)
})
