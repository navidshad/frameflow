import { createRouter, createWebHashHistory } from 'vue-router'
import ApiKeyPage from './pages/ApiKeyPage.vue'
import UploadPage from './pages/UploadPage.vue'
import SettingsPage from './pages/SettingsPage.vue'
import HomePage from './pages/HomePage.vue'

import GraphChatPage from './pages/GraphChatPage.vue'
import VideoEditorPage from './editor/VideoEditorPage.vue'

const routes = [
	{
		path: '/',
		redirect: '/home'
	},
	{
		path: '/home',
		component: HomePage
	},
	{
		path: '/api-key',
		component: ApiKeyPage
	},
	{
		path: '/upload',
		component: UploadPage
	},
	{
		path: '/chat/:id',
		name: 'chat',
		component: GraphChatPage
	},
	{
		path: '/editor/:id',
		name: 'editor',
		component: VideoEditorPage
	},

	{
		path: '/settings',
		component: SettingsPage
	}
]

const router = createRouter({
	history: createWebHashHistory(),
	routes
})

// Global API Key Guard
router.beforeEach(async (to) => {
	if (to.path === '/api-key') return true

	// Check main process for stored key
	const key = await (window as any).api.getGeminiApiKey()
	if (!key) {
		return '/api-key'
	}
	
	return true
})

export default router
