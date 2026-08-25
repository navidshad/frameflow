import { describe, expect, it } from 'vitest'
import type { Thread } from '@shared/types'
import { planArtifactSeed } from './promote'

/**
 * The seeding table decides whether "Open in Editor" reuses the chat thread's
 * artifacts or silently redoes the work — for the transcript, at real Gemini
 * cost. Every destination filename below has to match exactly what the
 * corresponding preprocess step writes, so its skip-if-exists guard fires.
 */

const DIR = '/tmp/thread-x/media/asset-1'

/** Every path is claimed to exist unless it is in `missing`. */
const allExist = (missing: string[] = []) => (p?: string) => !!p && !missing.includes(p)

const full: Thread['preprocessing'] = {
	lowResVideoPath: '/chat/video/lecture_480p.mp4',
	audioPath: '/chat/audio/lecture_480p.mp3',
	rawTranscriptPath: '/chat/transcripts/raw_transcript.json',
	correctedTranscriptPath: '/chat/transcripts/corrected_transcript.json',
	sceneTimesPath: '/chat/analysis/scenes.json',
	sceneDescriptionsPath: '/chat/analysis/scene_descriptions.json'
}

const destFor = (plan: ReturnType<typeof planArtifactSeed>, src: string) =>
	plan.actions.find((a) => a.src === src)?.dest

describe('planArtifactSeed — destination filenames the skip guards look for', () => {
	it('lands the raw transcript at transcripts/raw_transcript.json', () => {
		// runTranscriptStep's guard tests rawTranscriptPath. Getting this name
		// wrong re-bills a full Gemini transcription on every promote.
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(destFor(plan, full.rawTranscriptPath!))
			.toBe(`${DIR}/transcripts/raw_transcript.json`)
		expect(plan.patch.rawTranscriptPath).toBe(`${DIR}/transcripts/raw_transcript.json`)
	})

	it('lands scenes at analysis/scenes.json', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(destFor(plan, full.sceneTimesPath!)).toBe(`${DIR}/analysis/scenes.json`)
		expect(plan.patch.sceneTimesPath).toBe(`${DIR}/analysis/scenes.json`)
	})

	it('lands descriptions at analysis/scene_descriptions.json', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(plan.patch.sceneDescriptionsPath)
			.toBe(`${DIR}/analysis/scene_descriptions.json`)
	})

	it('lands the corrected transcript where extractCorrectedTranscript writes', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(plan.patch.correctedTranscriptPath)
			.toBe(`${DIR}/transcripts/corrected_transcript.json`)
	})

	it('keeps the proxy and audio basenames', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(plan.patch.lowResVideoPath).toBe(`${DIR}/proxy/lecture_480p.mp4`)
		expect(plan.patch.audioPath).toBe(`${DIR}/audio/lecture_480p.mp3`)
	})
})

describe('planArtifactSeed — link vs copy', () => {
	it('hard-links the two big media files so they survive source deletion', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		const linked = plan.actions.filter((a) => a.mode === 'link').map((a) => a.src)
		expect(linked).toEqual([full.lowResVideoPath, full.audioPath])
	})

	it('copies every JSON artifact', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		const copied = plan.actions.filter((a) => a.mode === 'copy').map((a) => a.dest)
		expect(copied.every((d) => d.endsWith('.json'))).toBe(true)
		expect(copied.length).toBe(4)
	})
})

describe('planArtifactSeed — transcriptPath resolution', () => {
	it('prefers the corrected transcript, which is a superset of the raw one', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(plan.patch.transcriptPath).toBe(`${DIR}/transcripts/corrected_transcript.json`)
	})

	it('falls back to the raw transcript when no corrected pass exists', () => {
		const { correctedTranscriptPath, ...noCorrected } = full
		const plan = planArtifactSeed(noCorrected, DIR, allExist())
		expect(plan.patch.transcriptPath).toBe(`${DIR}/transcripts/raw_transcript.json`)
		expect(plan.patch.correctedTranscriptPath).toBeUndefined()
	})

	it('sets no transcriptPath at all when neither exists', () => {
		const plan = planArtifactSeed({ sceneTimesPath: full.sceneTimesPath }, DIR, allExist())
		expect(plan.patch.transcriptPath).toBeUndefined()
	})
})

describe('planArtifactSeed — partial and empty preprocessing', () => {
	it('skips artifacts that are recorded but no longer on disk', () => {
		// A source already <=480p never gets lowResVideoPath; runProxyStep then
		// handles it with one ffprobe. Nothing here should pretend otherwise.
		const plan = planArtifactSeed(full, DIR, allExist([full.lowResVideoPath!]))
		expect(plan.patch.lowResVideoPath).toBeUndefined()
		expect(plan.proxyPath).toBeUndefined()
		expect(plan.actions.some((a) => a.src === full.lowResVideoPath)).toBe(false)
		// ...and leaves the rest of the table intact.
		expect(plan.patch.sceneTimesPath).toBe(`${DIR}/analysis/scenes.json`)
	})

	it('plans nothing for a thread that was never preprocessed', () => {
		const plan = planArtifactSeed({}, DIR, allExist())
		expect(plan.actions).toEqual([])
		expect(plan.patch).toEqual({})
	})

	it('tolerates undefined preprocessing', () => {
		const plan = planArtifactSeed(undefined, DIR, allExist())
		expect(plan.actions).toEqual([])
	})

	it('never plans an action whose dest is outside the asset dir', () => {
		const plan = planArtifactSeed(full, DIR, allExist())
		expect(plan.actions.every((a) => a.dest.startsWith(`${DIR}/`))).toBe(true)
	})
})
