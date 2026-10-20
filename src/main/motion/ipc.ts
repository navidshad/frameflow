import { app, ipcMain } from 'electron'
import path from 'path'
import type { MotionProbeInput } from './probe'
import { probeMotionPage } from './probe'
import { deleteUserTemplate, loadUserTemplates, saveUserTemplate, type SaveTemplateInput } from './templatesStore'

/**
 * The renderer's two ways into the motion engine beyond the export: the
 * determinism probe behind the code view's checks, and the saved-template
 * library. Both go through here so the renderer never needs a window of its own.
 */

const templatesDir = () => path.join(app.getPath('userData'), 'motion-templates')

export function initMotionIpc(): void {
	// The AI and MCP context read the registry, so load it before anyone asks.
	loadUserTemplates(templatesDir())

	ipcMain.handle('motion-probe', (_event, input: MotionProbeInput) => probeMotionPage(input))
	ipcMain.handle('motion-templates-list', () => loadUserTemplates(templatesDir()))
	ipcMain.handle('motion-templates-save', (_event, input: SaveTemplateInput) => {
		const result = saveUserTemplate(templatesDir(), input)
		return result.ok
			? { ok: true, template: result.template, templates: loadUserTemplates(templatesDir()) }
			: result
	})
	ipcMain.handle('motion-templates-delete', (_event, id: string) => deleteUserTemplate(templatesDir(), String(id)))
}
