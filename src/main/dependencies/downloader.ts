import { net } from 'electron'
import * as fs from 'fs'
import { dirname } from 'path'

/**
 * Downloads a file from a URL to a destination path with progress reporting.
 * Uses Electron's native net module for better integration and proxy support.
 */
export async function downloadFileWithProgress(
  url: string,
  destPath: string,
  onProgress: (percent: number) => void
): Promise<void> {
  // Ensure directory exists
  const dir = dirname(destPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  return new Promise((resolve, reject) => {
    const request = net.request(url)

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode} ${response.statusMessage}`))
        return
      }

      const totalBytes = parseInt(response.headers['content-length'] as string, 10)
      let downloadedBytes = 0
      const fileStream = fs.createWriteStream(destPath)

      response.on('data', (chunk) => {
        downloadedBytes += chunk.length
        if (totalBytes) {
          onProgress(Math.round((downloadedBytes / totalBytes) * 100))
        }
        fileStream.write(chunk)
      })

      response.on('end', () => {
        fileStream.end()
        resolve()
      })

      response.on('error', (err: Error) => {
        fileStream.close()
        if (fs.existsSync(destPath)) {
          try {
            fs.unlinkSync(destPath)
          } catch (e) {
            // Ignore unlink errors
          }
        }
        reject(err)
      })
    })

    request.on('error', (err) => {
      reject(err)
    })

    request.end()
  })
}
