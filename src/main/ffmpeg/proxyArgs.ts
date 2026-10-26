/**
 * How the 480p proxy is made: the ffmpeg arguments for each way of decoding and
 * scaling, and the order the ways are tried in. Pure, so it is tested without
 * running ffmpeg; `toLowResolution` runs what this plans.
 *
 * Measured on an M1 Pro (docs/import-speed-investigation.md):
 *   software decode   4K60 HEVC 1.0x real time, 4K30 1.4-3.1x
 *   hardware decode   2.2x faster than software for 4K60, 25 % for 4K30
 *   + GPU scaling     another 20-25 %, 14 s instead of 40 s per 40 s of 4K60
 * The old comment that hardware decode is slower once frames are dropped was
 * disproved at 4K.
 */

/** gpu: VideoToolbox decode, scale on the GPU. hardware: VideoToolbox decode, scale on the CPU. software: nothing on the GPU. */
export type ProxyMode = 'gpu' | 'hardware' | 'software'

/** A proxy for scrubbing, thumbnails and scene detection never needs more than this. */
export const PROXY_MAX_FPS = 30

export interface ProxyPlanInput {
	isMac: boolean
	/** WebM sources are re-encoded as VP9 in software. */
	isWebm: boolean
	sourceFps?: number
	/** The file carries a rotation tag (a phone held upright). */
	rotated?: boolean
}

/**
 * The ways to make this proxy, fastest first. Each later one is the fallback
 * for the one before: a source the GPU path rejects still gets a hardware
 * decode, and one the hardware rejects still gets made in software.
 */
export function proxyModes({ isMac, isWebm, rotated }: ProxyPlanInput): ProxyMode[] {
	if (!isMac || isWebm) return ['software']
	// The GPU scaler ignores a rotation tag and would make a sideways proxy
	// without saying so (measured: a portrait clip came out 854x480, not 270x480).
	// The CPU scaler turns it upright, so a rotated source keeps that.
	return rotated ? ['hardware', 'software'] : ['gpu', 'hardware', 'software']
}

/** ffmpeg options for one way of making the proxy. */
export function proxyArgs(mode: ProxyMode, { isMac, isWebm, sourceFps }: ProxyPlanInput): { input: string[]; output: string[] } {
	// Cap fps only when the source is above the ceiling: applying it to a
	// <=30 fps source would DUPLICATE frames (slower and larger), not drop any.
	const capFps = !!sourceFps && sourceFps > PROXY_MAX_FPS
	const input: string[] = []
	const output: string[] = []

	if (mode === 'gpu') {
		input.push('-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld')
		// The fps filter cannot read GPU frames; -r drops them at the output instead.
		output.push('-vf', 'scale_vt=w=-2:h=480')
		if (capFps) output.push('-r', String(PROXY_MAX_FPS))
	} else {
		if (mode === 'hardware') input.push('-hwaccel', 'videotoolbox')
		output.push('-vf', capFps ? `fps=${PROXY_MAX_FPS},scale=-2:480` : 'scale=-2:480')
	}

	if (isWebm) {
		output.push('-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '0', '-row-mt', '1', '-b:v', '1M')
	} else if (isMac) {
		output.push('-c:v', 'h264_videotoolbox', '-b:v', '2M', '-realtime', 'true', '-threads', '0')
	} else {
		output.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-tune', 'fastdecode', '-threads', '0')
	}
	return { input, output }
}

/** How many proxies may be made at once: hardware ones share the video chip (2 is the most that helps), software ones all use the CPU. */
export const MAX_HARDWARE_PROXIES = 2
export const MAX_SOFTWARE_PROXIES = 1
