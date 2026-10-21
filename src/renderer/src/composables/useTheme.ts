import { computed } from 'vue'
import { useAppStore } from 'pilotui/store'

/**
 * Light/dark, for the screens that draw their own top bar. `App.vue` still owns
 * putting the `dark` class on <html>; this only reads and flips the stored theme.
 */
export function useTheme() {
	const appStore = useAppStore()
	const isDark = computed(() => appStore.theme !== 'light')
	const toggle = () => appStore.toggleTheme(appStore.theme === 'light' ? 'dark' : 'light')
	return { isDark, toggle }
}
