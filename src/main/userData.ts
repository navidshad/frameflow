import { app } from 'electron'
import path from 'path'
import { importStrayProjects, PINNED_DIR_NAME, pinnedUserDataDir, STRAY_DIR_NAME } from './userDataPin'

/**
 * Imported first in index.ts, before anything reads `userData`: the folder cannot change
 * once the settings and project stores have opened it. See userDataPin.ts.
 */
if (!app.isPackaged) {
	const appData = app.getPath('appData')
	const pinned = pinnedUserDataDir(appData)
	// The name too, not only the folder. The OS encrypts the stored API keys with
	// a key that belongs to the app's NAME ("<name> Safe Storage" in the macOS
	// keychain), and a bare `electron out/main/index.js` is named "Electron":
	// sharing the settings file without sharing the name meant that launch could
	// not read the keys `npm run dev` had saved.
	app.setName(PINNED_DIR_NAME)
	app.setPath('userData', pinned)
	try {
		const imported = importStrayProjects(path.join(appData, STRAY_DIR_NAME), pinned)
		if (imported.length) console.log(`[userData] Imported ${imported.length} project(s) from the "${STRAY_DIR_NAME}" folder:`, imported)
	} catch (error) {
		console.error('[userData] Could not import projects from the "Electron" folder:', error)
	}
}
