import { createRouter, createWebHashHistory } from 'vue-router'
import SetupPage from './pages/SetupPage.vue'
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
		path: '/setup',
		component: SetupPage
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

// Setup guard: a Gemini key and a projects folder the OS will not clear.
// Main decides (settingsManager.isSetupComplete), so installs that predate the
// wizard and already have both are never sent through it.
router.beforeEach(async (to) => {
	const complete: boolean = await (window as any).api.isSetupComplete()
	if (to.path === '/setup') return complete ? '/home' : true
	return complete ? true : '/setup'
})

export default router
