#!/usr/bin/env node
/**
 * vue-tsc over the renderer, reporting only errors in files this project owns.
 *
 * Why this wrapper exists: pilotui ships no .d.ts at all. Its package `exports`
 * point `types` at raw source (node_modules/pilotui/src/**), so vue-tsc has to
 * compile the library's own .vue implementation to derive types — and reports
 * that implementation's internal type errors as part of our build. TypeScript's
 * `skipLibCheck` does not help, because that only covers .d.ts files.
 *
 * We cannot fix a dependency's source, and 1.29.1 is the latest release. So this
 * gates on our code and lets a third party's type debt through. Any error under
 * src/ still fails the build; a vue-tsc crash still fails the build.
 *
 * Delete this wrapper and go back to plain `vue-tsc` if pilotui ever ships
 * declarations.
 */
import { spawnSync } from 'node:child_process'

const DIAGNOSTIC = /^\S.*\(\d+,\d+\): (?:error|warning) TS\d+:/
const ERROR_DIAGNOSTIC = /^\S.*\(\d+,\d+\): error TS\d+:/

const result = spawnSync('vue-tsc', ['-p', 'tsconfig.web.json', '--noEmit', '--pretty', 'false'], {
	encoding: 'utf8',
	shell: true
})

const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
const lines = raw.split('\n')

// tsc prints `path(line,col): error TSxxxx: msg`, sometimes followed by indented
// continuation lines. Drop a node_modules diagnostic together with its block.
const kept = []
let dropping = false
for (const line of lines) {
	if (DIAGNOSTIC.test(line)) {
		dropping = line.startsWith('node_modules/')
		if (!dropping) kept.push(line)
		continue
	}
	if (dropping && /^\s/.test(line)) continue
	dropping = false
	kept.push(line)
}

const ourErrors = kept.filter((line) => ERROR_DIAGNOSTIC.test(line))
const output = kept.join('\n').trim()
if (output) console.log(output)

if (ourErrors.length > 0) {
	console.error(`\n${ourErrors.length} type error(s) in project source.`)
	process.exit(1)
}

if (result.status !== 0) {
	const suppressed = lines.filter(
		(line) => line.startsWith('node_modules/') && ERROR_DIAGNOSTIC.test(line)
	).length

	if (suppressed > 0) {
		console.log(
			`Project source is clean. Suppressed ${suppressed} type error(s) inside ` +
				`node_modules — see scripts/typecheck-web.mjs.`
		)
		process.exit(0)
	}

	// Non-zero for a reason we did not recognise (crash, bad config). Surface it.
	console.error(raw)
	process.exit(result.status ?? 1)
}
