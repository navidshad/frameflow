import { createApp } from 'vue'
import App from './App.vue'
import './assets/main.css'
import router from './router'

// Vue Flow's stylesheets live here, not in a component, because TWO surfaces
// render canvases — the chat graph page and the editor's revision graph — and
// only the first used to import them. That worked solely because router.ts
// imports GraphChatPage statically; lazy-loading that route would have silently
// unstyled the revision graph.
// Position matters: these must stay AFTER './assets/main.css' (Tailwind) and
// BEFORE 'pilotui/style.css', which reproduces the cascade they had when they
// arrived via router.ts's subtree. GraphChatPage.vue has ~50 lines of
// .vue-flow__* overrides whose specificity assumes that order.
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'

import LibVueComponents from 'pilotui'
import 'pilotui/style.css'
import { createPinia } from 'pinia'

const app = createApp(App)
const pinia = createPinia()

app.use(pinia)
app.use(router)
app.use(LibVueComponents, {
	dontInstallPinia: false
})
app.mount('#app')
