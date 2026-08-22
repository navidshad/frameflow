import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Node-only: covers the pure main/shared logic (ops mapping, prompt context,
// timeline validation). No jsdom, no Vue plugin — renderer components are
// verified by driving the real app.
export default defineConfig({
	resolve: {
		alias: {
			'@shared': resolve('src/shared')
		}
	},
	test: {
		environment: 'node',
		include: ['src/**/*.test.ts']
	}
})
