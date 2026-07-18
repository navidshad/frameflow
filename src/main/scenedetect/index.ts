import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join, parse as parsePath } from 'path'
import type { Scene } from './types'

export type { Scene } from './types'

const CONTENT_THRESHOLD = 27.0
const CSV_FILENAME = 'scenes.csv'
const DURATION_TOLERANCE = 0.1

let resolvedPathCache: string | null = null

/**
 * Locate the scenedetect binary across common OS-specific paths.
 * Returns the command to use (either absolute path or 'scenedetect').
 */
async function resolveScenedetectPath(): Promise<string> {
    if (resolvedPathCache) return resolvedPathCache

    // 1. Try default PATH first
    const isAvailable = await new Promise<boolean>((resolve) => {
        execFile('scenedetect', ['version'], (error) => resolve(!error))
    })
    if (isAvailable) {
        resolvedPathCache = 'scenedetect'
        return 'scenedetect'
    }

    const home = tmpdir().split(/[\\/]/).slice(0, 3).join('/') // Rough home dir for cross-platform? No, use os.homedir
    const { homedir, platform } = await import('os')
    const userHome = homedir()
    const isWin = platform() === 'win32'
    const isMac = platform() === 'darwin'

    const candidates: string[] = []

    if (isMac) {
        candidates.push(
            join(userHome, '.pyenv/shims/scenedetect'),
            join(userHome, 'Library/Python/3.9/bin/scenedetect'), // Specific versions the user has
            join(userHome, 'Library/Python/3.11/bin/scenedetect'),
            join(userHome, 'Library/Python/3.12/bin/scenedetect'),
            '/usr/local/bin/scenedetect',
            '/opt/homebrew/bin/scenedetect'
        )
        // Also check pyenv versions
        try {
            const pyenvVersionsDir = join(userHome, '.pyenv/versions')
            const versions = await fs.readdir(pyenvVersionsDir)
            for (const v of versions) {
                candidates.push(join(pyenvVersionsDir, v, 'bin/scenedetect'))
            }
        } catch { /* ignore */ }
    } else if (isWin) {
        const appData = process.env.APPDATA || join(userHome, 'AppData/Roaming')
        const localAppData = process.env.LOCALAPPDATA || join(userHome, 'AppData/Local')
        candidates.push(
            join(appData, 'Python/Python39/Scripts/scenedetect.exe'),
            join(appData, 'Python/Python310/Scripts/scenedetect.exe'),
            join(appData, 'Python/Python311/Scripts/scenedetect.exe'),
            join(appData, 'Python/Python312/Scripts/scenedetect.exe'),
            join(localAppData, 'Programs/Python/Python39/Scripts/scenedetect.exe'),
            join(localAppData, 'Programs/Python/Python311/Scripts/scenedetect.exe'),
            join(localAppData, 'Programs/Python/Python312/Scripts/scenedetect.exe'),
            join(userHome, '.pyenv/pyenv-win/bin/scenedetect.bat')
        )
    } else {
        // Linux
        candidates.push(
            join(userHome, '.local/bin/scenedetect'),
            join(userHome, '.pyenv/shims/scenedetect'),
            '/usr/bin/scenedetect',
            '/usr/local/bin/scenedetect'
        )
    }

    for (const cand of candidates) {
        try {
            await fs.access(cand)
            resolvedPathCache = cand
            return cand
        } catch { /* ignore */ }
    }

    // Last resort: try python3 -m scenedetect
    const isPythonModuleAvailable = await new Promise<boolean>((resolve) => {
        execFile('python3', ['-m', 'scenedetect', 'version'], (error) => resolve(!error))
    })
    if (isPythonModuleAvailable) {
        resolvedPathCache = 'PYTHON_MODULE'
        return 'PYTHON_MODULE'
    }

    return 'scenedetect' // Final fallback, even if it fails later
}

/**
 * Checks whether the scenedetect CLI is available.
 */
export async function checkScenedetectAvailability(): Promise<boolean> {
    const pathOrRef = await resolveScenedetectPath()
    if (pathOrRef === 'PYTHON_MODULE') return true
    
    return new Promise((resolve) => {
        execFile(pathOrRef, ['version'], (error) => {
            resolve(!error)
        })
    })
}

