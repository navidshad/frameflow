import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import * as fs from 'fs'
import { downloadFileWithProgress } from './downloader'

export type DependencyStatus = 'checking' | 'ready' | 'missing' | 'downloading' | 'error'

/** Why an install/update is running — lets the UI phrase the banner correctly. */
export type DependencyUpdateReason = 'manual' | 'auto-recovery' | 'freshness'

export interface DependencyInfo {
  name: string
  status: DependencyStatus
  progress: number
  error?: string
  reason?: DependencyUpdateReason
}

/**
 * Release filename for the current platform/arch. Used by BOTH the installer
 * and the userData lookup — they must agree, or a freshly downloaded binary
 * is never picked up.
 */
function getYtDlpReleaseFilename(): string {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'darwin') return 'yt-dlp_macos'
  if (platform === 'win32') {
    return arch === 'arm64' || arch === 'x64' ? 'yt-dlp.exe' : 'yt-dlp_x86.exe'
  }
  // Linux
  return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp'
}

class DependencyManager {
  private statusMap: Map<string, DependencyInfo> = new Map()
  // Latch: concurrent install triggers (manual button, startup freshness
  // check, failure-triggered self-heal) coalesce into one download.
  private ytDlpInstall: Promise<void> | null = null

  constructor() {
    this.statusMap.set('yt-dlp', { name: 'yt-dlp', status: 'checking', progress: 0 })
  }

  getStatus(name: string): DependencyInfo | undefined {
    return this.statusMap.get(name)
  }

  updateStatus(name: string, updates: Partial<DependencyInfo>) {
    const info = this.statusMap.get(name)
    if (info) {
      Object.assign(info, updates)
      this.broadcast(info)
    }
  }

  private broadcast(info: DependencyInfo) {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('dependency-update', info)
    })
  }

  installYtDlp(options?: { reason?: DependencyUpdateReason }): Promise<void> {
    if (!this.ytDlpInstall) {
      this.ytDlpInstall = this.doInstallYtDlp(options?.reason ?? 'manual').finally(() => {
        this.ytDlpInstall = null
      })
    }
    return this.ytDlpInstall
  }

  private async doInstallYtDlp(reason: DependencyUpdateReason): Promise<void> {
    const name = 'yt-dlp'
    try {
      this.updateStatus(name, { status: 'downloading', progress: 0, reason })

      const filename = getYtDlpReleaseFilename()
      const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`
      
      // We store the downloaded binary in the app's userData folder to ensure it survives updates
      // and is always executable (not blocked by ASAR).
      const destDir = join(app.getPath('userData'), 'bin')
      const destPath = join(destDir, filename)

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true })
      }

      await downloadFileWithProgress(url, destPath, (percent) => {
        this.updateStatus(name, { progress: percent })
      })

      // Ensure it is executable on Unix-like systems
      if (process.platform !== 'win32') {
        fs.chmodSync(destPath, 0o755)
      }

      this.updateStatus(name, { status: 'ready', progress: 100, reason: undefined })
    } catch (error: any) {
      console.error(`[DependencyManager] Failed to install ${name}:`, error)
      this.updateStatus(name, { status: 'error', error: error.message, reason })
      throw error
    }
  }

  /**
   * Returns the path to the downloaded yt-dlp binary in userData if it exists.
   */
  getDownloadedYtDlpPath(): string | null {
    const destPath = join(app.getPath('userData'), 'bin', getYtDlpReleaseFilename())
    
    if (fs.existsSync(destPath)) {
      return destPath
    }
    return null
  }
}

export const dependencyManager = new DependencyManager()
