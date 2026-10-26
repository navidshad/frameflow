/** Human sizes for the Exports list: 2.6 GB, 340 MB, 12 KB. */
export function formatFileSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return ''
	const units = ['B', 'KB', 'MB', 'GB', 'TB']
	let value = bytes
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1024
		unit++
	}
	// One decimal for the big units, none once the number is already 3 digits.
	const text = unit === 0 || value >= 100 ? String(Math.round(value)) : value.toFixed(1)
	return `${text.replace(/\.0$/, '')} ${units[unit]}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "just now", "12m ago", "3h ago", "Yesterday", "4d ago", then a calendar date
 * ("Oct 12", with the year once it is not this year's).
 */
export function formatExportDate(timestamp: number, now: number = Date.now()): string {
	const minutes = Math.floor((now - timestamp) / 60000)
	if (minutes < 1) return 'just now'
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const then = new Date(timestamp)
	const today = new Date(now)
	const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
	const days = Math.round((startOf(today) - startOf(then)) / 86400000)
	if (days === 1) return 'Yesterday'
	if (days < 7) return `${days}d ago`
	const date = `${MONTHS[then.getMonth()]} ${then.getDate()}`
	return then.getFullYear() === today.getFullYear() ? date : `${date}, ${then.getFullYear()}`
}