/**
 * Parse a timecode string (HH:MM:SS.mmm) or a plain number into seconds.
 * Throws if the value cannot be parsed.
 */
function parseTimecodeToSeconds(value: string): number {
    const trimmed = value.trim()

    // Timecode format: HH:MM:SS.mmm or MM:SS.mmm
    if (trimmed.includes(':')) {
        const parts = trimmed.split(':')
        if (parts.length === 3) {
            const hours = parseFloat(parts[0])
            const minutes = parseFloat(parts[1])
            const seconds = parseFloat(parts[2])
            if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) {
                throw new Error(`Invalid timecode value: "${trimmed}"`)
            }
            return hours * 3600 + minutes * 60 + seconds
        }
        if (parts.length === 2) {
            const minutes = parseFloat(parts[0])
            const seconds = parseFloat(parts[1])
            if (isNaN(minutes) || isNaN(seconds)) {
                throw new Error(`Invalid timecode value: "${trimmed}"`)
            }
            return minutes * 60 + seconds
        }
        throw new Error(`Unexpected timecode format: "${trimmed}"`)
    }

    // Plain numeric seconds
    const num = parseFloat(trimmed)
    if (isNaN(num)) {
        throw new Error(`Invalid numeric value: "${trimmed}"`)
    }
    return num
}

/**
 * Locate a CSV column index by matching against candidate header names.
 * Returns the first match found, or -1 if none.
 */
function findColumnIndex(headers: string[], candidates: string[]): number {
    const normalized = headers.map(h => h.trim().toLowerCase())
    for (const candidate of candidates) {
        const idx = normalized.indexOf(candidate.toLowerCase())
        if (idx !== -1) return idx
    }
    return -1
}

export class SceneDetector {
    /**
     * Detect scenes from a video file using the scenedetect CLI.
     *
     * Runs `scenedetect -i <videoPath> detect-content list-scenes`,
     * parses the resulting CSV, and returns an array of `Scene` objects
     * with times in seconds.
     *
     * @param videoPath - Absolute path to the input video file.
     * @returns Array of detected scenes sorted by start time.
     * @throws If the CLI exits non-zero, the CSV is missing, or values cannot be parsed.
     */
    async detectScenes(videoPath: string, signal?: AbortSignal, threshold: number = CONTENT_THRESHOLD): Promise<Scene[]> {
        const tempDir = await fs.mkdtemp(join(tmpdir(), 'scenedetect-'))

        try {
            await this.runScenedetect(videoPath, tempDir, signal, threshold)
            const csvPath = await this.locateCsvFile(tempDir, videoPath)
            const csvContent = await fs.readFile(csvPath, 'utf-8')
            return this.parseCsv(csvContent)
        } finally {
            // Best-effort cleanup — never hides the original error
            try {
                await fs.rm(tempDir, { recursive: true, force: true })
            } catch (cleanupErr) {
                console.error('Failed to clean up temp directory:', cleanupErr)
            }
        }
    }

    /**
     * Execute the scenedetect CLI process.
     */
    private async runScenedetect(videoPath: string, outputDir: string, signal?: AbortSignal, threshold: number = CONTENT_THRESHOLD): Promise<void> {
        const pathOrRef = await resolveScenedetectPath()

        return new Promise((resolve, reject) => {
            const scenedetectArgs = [
                '-i', videoPath,
                'detect-content',
                '-t', String(threshold),
                'list-scenes',
                '-o', outputDir,
                '-f', CSV_FILENAME,
                '--skip-cuts'
            ]

            let cmd: string
            let args: string[]

            if (pathOrRef === 'PYTHON_MODULE') {
                cmd = 'python3'
                args = ['-m', 'scenedetect', ...scenedetectArgs]
            } else {
                cmd = pathOrRef
                args = scenedetectArgs
            }

            const child = execFile(cmd, args, (error, _stdout, stderr) => {
                if (error) {
                    if (signal?.aborted) {
                        return reject(new Error('Scene detection aborted by user'))
                    }
                    const code = error.code ?? (error as any).status ?? 'unknown'
                    const stderrMsg = stderr?.trim() || '(no stderr)'
                    console.error(`scenedetect CLI failed for "${videoPath}":`, stderrMsg)
                    reject(new Error(
                        `scenedetect exited with code ${code} for "${videoPath}": ${stderrMsg}`
                    ))
                    return
                }
                resolve()
            })

            if (signal) {
                signal.addEventListener('abort', () => {
                    console.log('scenedetect process killed by signal')
                    child.kill('SIGKILL')
                })
            }
        })
    }

