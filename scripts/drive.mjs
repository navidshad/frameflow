#!/usr/bin/env node
/**
 * Drive the running app over the Chrome DevTools Protocol.
 *
 * Every UI defect in this project so far has been found by hand, in use, one
 * round trip at a time — because nothing could see the renderer. `npm run
 * start:debug` has always opened a CDP port; this is the other half.
 *
 * No dependency: Node 22 has a global `WebSocket`, and CDP is a WebSocket
 * carrying JSON. Playwright would do the same thing with 300MB of browsers we
 * do not need — the app IS the browser.
 *
 *   npm run start:debug &            # once, leaves the app running
 *   node scripts/drive.mjs shot /tmp/app.png
 *   node scripts/drive.mjs eval "document.title"
 *   node scripts/drive.mjs text ".inspector"
 *   node scripts/drive.mjs click "button[title^='Captions']"
 *   node scripts/drive.mjs drag "#effect-warm" "#clip-abc"
 *
 * `eval` prints JSON, so assertions are just shell: run a query, read the
 * answer. Screenshots are written as PNG and meant to be looked at.
 */

const PORT = process.env.CDP_PORT || 9222
const HOST = `http://127.0.0.1:${PORT}`

// ===== Transport =====

async function pageTarget() {
	let targets
	try {
		targets = await fetch(`${HOST}/json`).then((r) => r.json())
	} catch {
		fail(`No debugger on ${HOST}. Start the app first:\n\n  npm run start:debug\n`)
	}
	// Electron lists the renderer as a page; devtools windows are 'other'.
	// Not a motion capture window: those are pages too, on a data: URL, and
	// exist only while an export renders a motion layer.
	const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('data:'))
	if (!page) fail(`No page target. Targets:\n${targets.map((t) => `  ${t.type} ${t.url}`).join('\n')}`)
	return page
}

/** One connection, many commands, closed when the caller is done. */
async function connect() {
	const target = await pageTarget()
	const socket = new WebSocket(target.webSocketDebuggerUrl)
	const pending = new Map()
	let nextId = 1

	await new Promise((resolve, reject) => {
		socket.addEventListener('open', resolve, { once: true })
		socket.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true })
	})

	socket.addEventListener('message', (event) => {
		const message = JSON.parse(event.data)
		const waiter = pending.get(message.id)
		if (!waiter) return // an event, not a reply
		pending.delete(message.id)
		if (message.error) waiter.reject(new Error(`${message.error.message} (${message.method})`))
		else waiter.resolve(message.result)
	})

	const send = (method, params = {}) => {
		const id = nextId++
		socket.send(JSON.stringify({ id, method, params }))
		return new Promise((resolve, reject) => {
			// Cleared on reply: a live timer kept every run alive for 30s after
			// it had already printed its answer.
			const timer = setTimeout(() => {
				if (pending.delete(id)) reject(new Error(`${method} timed out`))
			}, 30_000)
			pending.set(id, {
				resolve: (v) => { clearTimeout(timer); resolve(v) },
				reject: (e) => { clearTimeout(timer); reject(e) },
				method
			})
		})
	}

	return { send, url: target.url, close: () => socket.close() }
}

/**
 * Evaluate in the page and return the VALUE, not a remote handle.
 *
 * `awaitPromise` so an expression can await Vue's nextTick; `returnByValue` so
 * the result comes back as JSON rather than an object id we would have to
 * fetch separately.
 */
async function evaluate(cdp, expression) {
	const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
		expression: `(async () => { return (${expression}) })()`,
		awaitPromise: true,
		returnByValue: true,
		userGesture: true
	})
	if (exceptionDetails) {
		throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
	}
	return result.value
}

// ===== Page helpers, as expressions =====

/** Centre of an element in viewport coordinates, or null if it is not there. */
const centreOf = (selector) => `(() => {
	const el = document.querySelector(${JSON.stringify(selector)})
	if (!el) return null
	const r = el.getBoundingClientRect()
	if (!r.width || !r.height) return null
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`

/**
 * A synthetic HTML5 drag, which CDP's Input domain cannot do.
 *
 * Chromium builds a real `DataTransfer` here, so the app's own dragstart
 * handler fills it and the drop handler reads it back — the two-MIME-type
 * dance the editor relies on works exactly as it does for a human.
 */
const dragExpr = (from, to) => `(() => {
	const src = document.querySelector(${JSON.stringify(from)})
	const dst = document.querySelector(${JSON.stringify(to)})
	if (!src) return { ok: false, error: 'no source: ' + ${JSON.stringify(from)} }
	if (!dst) return { ok: false, error: 'no target: ' + ${JSON.stringify(to)} }
	const data = new DataTransfer()
	const at = (el) => {
		const r = el.getBoundingClientRect()
		return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
	}
	const fire = (el, type, point) => el.dispatchEvent(new DragEvent(type, {
		bubbles: true, cancelable: true, composed: true, dataTransfer: data, ...point
	}))
	fire(src, 'dragstart', at(src))
	fire(dst, 'dragenter', at(dst))
	fire(dst, 'dragover', at(dst))
	const dropped = !fire(dst, 'drop', at(dst))
	fire(src, 'dragend', at(src))
	// A handled drop calls preventDefault, so "was cancelled" IS "was accepted".
	return { ok: dropped }
})()`

// ===== Commands =====

