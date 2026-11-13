import { describe, expect, it } from 'vitest'
import { sequenceFrame } from './framing'
import {
	RESOLUTION_RUNGS, documentFrame, exportChoices, fitFrameToShortSide, frameAtRung, frameForShape,
	linesForChoice, migrateProjectFrame, normalizeCustomFrame, rungOf, shapeOf, FRAME_SHAPES, usedVideoSources
} from './resolution'

const ids = (f: { width: number; height: number }) => exportChoices(f).map((c) => c.id)
const sizes = (f: { width: number; height: number }) => exportChoices(f).map((c) => `${c.frame.width}×${c.frame.height}`)

describe('export choices per project shape', () => {
	it('4K landscape offers every rung, each at its 16:9 size', () => {
		const f = { width: 3840, height: 2160 }
		expect(ids(f)).toEqual(['original', '2k', '1080', '720'])
		expect(sizes(f)).toEqual(['3840×2160', '2560×1440', '1920×1080', '1280×720'])
		expect(exportChoices(f)[0].label).toBe('4K · 3840×2160')
	})

	it('2K lists itself as the original and the rungs below', () => {
		const f = { width: 2560, height: 1440 }
		expect(ids(f)).toEqual(['original', '1080', '720'])
		expect(exportChoices(f)[0].label).toBe('2K · 2560×1440')
	})

	it('1080p offers 720p; 720p offers nothing smaller', () => {
		expect(ids({ width: 1920, height: 1080 })).toEqual(['original', '720'])
		expect(ids({ width: 1280, height: 720 })).toEqual(['original'])
	})

	it('names a rung by the short side, so vertical 4K goes 2160×3840 → 1440×2560 → 1080×1920', () => {
		const f = { width: 2160, height: 3840 }
		expect(sizes(f)).toEqual(['2160×3840', '1440×2560', '1080×1920', '720×1280'])
	})

	it('square and 4:5 follow the same rule', () => {
		expect(sizes({ width: 2160, height: 2160 })).toEqual(['2160×2160', '1440×1440', '1080×1080', '720×720'])
		expect(sizes({ width: 1080, height: 1350 })).toEqual(['1080×1350', '720×900'])
	})

	it('a custom size is its own original, labelled without a rung name', () => {
		const f = { width: 2000, height: 1000 }
		expect(exportChoices(f)[0].label).toBe('2000×1000')
		expect(ids(f)).toEqual(['original', '720'])
		expect(sizes(f)).toEqual(['2000×1000', '1440×720'])
	})

	it('never offers a size above the project', () => {
		for (const f of [
			{ width: 3840, height: 2160 }, { width: 2160, height: 3840 }, { width: 1920, height: 1080 },
			{ width: 1000, height: 600 }, { width: 640, height: 360 }, { width: 2000, height: 1000 }
		]) {
			for (const c of exportChoices(f)) {
				expect(c.frame.width).toBeLessThanOrEqual(f.width)
				expect(c.frame.height).toBeLessThanOrEqual(f.height)
			}
		}
	})

	it('maps ids to lines', () => {
		expect(RESOLUTION_RUNGS.map((r) => r.lines)).toEqual([2160, 1440, 1080, 720])
		expect(linesForChoice('2k')).toBe(1440)
		expect(linesForChoice('original')).toBeUndefined()
		expect(linesForChoice('nonsense')).toBeUndefined()
	})
})

describe('fitFrameToShortSide', () => {
	it('keeps even dimensions', () => {
		const fit = fitFrameToShortSide({ width: 1919, height: 1081 }, 720)
		expect(fit.width % 2).toBe(0)
		expect(fit.height).toBe(720)
	})

	it('never upscales: a smaller or equal frame comes back as it was', () => {
		expect(fitFrameToShortSide({ width: 1280, height: 720 }, 1080)).toEqual({ width: 1280, height: 720 })
		expect(fitFrameToShortSide({ width: 1080, height: 1920 }, 1080)).toEqual({ width: 1080, height: 1920 })
		expect(fitFrameToShortSide({ width: 1080, height: 1920 }, 2160)).toEqual({ width: 1080, height: 1920 })
	})
})

