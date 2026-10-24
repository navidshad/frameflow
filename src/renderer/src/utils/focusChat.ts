/**
 * Put the cursor in the chat of the page that just opened. The chat input is a
 * textarea that mounts after the project has loaded, and it lives in a
 * different component on each road, so wait for the first visible one rather
 * than reaching into either page. Gives up quietly: focus is a courtesy.
 */
export function focusChatSoon(timeoutMs = 4000): void {
	const started = Date.now()
	const tick = () => {
		const box = Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea'))
			.find((t) => !t.disabled && t.offsetParent !== null)
		if (box) { box.focus(); return }
		if (Date.now() - started < timeoutMs) setTimeout(tick, 100)
	}
	setTimeout(tick, 150)
}
