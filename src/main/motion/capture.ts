import { BrowserWindow, session, type Session } from 'electron'
import type { MotionFrameState } from '@shared/motion'

/**
 * Draws a motion page frame by frame in a hidden window and hands back pixels.
 *
 * ## Why a hidden window and not an offscreen one
 *
 * Measured on Electron 44 rather than assumed. An OFFSCREEN (`offscreen: true`)
 * window rasterises at 1× but `capturePage()` returns that raster bilinearly
 * UPSCALED to the display's scale factor — a 1-px hairline came back as
 * 58,221,221,58 — and its `paint` event, which does carry the true 1× raster,
 * delivered a stale frame on 12–17% of seeks however the handshake was
 * arranged. `deviceScaleFactor` on the offscreen options is ignored.
 *
 * A normal window that is never shown, with `zoomFactor = 1 / devicePixelRatio`
 * and its content size divided by the same, lays the page out at exactly the
 * sequence's W×H CSS pixels AND rasterises it at exactly W×H device pixels:
 * the same hairline comes back as a single 255. `capturePage` was fresh on
 * every one of the seeks tested. Transparency survives (premultiplied — see
 * `unpremultiplyBgra`).
 *
 * ## Lockdown
 *
 * The page is untrusted (an agent may have written it): sandboxed renderer, no
 * Node, context isolation, no preload, its own in-memory session that cancels
 * every request that is not the page's own data: URL, no navigation, no new
 * windows, no permissions. The page's CSP says the same thing a second time.
 */

const PARTITION = 'frameflow-motion-capture'
let lockedSession: Session | null = null

function captureSession(): Session {
	if (lockedSession) return lockedSession
	const s = session.fromPartition(PARTITION, { cache: false })
	s.webRequest.onBeforeRequest((details, callback) => {
		callback({ cancel: !details.url.startsWith('data:') })
	})
	s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
	s.setPermissionCheckHandler(() => false)
	lockedSession = s
	return s
}

export interface MotionCapture {
	/** Draw one instant and return it as premultiplied BGRA, width × height × 4. */
	frame(state: MotionFrameState): Promise<Buffer>
	close(): void
}

const READY_TIMEOUT_MS = 10_000
const FRAME_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms) })
	]).finally(() => clearTimeout(timer))
}

export async function openMotionCapture(
	html: string,
	frame: { width: number; height: number }
): Promise<MotionCapture> {
	const { width, height } = frame
	const win = new BrowserWindow({
		width, height,
		show: false,
		transparent: true,
		frame: false,
		hasShadow: false,
		useContentSize: true,
		enableLargerThanScreen: true,
		paintWhenInitiallyHidden: true,
		skipTaskbar: true,
		focusable: false,
		backgroundColor: '#00000000',
		webPreferences: {
			session: captureSession(),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webSecurity: true,
			backgroundThrottling: false,
			spellcheck: false
		}
	})
	const contents = win.webContents
	contents.setWindowOpenHandler(() => ({ action: 'deny' }))
	contents.on('will-navigate', (event) => event.preventDefault())
	contents.setAudioMuted(true)

	let crashed: string | null = null
	contents.on('render-process-gone', (_event, details) => { crashed = details.reason })

	const close = () => { if (!win.isDestroyed()) win.destroy() }

	try {
		await contents.loadURL(`data:text/html;base64,${Buffer.from(html, 'utf8').toString('base64')}`)

		// Layout at W×H CSS px, raster at W×H device px — see the header.
		// The display's scale, NOT the page's devicePixelRatio: Chromium keeps
		// zoom per origin across a session, so a second capture window opens
		// already zoomed and its dpr reads 1 on a 2× screen.
		const dpr = Number(await contents.executeJavaScript('window.devicePixelRatio')) || 1
		const scale = dpr / (contents.getZoomFactor() || 1)
		contents.setZoomFactor(1 / scale)
		win.setContentSize(Math.round(width / scale), Math.round(height / scale))
		await withTimeout(
			contents.executeJavaScript('window.frameflow ? window.frameflow.ready : Promise.reject(new Error("no runtime"))'),
			READY_TIMEOUT_MS,
			'The motion page never called frameflow.define(), so it cannot be rendered.'
		)
		// The resize and the zoom land asynchronously and independently — read
		// once and the page may have one but not the other (it was seen at 2×
		// and at ½× in the same run). Wait for the layout to settle on W×H.
		let viewport: number[] = []
		for (let attempt = 0; attempt < 100; attempt++) {
			// Plain reads: the runtime has already swapped the page's own
			// requestAnimationFrame for a no-op, so nothing here may wait on it.
			viewport = await contents.executeJavaScript('[window.innerWidth, window.innerHeight]') as number[]
			if (viewport[0] === width && viewport[1] === height) break
			await new Promise((r) => setTimeout(r, 20))
		}
		if (viewport[0] !== width || viewport[1] !== height) {
			throw new Error(`Motion page laid out at ${viewport.join('×')} instead of ${width}×${height}.`)
		}
	} catch (error) {
		close()
		throw error
	}

	return {
		async frame(state) {
			if (crashed) throw new Error(`The motion page crashed (${crashed}).`)
			const call = `window.frameflow.__seek(${JSON.stringify(state.t)}, ${JSON.stringify(state.settings)}, ${JSON.stringify(state.opacity)}, false).then(function () { return 0 })`
			await withTimeout(contents.executeJavaScript(call), FRAME_TIMEOUT_MS, 'The motion page stopped responding.')
			let image = await contents.capturePage(undefined, { stayHidden: true })
			const size = image.getSize()
			if (size.width !== width || size.height !== height) {
				// A fractional scale factor (1.25, 1.5) cannot divide the window
				// exactly. Resample rather than fail; on 1× and 2× displays this
				// branch never runs.
				image = image.resize({ width, height, quality: 'best' })
			}
			return image.toBitmap()
		},
		close
	}
}
