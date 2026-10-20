import { app } from 'electron'
import fs from 'fs'
import { probeMotionPage, type MotionProbeInput } from '../probe'

/**
 * A minimal Electron main that runs the determinism probe on some pages and
 * exits — the same trick as render-harness.ts, around the production
 * `probeMotionPage`.
 *
 *   electron probe-harness.cjs <inputs.json>
 *
 * Prints one `FRAMEFLOW_RESULT {json}` line: a result per input, in order.
 */
const inputsFile = process.argv[process.argv.length - 1]

app.dock?.hide()
app.on('window-all-closed', () => { /* stay alive between probes */ })

app.whenReady().then(async () => {
	const inputs = JSON.parse(fs.readFileSync(inputsFile, 'utf8')) as MotionProbeInput[]
	const results = []
	for (const input of inputs) results.push(await probeMotionPage(input))
	process.stdout.write(`FRAMEFLOW_RESULT ${JSON.stringify(results)}\n`)
	app.exit(0)
}).catch((error) => {
	process.stderr.write(`FRAMEFLOW_ERROR ${error?.stack || error}\n`)
	app.exit(1)
})
