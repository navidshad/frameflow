import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PromptAttachment, PromptAttachmentInput } from '@shared/types'

/**
 * The frames a chat message carries, kept beside the project.
 *
 * The composer sends each picture once, as base64; it is written here so the
 * turn can name a file instead of holding megabytes in the project document,
 * and so Retry can send the same pictures again. Retry sends paths back, and
 * only a path inside this folder is read: the renderer never gets to name an
 * arbitrary file for main to read and send to a model.
 */

const DIR = 'prompt-attachments'
/** A few frames of 1280px JPEG; far past that, something is wrong. */
const MAX_BYTES = 8 * 1024 * 1024
const MAX_COUNT = 8

export interface StoredAttachments {
	attachments: PromptAttachment[]
	images: { data: string; mimeType: string }[]
}

export async function storeAttachments(projectDir: string, turnId: string, inputs: PromptAttachmentInput[] | undefined): Promise<StoredAttachments> {
	const list = (inputs ?? []).slice(0, MAX_COUNT)
	if (!list.length) return { attachments: [], images: [] }
	const dir = path.join(projectDir, DIR)
	await mkdir(dir, { recursive: true })
	const attachments: PromptAttachment[] = []
	const images: StoredAttachments['images'] = []
	for (const [index, input] of list.entries()) {
		const meta = {
			id: String(input.id),
			timeSec: Math.max(0, Number(input.timeSec) || 0),
			note: typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 500) : undefined,
			marked: !!input.marked || undefined,
			labels: Array.isArray(input.labels) && input.labels.length
				? input.labels.map((l) => String(l).trim().slice(0, 200)).filter(Boolean).slice(0, 20)
				: undefined,
			thumbnail: typeof input.thumbnail === 'string' && input.thumbnail.startsWith('data:image/') ? input.thumbnail : ''
		}
		if (input.data !== undefined) {
			if (!/^image\/(jpeg|png|webp)$/.test(input.mimeType)) throw new Error('An attached frame is not a picture FrameFlow can send.')
			const bytes = Buffer.from(input.data, 'base64')
			if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('An attached frame is empty or too large to send.')
			const file = path.join(dir, `${turnId}-${index + 1}.${input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg'}`)
			await writeFile(file, bytes)
			attachments.push({ ...meta, path: file })
			images.push({ data: input.data, mimeType: input.mimeType })
			continue
		}
		// Retry: a file an earlier turn of this project wrote.
		const file = path.resolve(String(input.path))
		if (path.dirname(file) !== dir) throw new Error('An attached frame is not one of this project’s.')
		const bytes = await readFile(file).catch(() => null)
		if (!bytes) throw new Error('A frame this message carried is no longer on disk. Attach it again.')
		attachments.push({ ...meta, path: file })
		images.push({ data: bytes.toString('base64'), mimeType: file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg' })
	}
	return { attachments, images }
}
