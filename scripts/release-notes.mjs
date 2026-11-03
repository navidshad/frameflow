#!/usr/bin/env node
/**
 * Release notes for a tag, with the UI screenshots that go with them.
 *
 *   node scripts/release-notes.mjs v1.2.0              # print the notes
 *   node scripts/release-notes.mjs v1.2.0 --scaffold   # write docs/releases/v1.2.0.md
 *
 * Two sources, in order:
 *
 *   1. docs/releases/<tag>.md — written by hand (or scaffolded, then edited),
 *      with its pictures in docs/releases/<tag>/. This is the good path: a
 *      release that changed the UI should show the UI.
 *   2. The commit log since the previous tag, grouped by conventional-commit
 *      prefix. The fallback, so a release is never blocked on prose.
 *
 * Images are referenced RELATIVELY in the markdown (so they preview in the
 * repo) and rewritten here to raw.githubusercontent.com URLs pinned to the tag.
 * A release body is rendered away from the repo, where a relative path goes
 * nowhere. Pinning to the tag, not main, keeps old releases' pictures stable.
 * It also means the images must be committed BEFORE the tag is pushed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = process.env.GITHUB_REPOSITORY || 'navidshad/frameflow'

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()

// ===== Commit classification =====

/**
 * Decide how one commit subject appears in the fallback notes.
 *
 * Return `{ section, text }` to list it under that heading, or `null` to leave
 * it out. Only what a user of the app would notice is listed: feat, fix, perf.
 * docs/chore/ci/test/refactor and subjects without a conventional prefix (merge
 * and release-bump commits) are dropped. The scope becomes a bold lead-in.
 */
const ACRONYMS = new Set(['mcp', 'ui', 'ai', 'cli'])

function classify(subject) {
	const m = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
	if (!m) return null
	const [, type, scope, text] = m
	const section = { feat: 'New', fix: 'Fixed', perf: 'Faster' }[type]
	if (!section) return null
	const label = scope ? `**${ACRONYMS.has(scope) ? scope.toUpperCase() : scope[0].toUpperCase() + scope.slice(1)}:** ` : ''
	return { section, text: label + text }
}

// ===== Notes =====

function previousTag(tag) {
	const tags = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n').filter(Boolean)
	const at = tags.indexOf(tag)
	// Tag not created yet (a scaffold before tagging): everything since the newest one.
	return at === -1 ? tags[0] : tags[at + 1]
}

function fromCommits(tag) {
	const prev = previousTag(tag)
	const range = prev ? `${prev}..${git('tag', '--list', tag) ? tag : 'HEAD'}` : 'HEAD'
	const subjects = git('log', '--no-merges', '--format=%s', range).split('\n').filter(Boolean)

	const sections = new Map()
	for (const subject of subjects) {
		const entry = classify(subject)
		if (!entry) continue
		if (!sections.has(entry.section)) sections.set(entry.section, [])
		sections.get(entry.section).push(entry.text)
	}
	const ORDER = ['New', 'Fixed', 'Faster']
	const ordered = [...sections].sort((x, y) => ORDER.indexOf(x[0]) - ORDER.indexOf(y[0]))
	const body = ordered.map(([name, items]) => `## ${name}\n${items.map((i) => `- ${i}`).join('\n')}`)
	return body.join('\n\n') || 'Maintenance release.'
}

function pinImages(markdown, tag) {
	const base = `https://raw.githubusercontent.com/${REPO}/${tag}/`
	// ![alt](docs/releases/...) — only repo-relative paths; absolute URLs stay.
	return markdown.replace(/(!\[[^\]]*\]\()(?!https?:|\/)([^)\s]+)(\))/g, `$1${base}$2$3`)
}

function withFooter(markdown, tag) {
	return `${markdown.trim()}\n\n---\nInstallers are attached below. Full changelog: https://github.com/${REPO}/commits/${tag}\n`
}

// ===== CLI =====

const [tag, flag] = process.argv.slice(2)
if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
	console.error('usage: release-notes.mjs vX.Y.Z [--scaffold]')
	process.exit(2)
}

const notesPath = join(ROOT, 'docs', 'releases', `${tag}.md`)

if (flag === '--scaffold') {
	if (existsSync(notesPath)) {
		console.error(`${notesPath} already exists; not overwriting.`)
		process.exit(1)
	}
	mkdirSync(join(ROOT, 'docs', 'releases', tag), { recursive: true })
	writeFileSync(
		notesPath,
		`# FrameFlow ${tag.slice(1)}\n\n${fromCommits(tag)}\n\n## Screenshots\n\n` +
			`<!-- Capture with: node scripts/drive.mjs shot docs/releases/${tag}/<name>.png -->\n` +
			`![Describe the screen](docs/releases/${tag}/<name>.png)\n`,
	)
	console.log(`Wrote ${notesPath}\nEdit it, add the images, commit, then tag.`)
} else if (existsSync(notesPath)) {
	process.stdout.write(withFooter(pinImages(readFileSync(notesPath, 'utf8'), tag), tag))
} else {
	process.stdout.write(withFooter(fromCommits(tag), tag))
}
