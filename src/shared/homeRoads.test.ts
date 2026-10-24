import { describe, expect, it } from 'vitest'
import { classifyDrop, planDrop, roadOf, splitRoads } from './homeRoads'

const f = (name: string) => ({ name, path: '/x/' + name })

describe('splitRoads', () => {
	it('puts image threads on Images and everything else, legacy included, on Video', () => {
		const threads = [
			{ type: 'image' as const, updatedAt: 1 }, { type: 'editor' as const, updatedAt: 5 },
			{ type: 'video' as const, updatedAt: 3 }, { type: undefined, updatedAt: 9 }, { type: 'image' as const, updatedAt: 7 }
		]
		const { image, video } = splitRoads(threads)
		expect(image.map((t) => t.updatedAt)).toEqual([7, 1])
		expect(video.map((t) => t.updatedAt)).toEqual([9, 5, 3])
		expect(roadOf({ type: undefined })).toBe('video')
	})
})

describe('classifyDrop / planDrop', () => {
	it('sorts by extension, case-insensitively', () => {
		const c = classifyDrop([f('a.PNG'), f('b.MOV'), f('c.pdf'), f('noext')])
		expect(c.images).toHaveLength(1)
		expect(c.videos).toHaveLength(1)
		expect(c.other).toHaveLength(2)
	})
	it('Video takes the first video and refuses images', () => {
		expect(planDrop('video', [f('a.mp4'), f('b.mp4')])).toMatchObject({ ok: true, video: { name: 'a.mp4' }, images: [] })
		expect(planDrop('video', [f('a.png')])).toMatchObject({ ok: false, reason: expect.stringMatching(/Images side/) })
		expect(planDrop('video', [f('a.txt')]).ok).toBe(false)
	})
	it('Images takes images, and a video as reference', () => {
		expect(planDrop('image', [f('a.png'), f('b.jpg'), f('r.mp4')])).toMatchObject({ ok: true, images: [{}, {}], video: { name: 'r.mp4' } })
		expect(planDrop('image', [f('r.mp4')])).toMatchObject({ ok: true, images: [] })
		expect(planDrop('image', [f('a.txt')]).ok).toBe(false)
	})
})