describe('frame shapes', () => {
	it('builds each shape at a rung', () => {
		const [land, vert, sq, por] = FRAME_SHAPES
		expect(frameForShape(land, 1080)).toEqual({ width: 1920, height: 1080 })
		expect(frameForShape(vert, 1080)).toEqual({ width: 1080, height: 1920 })
		expect(frameForShape(sq, 1440)).toEqual({ width: 1440, height: 1440 })
		expect(frameForShape(por, 1080)).toEqual({ width: 1080, height: 1350 })
		expect(frameForShape(land, 2160)).toEqual({ width: 3840, height: 2160 })
	})

	it('recognises shapes and rungs, and says null for anything else', () => {
		expect(shapeOf({ width: 3840, height: 2160 })?.short).toBe('16:9')
		expect(shapeOf({ width: 1080, height: 1920 })?.short).toBe('9:16')
		expect(shapeOf({ width: 2000, height: 1000 })).toBeNull()
		expect(rungOf({ width: 2560, height: 1440 })?.id).toBe('2k')
		expect(rungOf({ width: 1080, height: 1920 })?.id).toBe('1080')
		expect(rungOf({ width: 2000, height: 1000 })).toBeNull()
	})

	it('changes the resolution of a project keeping its shape, either direction', () => {
		expect(frameAtRung({ width: 1920, height: 1080 }, 2160)).toEqual({ width: 3840, height: 2160 })
		expect(frameAtRung({ width: 2000, height: 1000 }, 1080)).toEqual({ width: 2160, height: 1080 })
	})

	it('holds a custom size to something an encoder takes', () => {
		expect(normalizeCustomFrame(1921, 1081)).toEqual({ width: 1922, height: 1082 })
		expect(normalizeCustomFrame(10, 99999)).toEqual({ width: 128, height: 7680 })
		expect(normalizeCustomFrame(NaN, 100)).toBeNull()
	})
})

describe('migrating old projects', () => {
	const uhd = { width: 3840, height: 2160 }

	it('writes the frame an unchosen project already exports at', () => {
		const meta = { fps: 30, width: 1920, height: 1080, duration: 0 }
		const sources = [{ width: 1920, height: 1080 }, uhd]
		const migrated = migrateProjectFrame(meta, sources)
		expect(migrated).toMatchObject({ width: 3840, height: 2160, frameChosen: true, fps: 30 })
		// byte-identical frame: the migration reads the same function the export does
		expect(sequenceFrame(migrated, sources)).toEqual(sequenceFrame(meta, sources))
	})

	it('keeps an odd-sized source on even dimensions, as the export did', () => {
		const sources = [{ width: 1919, height: 1079 }]
		const migrated = migrateProjectFrame({ fps: 30, width: 1920, height: 1080, duration: 0 }, sources)
		expect([migrated.width, migrated.height]).toEqual([1918, 1078])
		expect(sequenceFrame(migrated, sources)).toEqual(sequenceFrame({ width: 1920, height: 1080 }, sources))
	})

	it('leaves a project that chose its frame alone, same object', () => {
		const meta = { fps: 30, width: 1080, height: 1920, duration: 0, frameChosen: true }
		expect(migrateProjectFrame(meta, [uhd])).toBe(meta)
	})

	it('waits while no used source has dimensions', () => {
		const meta = { fps: 30, width: 1920, height: 1080, duration: 0 }
		expect(migrateProjectFrame(meta, [])).toBe(meta)
		expect(migrateProjectFrame(meta, [{}])).toBe(meta)
	})

	it('is idempotent', () => {
		const once = migrateProjectFrame({ fps: 30, width: 1920, height: 1080, duration: 0 }, [uhd])
		expect(migrateProjectFrame(once, [{ width: 7680, height: 4320 }])).toBe(once)
	})

	it('reads only the video the timeline uses, and ignores audio', () => {
		const doc = {
			timelineMeta: { width: 1920, height: 1080 },
			timeline: [{ sourceAssetId: 'a' }],
			media: [
				{ id: 'a', kind: 'video', metadata: { width: 3840, height: 2160 } },
				{ id: 'b', kind: 'video', metadata: { width: 7680, height: 4320 } },
				{ id: 'c', kind: 'audio', metadata: {} }
			]
		}
		expect(usedVideoSources(doc)).toEqual([{ width: 3840, height: 2160 }])
		expect(documentFrame(doc)).toEqual({ width: 3840, height: 2160 })
	})
})
