/**
 * Scene-detection sensitivity, decoupled from whichever detector is behind it.
 *
 * The UI speaks in sensitivity (1 = only obvious cuts, 10 = split eagerly). The
 * main process converts that to the detector's native threshold. Previously the
 * slider exposed PySceneDetect's raw content threshold (5..60, default 27), which
 * meant swapping detectors silently changed what every position on the slider
 * meant. Keep the scale here and the UI never has to know.
 */

export const SCENE_SENSITIVITY_MIN = 1
export const SCENE_SENSITIVITY_MAX = 10
export const SCENE_SENSITIVITY_DEFAULT = 5

/**
 * Threshold at the least-sensitive end, on FFmpeg `scdet`'s 0..100 scale, and
 * the per-step falloff.
 *
 * Calibrated against PySceneDetect `detect-content -t 27` — the exact command the
 * old implementation ran — over three CC-BY Blender clips, measuring scene counts:
 *
 *   sens  thresh   sintel-480  sintel-720  bbb-480   |error|
 *   GT    (t=27)   11          10          16        —
 *   1     15        5           5          14        13
 *   3      9.6      7           7          15         8
 *   5      6.1      8           8          17         6   <- default
 *   8      3.1     11          11          20         5
 *   10     2       16          16          22        17
 *
 * The default sits at the low point of the error curve while leaving usable range
 * either side. Parity is approximate by construction: `scdet` scores luma where
 * PySceneDetect scored HSV. PySceneDetect is not even self-consistent here — it
 * reports 11 scenes at 480p and 10 at 720p on identical footage.
 *
 * To re-calibrate against different material, run
 * `src/main/scenedetect/dump-scenes.ts` over it and adjust the constant below.
 */
const THRESHOLD_AT_MIN_SENSITIVITY = 15
const FALLOFF_PER_STEP = 0.8

/** Clamp to the supported range, tolerating junk from IPC. */
export function clampSensitivity(value: number | undefined): number {
	if (!Number.isFinite(value)) return SCENE_SENSITIVITY_DEFAULT
	return Math.min(SCENE_SENSITIVITY_MAX, Math.max(SCENE_SENSITIVITY_MIN, Math.round(value as number)))
}

/**
 * Sensitivity (1..10) -> scdet threshold (0..100). Higher sensitivity means a
 * lower threshold, so more cuts survive. Geometric rather than linear: the
 * interesting band is compressed near the low end.
 */
export function sensitivityToScdetThreshold(sensitivity: number | undefined): number {
	const s = clampSensitivity(sensitivity)
	const threshold = THRESHOLD_AT_MIN_SENSITIVITY * Math.pow(FALLOFF_PER_STEP, s - 1)
	return Math.round(threshold * 10) / 10
}
