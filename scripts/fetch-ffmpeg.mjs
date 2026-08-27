#!/usr/bin/env node
/**
 * Fetches the pinned FFmpeg/FFprobe binaries into vendor/ffmpeg/ and refuses to
 * install any build that is not redistributable.
 *
 * Why this replaced ffmpeg-static / ffprobe-static
 * ------------------------------------------------
 * ffmpeg-static resolved a DIFFERENT upstream per platform and never told you
 * which. Its darwin-arm64 binary was built `--enable-gpl --enable-nonfree`, and
 * a --enable-nonfree build cannot be redistributed AT ALL -- so every macOS
 * Apple Silicon installer this project could have shipped would have been
 * illegal to distribute. The other three platforms happened to be clean. Nothing
 * in the toolchain would ever have told us; it took disassembling the binaries.
 *
 * ffmpeg-static is also unmaintained: npm 5.3.0 is the newest release and it
 * pins FFmpeg 6.1.1, two years and several CVEs behind.
 *
 * The rule this file enforces
 * ---------------------------
 * Licensing varies by platform WITHIN a single builder -- martin-riedl's macOS
 * builds are clean GPL while its Linux builds set --enable-nonfree. So a binary
 * is never trusted because of where it came from. Every binary is checked, on
 * every install, by reading the configure line FFmpeg embeds in its own
 * executable: `--enable-gpl` must be present, `--enable-nonfree` must not be.
 * A failure is fatal, not a warning. That check is the whole point of the file.
 *
 * The check reads bytes rather than running `ffmpeg -version`, because CI
 * cross-builds: the macOS x64 leg runs on an arm64 runner, and no leg can
 * execute another platform's binary.
 *
 * Modes
 * -----
 *   node scripts/fetch-ffmpeg.mjs                 install for the current target
 *   node scripts/fetch-ffmpeg.mjs --verify-only   re-check what is installed (CI gate)
 *   node scripts/fetch-ffmpeg.mjs --print-hashes  download + print sha256, for bumping
 *
 * Target selection honours npm_config_platform / npm_config_arch, which is how
 * the release workflow cross-builds macOS x64 on an arm64 runner. Getting this
 * wrong ships an arm64 ffmpeg inside an x64 app, which fails only at runtime on
 * a user's machine.
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = path.join(ROOT, 'vendor', 'ffmpeg')
const CACHE = path.join(ROOT, 'vendor', '.cache')
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'ffmpeg-manifest.json'), 'utf8'))
const GPL_TEXT = path.join(ROOT, 'build', 'licenses', 'GPL-3.0.txt')

const argv = process.argv.slice(2)
const VERIFY_ONLY = argv.includes('--verify-only')
const PRINT_HASHES = argv.includes('--print-hashes')

const log = (msg) => console.log(`[ffmpeg] ${msg}`)
const die = (msg) => {
	console.error(`\n[ffmpeg] ERROR: ${msg}\n`)
	process.exit(1)
}

/**
 * npm_config_* is set by npm when a consumer requests a specific target; it is
 * what makes `npm_config_arch=x64 npm ci` on an arm64 runner honest.
 */
function resolveTarget() {
	const platform = process.env.npm_config_platform || process.platform
	const arch = process.env.npm_config_arch || process.arch
	const key = `${platform}-${arch}`
	if (!MANIFEST.targets[key]) {
		die(
			`no pinned FFmpeg build for ${key}.\n` +
				`Supported: ${Object.keys(MANIFEST.targets).join(', ')}.\n` +
				`Add one to scripts/ffmpeg-manifest.json -- and verify its licence before you do.`
		)
	}
	return key
}

// --- licence gate ----------------------------------------------------------

/**
 * Pulls the configure line out of an FFmpeg binary.
 *
 * FFmpeg stores it as one NUL-terminated C string, so we find `--enable-gpl`
 * and expand to the string boundaries. Scanned in overlapping chunks to keep a
 * 160MB ffmpeg.exe off the heap; the overlap is far larger than any real
 * configure line, so the string can never straddle a chunk edge undetected.
 */