const COMMANDS = {
	/** Write a PNG of the window. The point of the whole script. */
	async shot(cdp, [file = 'shot.png']) {
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
		const { writeFileSync } = await import('node:fs')
		writeFileSync(file, Buffer.from(data, 'base64'))
		return file
	},

	/** Evaluate an expression and print its value as JSON. */
	async eval(cdp, args) {
		return await evaluate(cdp, args.join(' '))
	},

	/** innerText of the first match — the cheapest assertion there is. */
	async text(cdp, [selector]) {
		return await evaluate(cdp, `document.querySelector(${JSON.stringify(selector)})?.innerText ?? null`)
	},

	/** How many elements match. Useful for "did the list grow". */
	async count(cdp, [selector]) {
		return await evaluate(cdp, `document.querySelectorAll(${JSON.stringify(selector)}).length`)
	},

	/**
	 * A real mouse click at the element's centre, through the Input domain —
	 * not `el.click()`, so hover states, pointer capture and the timeline's
	 * pointerdown/move/up drags all behave as they do for a person.
	 */
	async click(cdp, [selector]) {
		const point = await evaluate(cdp, centreOf(selector))
		if (!point) throw new Error(`Not visible: ${selector}`)
		for (const type of ['mousePressed', 'mouseReleased']) {
			await cdp.send('Input.dispatchMouseEvent', {
				type, x: point.x, y: point.y, button: 'left', clickCount: 1
			})
		}
		return point
	},

	/** Type into whatever has focus. Click the field first. */
	async type(cdp, args) {
		const value = args.join(' ')
		for (const char of value) {
			await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: char })
		}
		return value
	},

	async key(cdp, [key]) {
		const codes = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8 }
		for (const type of ['keyDown', 'keyUp']) {
			await cdp.send('Input.dispatchKeyEvent', {
				type, key, windowsVirtualKeyCode: codes[key], nativeVirtualKeyCode: codes[key]
			})
		}
		return key
	},

	/** Drag one element onto another via real DragEvents. */
	async drag(cdp, [from, to]) {
		return await evaluate(cdp, dragExpr(from, to))
	},

	/**
	 * A real POINTER drag: press, move in steps, release — through the Input
	 * domain, so pointer capture, `setPointerCapture` and the timeline's
	 * pointerdown/move/up state machine all behave as they do for a person.
	 *
	 *   node scripts/drive.mjs pointer-drag 175 597 300 748
	 *
	 * Not the same thing as `drag`, which fires HTML5 DragEvents, and not the
	 * same as dispatching pointer events from page script: those skip capture
	 * entirely and will happily "pass" a gesture that is broken in the app.
	 */
	async pointerDrag(cdp, [fromX, fromY, toX, toY, steps = '14']) {
		const [x0, y0, x1, y1, n] = [fromX, fromY, toX, toY, steps].map(Number)
		const move = (x, y, extra) => cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseMoved', x, y, button: 'none', buttons: 1, ...extra
		})
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1
		})
		for (let i = 1; i <= n; i++) {
			await move(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)
			await new Promise((r) => setTimeout(r, 25))
		}
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1
		})
		await new Promise((r) => setTimeout(r, 300))
		return { from: [x0, y0], to: [x1, y1], steps: n }
	},

	/**
	 * Hold a drag still at a point for a while — what an auto-scroll needs, since
	 * a stationary pointer fires no further move events.
	 *
	 *   node scripts/drive.mjs pointer-hold 175 597 300 740 2000
	 */
	async pointerHold(cdp, [fromX, fromY, toX, toY, ms = '1500']) {
		const [x0, y0, x1, y1, hold] = [fromX, fromY, toX, toY, ms].map(Number)
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1
		})
		for (let i = 1; i <= 8; i++) {
			await cdp.send('Input.dispatchMouseEvent', {
				type: 'mouseMoved', button: 'none', buttons: 1,
				x: x0 + ((x1 - x0) * i) / 8, y: y0 + ((y1 - y0) * i) / 8
			})
			await new Promise((r) => setTimeout(r, 25))
		}
		await new Promise((r) => setTimeout(r, hold))
		await cdp.send('Input.dispatchMouseEvent', {
			type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1
		})
		await new Promise((r) => setTimeout(r, 300))
		return { heldAt: [x1, y1], ms: hold }
	},

	/** Console errors since the page loaded — cheap smoke test after a change. */
	async errors(cdp) {
		return await evaluate(cdp, `window.__driveErrors ?? 'not installed — run: drive.mjs watch'`)
	},

	/** Start recording console errors so a later `errors` call can report them. */
	async watch(cdp) {
		return await evaluate(cdp, `(() => {
			if (window.__driveErrors) return 'already watching'
			window.__driveErrors = []
			const original = console.error
			console.error = (...a) => { window.__driveErrors.push(a.map(String).join(' ')); original(...a) }
			window.addEventListener('error', (e) => window.__driveErrors.push('uncaught: ' + e.message))
			window.addEventListener('unhandledrejection', (e) => window.__driveErrors.push('unhandled: ' + e.reason))
			return 'watching'
		})()`)
	},

	/** Wait until an expression is truthy, or give up. */
	async until(cdp, args) {
		const expression = args.join(' ')
		const deadline = Date.now() + 15_000
		while (Date.now() < deadline) {
			const value = await evaluate(cdp, expression)
			if (value) return value
			await new Promise((r) => setTimeout(r, 250))
		}
		throw new Error(`Never became true: ${expression}`)
	}
}

// ===== Entry =====

function fail(message) {
	console.error(message)
	process.exit(1)
}

// `pointer-drag` on the command line, `pointerDrag` in the table — one hyphen
// convention for multi-word commands so the shell reads naturally.
const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

const [raw, ...args] = process.argv.slice(2)
const command = raw ? camel(raw) : raw
if (!command || !COMMANDS[command]) {
	const names = Object.keys(COMMANDS).map((n) => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`))
	fail(`usage: drive.mjs <${names.join('|')}> [args]`)
}

const cdp = await connect()
try {
	const result = await COMMANDS[command](cdp, args)
	console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2))
} catch (error) {
	fail(`${command} failed: ${error.message}`)
} finally {
	cdp.close()
}
