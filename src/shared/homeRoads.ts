import type { Thread } from './types'

/**
 * Home has two roads. Image projects open the graph, everything else opens the
 * timeline editor; retired AI-video threads are listed under Video (they are
 * greyed and not openable) rather than getting a road of their own.
 */
export type Road = 'image' | 'video'

export const roadOf = (thread: Pick<Thread, 'type'>): Road => (thread.type === 'image' ? 'image' : 'video')

export function splitRoads<T extends Pick<Thread, 'type' | 'updatedAt'>>(threads: T[]): Record<Road, T[]> {
	const out: Record<Road, T[]> = { image: [], video: [] }
	for (const t of threads) out[roadOf(t)].push(t)
	for (const road of Object.keys(out) as Road[]) out[road].sort((a, b) => b.updatedAt - a.updatedAt)
	return out
}

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']
export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi']

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()

export interface DroppedFile { path: string; name: string }

/** What a drop holds, by extension: the dialogs filter the same way. */
export function classifyDrop(files: DroppedFile[]): { images: DroppedFile[]; videos: DroppedFile[]; other: DroppedFile[] } {
	const out = { images: [] as DroppedFile[], videos: [] as DroppedFile[], other: [] as DroppedFile[] }
	for (const f of files) {
		const ext = extOf(f.name)
		if (IMAGE_EXTENSIONS.includes(ext)) out.images.push(f)
		else if (VIDEO_EXTENSIONS.includes(ext)) out.videos.push(f)
		else out.other.push(f)
	}
	return out
}

/** What a road does with a drop, or why it refuses. */
export function planDrop(road: Road, files: DroppedFile[]):
	| { ok: true; images: DroppedFile[]; video?: DroppedFile }
	| { ok: false; reason: string } {
	const { images, videos } = classifyDrop(files)
	if (road === 'video') {
		if (!videos.length) return { ok: false, reason: images.length ? 'Images belong on the Images side.' : 'Drop a video file here.' }
		return { ok: true, images: [], video: videos[0] }
	}
	if (!images.length && !videos.length) return { ok: false, reason: 'Drop images, or a reference video.' }
	return { ok: true, images, video: videos[0] }
}