function readConfigureLine(binaryPath) {
	const CHUNK = 8 * 1024 * 1024
	const OVERLAP = 64 * 1024
	const NEEDLE = Buffer.from('--enable-gpl')
	const fd = fs.openSync(binaryPath, 'r')
	try {
		const size = fs.fstatSync(fd).size
		const buf = Buffer.alloc(Math.min(CHUNK, size))
		// Always advance at least a byte. A file shorter than OVERLAP -- a stub,
		// a truncated download, a text file where a binary should be -- would
		// otherwise drive `pos` negative and throw out of readSync instead of
		// returning null for the caller to report properly.
		const step = Math.max(1, buf.length - OVERLAP)
		let pos = 0
		while (pos < size) {
			const read = fs.readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos)
			if (read <= 0) break
			const slice = buf.subarray(0, read)
			const hit = slice.indexOf(NEEDLE)
			if (hit !== -1) {
				let start = hit
				while (start > 0 && slice[start - 1] !== 0x00) start--
				let end = hit
				while (end < read && slice[end] !== 0x00) end++
				// Some builds embed the line as "%sconfiguration: --prefix=..."
				// inside one string; keep only the flags.
				return slice.subarray(start, end).toString('latin1').replace(/^.*?configuration:\s*/, '')
			}
			if (pos + read >= size) break
			pos += step
		}
	} finally {
		fs.closeSync(fd)
	}
	return null
}

/**
 * THROWS on anything that is not redistributable -- it must not call die(),
 * because die() is process.exit() and try/catch cannot catch that. The install
 * path deliberately catches this to re-fetch a binary that has been swapped
 * under us; --verify-only lets it reach main().catch and become exit 1. An
 * earlier version exited here, which silently dead-ended that recovery.
 *
 * Never downgrade this to a warning: a warning in a postinstall is a warning
 * nobody reads, and the failure mode is shipping a binary we may not ship.
 */
function assertRedistributable(binaryPath) {
	const name = path.basename(binaryPath)
	const cfg = readConfigureLine(binaryPath)
	if (!cfg) {
		throw new Error(`${name}: no FFmpeg configure line found. Not an FFmpeg build, or it is corrupt.`)
	}
	for (const flag of MANIFEST.forbiddenFlags) {
		if (cfg.includes(flag)) {
			throw new Error(
				`${name} is built with ${flag} and CANNOT BE REDISTRIBUTED.\n` +
					`Pin a different build in scripts/ffmpeg-manifest.json.\n` +
					`configure: ${cfg.slice(0, 400)}...`
			)
		}
	}
	for (const flag of MANIFEST.requiredFlags) {
		if (!cfg.includes(flag)) {
			throw new Error(`${name} is missing ${flag}; the encoders this app needs would be absent.`)
		}
	}
	return cfg
}

// --- fetch -----------------------------------------------------------------

const sha256 = (file) => {
	const h = createHash('sha256')
	h.update(fs.readFileSync(file))
	return h.digest('hex')
}

async function download(url, dest) {
	const res = await fetch(url, { redirect: 'follow' })
	if (!res.ok) die(`download failed (HTTP ${res.status}): ${url}`)
	fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()))
}

/**
 * One extractor for three archive shapes. `tar -xf` reads zip as well as
 * tar.xz: bsdtar (macOS, Windows 10+) handles zip natively, and the only
 * tar.xz target is Linux, where GNU tar handles it. That is why nothing here
 * needs `unzip`, which is not installed by default on Windows.
 */