    /**
     * Locate the generated CSV file in the output directory.
     * Tries the explicit filename first, then the default naming convention,
     * and finally scans for any CSV as a last resort.
     */
    private async locateCsvFile(outputDir: string, videoPath: string): Promise<string> {
        // Try explicit filename first
        const explicit = join(outputDir, CSV_FILENAME)
        try {
            await fs.access(explicit)
            return explicit
        } catch {
            // Fall through
        }

        // Fallback: scenedetect may use $VIDEO_NAME-Scenes.csv
        const videoName = parsePath(videoPath).name
        const defaultName = join(outputDir, `${videoName}-Scenes.csv`)
        try {
            await fs.access(defaultName)
            return defaultName
        } catch {
            // Fall through
        }

        // Last resort: find any CSV in the temp directory
        const files = await fs.readdir(outputDir)
        const csvFile = files.find(f => f.endsWith('.csv'))
        if (csvFile) {
            return join(outputDir, csvFile)
        }

        throw new Error(
            `No CSV file found in scenedetect output for "${videoPath}" (dir: ${outputDir})`
        )
    }

    /**
     * Parse the scenedetect CSV output into Scene objects.
     * Matches columns by header name to tolerate extra/reordered columns.
     */
    private parseCsv(content: string): Scene[] {
        const lines = content
            .split(/\r?\n/)
            .filter(line => line.trim().length > 0)

        if (lines.length < 2) {
            return []
        }

        const headers = lines[0].split(',')

        const startIdx = findColumnIndex(headers, [
            'start time (seconds)',
            'start time',
            'start'
        ])
        const endIdx = findColumnIndex(headers, [
            'end time (seconds)',
            'end time',
            'end'
        ])
        const durationIdx = findColumnIndex(headers, [
            'length (seconds)',
            'length',
            'duration (seconds)',
            'duration'
        ])

        if (startIdx === -1 || endIdx === -1) {
            throw new Error(
                `CSV missing required columns. Found headers: [${headers.join(', ')}]`
            )
        }

        const scenes: Scene[] = []

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',')
            const row = i + 1

            const startRaw = cols[startIdx]
            const endRaw = cols[endIdx]

            if (!startRaw?.trim() || !endRaw?.trim()) {
                throw new Error(`Row ${row}: missing start or end time value`)
            }

            let startTime: number
            let endTime: number
            try {
                startTime = parseTimecodeToSeconds(startRaw)
            } catch (err) {
                throw new Error(`Row ${row}, column "start": ${(err as Error).message}`)
            }
            try {
                endTime = parseTimecodeToSeconds(endRaw)
            } catch (err) {
                throw new Error(`Row ${row}, column "end": ${(err as Error).message}`)
            }

            // Compute duration from end-start as the canonical value
            const computedDuration = endTime - startTime

            let duration = computedDuration
            if (durationIdx !== -1 && cols[durationIdx]?.trim()) {
                try {
                    const csvDuration = parseTimecodeToSeconds(cols[durationIdx])
                    // Use CSV duration only if it agrees with computed value
                    if (Math.abs(csvDuration - computedDuration) <= DURATION_TOLERANCE) {
                        duration = csvDuration
                    }
                } catch {
                    // CSV duration unparseable — fall back to computed
                }
            }

            // Validate non-negative values
            if (startTime < 0) {
                throw new Error(`Row ${row}: startTime is negative (${startTime})`)
            }
            if (endTime < 0) {
                throw new Error(`Row ${row}: endTime is negative (${endTime})`)
            }
            if (duration < 0) {
                throw new Error(
                    `Row ${row}: computed duration is negative (${duration}). ` +
                    `startTime=${startTime}, endTime=${endTime}`
                )
            }

            scenes.push({ startTime, endTime, duration })
        }

        return scenes
    }
}