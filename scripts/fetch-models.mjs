#!/usr/bin/env node
/**
 * Fetches the pinned vision models for object tracking into vendor/models/.
 *
 * The models are data, not code: ONNX graphs run by onnxruntime-node. They are
 * not npm packages and they are too large for git (the face matcher is 38 MB),
 * so they are fetched the way FFmpeg is: from an immutable address, checked
 * against a sha256 in scripts/models-manifest.json, and refused on a mismatch.
 * Each model's licence file is fetched beside it and ships with it.
 *
 *   node scripts/fetch-models.mjs                 install what is missing
 *   node scripts/fetch-models.mjs --verify-only   re-check what is installed (CI gate)
 *   node scripts/fetch-models.mjs --print-hashes  download + print sha256, for bumping
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'models')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'models-manifest.json'), 'utf8'))

const argv = process.argv.slice(2)
const VERIFY_ONLY = argv.includes('--verify-only')
const PRINT_HASHES = argv.includes('--print-hashes')

const log = (msg) => console.log(`[models] ${msg}`)
const die = (msg) => {
	console.error(`\n[models] ERROR: ${msg}\n`)
	process.exit(1)
}
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const urlOf = (repoPath) => `${MANIFEST.repo}/raw/${MANIFEST.commit}/${repoPath}`

async function download(url, to) {
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok) die(`${url} answered ${res.status}`)
	const tmp = `${to}.part`
	fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()))
	fs.renameSync(tmp, to)
}

fs.mkdirSync(VENDOR, { recursive: true })
const provenance = [`Vision models from ${MANIFEST.repo} at commit ${MANIFEST.commit}`, '']

for (const model of MANIFEST.models) {
	const file = path.join(VENDOR, model.file)
	const licence = path.join(VENDOR, `${model.file}.LICENSE.txt`)
	const have = fs.existsSync(file) ? sha256(file) : null

	if (VERIFY_ONLY) {
		if (have !== model.sha256) die(`${model.file} is ${have ? 'not the pinned file' : 'missing'}. Run node scripts/fetch-models.mjs.`)
		if (!fs.existsSync(licence)) die(`${model.file} has no licence file beside it.`)
		log(`${model.file} ok`)
		continue
	}
	if (have !== model.sha256 || PRINT_HASHES) {
		log(`fetching ${model.file} (${model.use})`)
		await download(urlOf(model.path), file)
		const got = sha256(file)
		if (PRINT_HASHES) log(`${model.file} sha256 ${got}`)
		else if (got !== model.sha256) {
			fs.rmSync(file, { force: true })
			die(`${model.file} does not match its pinned sha256.\n  expected ${model.sha256}\n  got      ${got}`)
		}
	}
	if (!fs.existsSync(licence)) await download(urlOf(model.licensePath), licence)
	provenance.push(`${model.file}  ${model.use}`, `  source:  ${urlOf(model.path)}`, `  sha256:  ${model.sha256}`, `  licence: ${model.license} (${model.file}.LICENSE.txt)`, '')
}

if (!VERIFY_ONLY) {
	fs.writeFileSync(path.join(VENDOR, 'PROVENANCE.txt'), provenance.join('\n'))
	log(`ready in ${path.relative(ROOT, VENDOR)}`)
}