function extractMember(archive, member, dest) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-extract-'))
	try {
		const r = spawnSync('tar', ['-xf', archive, '-C', tmp, member], { encoding: 'utf8' })
		if (r.status !== 0) die(`extracting ${member} failed: ${r.stderr || r.stdout}`)
		const from = path.join(tmp, member)
		if (!fs.existsSync(from)) die(`${member} not found inside ${path.basename(archive)}`)
		fs.mkdirSync(path.dirname(dest), { recursive: true })
		fs.copyFileSync(from, dest)
		fs.chmodSync(dest, 0o755)
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

function installedTarget() {
	const f = path.join(VENDOR, '.target')
	return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null
}

function expectedBinaries(target) {
	return MANIFEST.targets[target].archives.flatMap((a) => Object.keys(a.members))
}

async function main() {
	const target = resolveTarget()
	const spec = MANIFEST.targets[target]
	const stamp = `${target}@${MANIFEST.ffmpegVersion}`

	if (PRINT_HASHES) {
		fs.mkdirSync(CACHE, { recursive: true })
		for (const a of spec.archives) {
			const tmp = path.join(CACHE, path.basename(new URL(a.url).pathname))
			if (!fs.existsSync(tmp)) await download(a.url, tmp)
			console.log(`${sha256(tmp)}  ${a.url}`)
		}
		return
	}

	const present = expectedBinaries(target).every((b) => fs.existsSync(path.join(VENDOR, b)))

	if (VERIFY_ONLY) {
		if (!present) die(`nothing installed in vendor/ffmpeg. Run: node scripts/fetch-ffmpeg.mjs`)
		if (installedTarget() !== stamp) die(`installed ${installedTarget()}, expected ${stamp}`)
		for (const b of expectedBinaries(target)) assertRedistributable(path.join(VENDOR, b))
		log(`verified ${stamp}: ${MANIFEST.license}, no forbidden flags`)
		return
	}

	// Re-verify rather than trusting the stamp: the binaries may have been
	// swapped under us, and this check is cheap next to a 160MB download.
	if (present && installedTarget() === stamp) {
		try {
			for (const b of expectedBinaries(target)) assertRedistributable(path.join(VENDOR, b))
			log(`${stamp} already installed and verified.`)
			return
		} catch {
			log('installed binaries failed verification; refetching.')
		}
	}

	fs.mkdirSync(VENDOR, { recursive: true })
	fs.mkdirSync(CACHE, { recursive: true })
	log(`installing FFmpeg ${MANIFEST.ffmpegVersion} for ${target} (${spec.builder})`)

	const provenance = [
		`FFmpeg ${MANIFEST.ffmpegVersion} (${MANIFEST.license})`,
		`target:  ${target}`,
		`builder: ${spec.builder} <${spec.builderUrl}>`,
		`source:  ${MANIFEST.sourceUrl}`,
		''
	]

	for (const a of spec.archives) {
		const cached = path.join(CACHE, `${a.sha256.slice(0, 16)}-${path.basename(new URL(a.url).pathname)}`)
		if (!fs.existsSync(cached) || sha256(cached) !== a.sha256) {
			log(`downloading ${path.basename(new URL(a.url).pathname)}`)
			await download(a.url, cached)
		}
		const got = sha256(cached)
		if (got !== a.sha256) {
			fs.rmSync(cached, { force: true })
			die(`checksum mismatch for ${a.url}\n  expected ${a.sha256}\n  got      ${got}`)
		}
		provenance.push(`archive: ${a.url}`, `sha256:  ${a.sha256}`)
		for (const [outName, member] of Object.entries(a.members)) {
			extractMember(cached, member, path.join(VENDOR, outName))
		}
	}

	for (const b of expectedBinaries(target)) {
		const cfg = assertRedistributable(path.join(VENDOR, b))
		provenance.push('', `${b} configure:`, cfg)
	}

	// GPL compliance: the licence text travels with the binary it covers.
	if (fs.existsSync(GPL_TEXT)) {
		fs.copyFileSync(GPL_TEXT, path.join(VENDOR, 'LICENSE.txt'))
	} else {
		die(`missing ${path.relative(ROOT, GPL_TEXT)} -- the GPL text must ship alongside the binaries.`)
	}

	fs.writeFileSync(path.join(VENDOR, 'PROVENANCE.txt'), provenance.join('\n') + '\n')
	fs.writeFileSync(path.join(VENDOR, '.target'), stamp + '\n')
	log(`installed and verified ${stamp} (${MANIFEST.license})`)
}

main().catch((err) => die(process.env.DEBUG ? err?.stack || String(err) : err?.message || String(err)))
