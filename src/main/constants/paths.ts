export const THREAD_DIRS = {
	IMAGES: 'images',
	FRAMES: 'frames',
	ANALYSIS: 'analysis',
	GENERATED_IMAGES: 'generated-images',
	GENERATED_VIDEOS: 'generated-videos',
	AUDIO: 'audio',
	VIDEO: 'video',
	TRANSCRIPTS: 'transcripts',
	// Timeline editor: per-asset artifact root (tempDir/media/<assetId>/...)
	MEDIA: 'media',
	// Timeline editor: export workdirs + final renders (tempDir/exports/...)
	EXPORTS: 'exports'
} as const

// Subdirectories inside tempDir/media/<assetId>/ for the timeline editor.
// FRAMES/ANALYSIS/AUDIO intentionally reuse THREAD_DIRS names so pipeline
// phases run per-asset when given an asset-scoped tempDir.
export const ASSET_DIRS = {
	SOURCE: 'source',
	PROXY: 'proxy',
	ANALYSIS: THREAD_DIRS.ANALYSIS,
	FRAMES: THREAD_DIRS.FRAMES,
	AUDIO: THREAD_DIRS.AUDIO
} as const
