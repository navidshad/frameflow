import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// `externalizeDeps` replaces the `externalizeDepsPlugin` deprecated in
// electron-vite 5. It defaults to true for main and preload; it is written out
// here so the diff that dropped the plugin cannot be misread as dropping
// externalization — bundling ytdlp-nodejs into the main chunk would detach its
// binary from the asarUnpack path main rewrites at runtime. (FFmpeg is no longer
// an npm dependency; see scripts/fetch-ffmpeg.mjs.)
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      sourcemap: true,
      externalizeDeps: true
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      sourcemap: true,
      externalizeDeps: true,
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()]
  }
})
