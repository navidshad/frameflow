/**
 * "About 12 min left", "About 40 s left": the time left in words, rounded so it
 * does not twitch. With a `spread` (a share of the time left: 0.3 is plus or
 * minus 30%) of 0.1 or more it is a range, "About 8 to 14 min left": the time
 * left is a guess and is shown as one.
 */
export function formatEta(sec: number | null | undefined, spread = 0): string {
	if (sec == null) return ''
	if (sec < 10) return 'Almost done'
	if (sec < 60) return `About ${Math.round(sec / 5) * 5} s left`
	if (spread >= 0.1) {
		const low = Math.max(1, Math.round((sec * (1 - spread)) / 60))
		const high = Math.max(low, Math.round((sec * (1 + spread)) / 60))
		if (high < 60 && high > low) return `About ${low} to ${high} min left`
		if (high >= 60 && high > low) return `About ${hoursText(low)} to ${hoursText(high)} left`
	}
	const minutes = Math.round(sec / 60)
	if (minutes < 60) return `About ${minutes} min left`
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest ? `About ${hours} h ${rest} min left` : `About ${hours} h left`
}

/** 45 min, 1 h 20 min: one side of a range that reaches past an hour. */
function hoursText(minutes: number): string {
	if (minutes < 60) return `${minutes} min`
	const h = Math.floor(minutes / 60)
	const m = minutes % 60
	return m ? `${h} h ${m} min` : `${h} h`
}
