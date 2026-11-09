import { app } from 'electron'
import path from 'path'
import { importStrayProjects, pinnedUserDataDir, STRAY_DIR_NAME } from './userDataPin'

/**
 * Imported first in index.ts, before anything reads `userData`: the folder cannot change
 * once the settings and project stores have opened it. See userDataPin.ts.
 */
if (!app.isPackaged) {
	const appData = app.getPath('appData')
	const pinned = pinnedUserDataDir(appData)
	app.setPath('userData', pinned)
	try {
		const imported = importStrayProjects(path.join(appData, STRAY_DIR_NAME), pinned)
		if (imported.length) console.log(`[userData] Imported ${imported.length} project(s) from the "${STRAY_DIR_NAME}" folder:`, imported)
	} catch (error) {
		console.error('[userData] Could not import projects from the "Electron" folder:', error)
	}
}
