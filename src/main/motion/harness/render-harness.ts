import { app } from 'electron'
import fs from 'fs'
import { renderMotionClip, type MotionJob } from '../index'

/**
 * A minimal Electron main that renders motion jobs and exits.
 *
 * vitest runs in Node and cannot host a BrowserWindow, so the motion test
 * bundles THIS file (with the real capture and encode modules inside it) and
 * spawns the real Electron binary on it. Nothing here is a stand-in: it is the
 * exact `renderMotionClip` the export calls.
 *
 *   electron render-harness.cjs <jobs.json>
 *
 * Prints one `FRAMEFLOW_RESULT {json}` line on success.
 */
const jobsFile = process.argv[process.argv.length - 1]

app.dock?.hide()
app.on('window-all-closed', () => { /* stay alive between jobs */ })

app.whenReady().then(async () => {
	const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8')) as MotionJob[]
	const timings: number[] = []
	for (const job of jobs) {
		const started = Date.now()
		await renderMotionClip(job)
		timings.push(Date.now() - started)
	}
	process.stdout.write(`FRAMEFLOW_RESULT ${JSON.stringify({ timings })}\n`)
	app.exit(0)
}).catch((error) => {
	process.stderr.write(`FRAMEFLOW_ERROR ${error?.stack || error}\n`)
	app.exit(1)
})
