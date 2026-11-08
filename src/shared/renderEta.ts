/** "About 12 min left", "About 40 s left": the time left in words, rounded so it does not twitch. */
export function formatEta(sec: number | null | undefined): string {
	if (sec == null) return ''
	if (sec < 10) return 'Almost done'
	if (sec < 60) return `About ${Math.round(sec / 5) * 5} s left`
	const minutes = Math.round(sec / 60)
	if (minutes < 60) return `About ${minutes} min left`
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest ? `About ${hours} h ${rest} min left` : `About ${hours} h left`
}
