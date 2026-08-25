<template>
  <div v-if="checked && (!ffmpegAvailable || !scenedetectAvailable || isTempDirUnsafe)"
    class="w-full max-w-3xl mx-auto space-y-4 mb-6">
    <!-- FFmpeg missing: blocking error -->
    <div v-if="!ffmpegAvailable"
      class="flex items-start gap-4 px-5 py-4 rounded-lg border border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400 backdrop-blur-sm">
      <div class="p-2 rounded-lg bg-red-500/20 shrink-0">
        <span class="iconify tabler--alert-circle w-5 h-5"></span>
      </div>
      <div>
        <p class="font-bold text-base">FFmpeg not found</p>
        <p class="text-sm mt-1 opacity-90 leading-relaxed">
          FFmpeg is required for video processing. Please install it and restart the app.
        </p>
      </div>
    </div>

    <!-- scenedetect missing: warning -->
    <div v-if="ffmpegAvailable && !scenedetectAvailable"
      class="flex items-start gap-4 px-5 py-4 rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400 backdrop-blur-sm">
      <div class="p-2 rounded-lg bg-amber-500/20 shrink-0">
        <span class="iconify tabler--alert-triangle w-5 h-5"></span>
      </div>
      <div>
        <p class="font-bold text-base">scenedetect not found — Audio-only mode</p>
        <div class="text-sm mt-1 opacity-90 leading-relaxed space-y-2">
          <p>Visual scene analysis is unavailable. The AI will only analyze audio data.</p>
          <a href="https://github.com/navidshad/frameflow/blob/main/docs/setup.md#-external-tool-setup"
            target="_blank" class="inline-flex items-center gap-1 font-bold hover:underline">
            Installation guide
            <span class="iconify tabler--external-link w-3 h-3"></span>
          </a>
        </div>
      </div>
    </div>

    <!-- Unsafe temp dir: warning -->
    <div v-if="isTempDirUnsafe"
      class="flex items-start gap-4 px-5 py-4 rounded-lg border border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400 backdrop-blur-sm">
      <div class="p-2 rounded-lg bg-amber-500/20 shrink-0">
        <span class="iconify tabler--alert-triangle w-5 h-5"></span>
      </div>
      <div>
        <p class="font-bold text-base">Unstable Storage Location</p>
        <div class="text-sm mt-1 opacity-90 leading-relaxed space-y-1">
          <p>The app is using a system temporary directory. Your project artifacts might be
            deleted by the OS unexpectedly.</p>
          <button @click="router.push('/settings')" class="font-bold hover:underline">
            Go to Settings to change it
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'

/**
 * Dependency warnings, shown above the composer.
 *
 * Home rather than Settings: these have to be seen BEFORE committing a file,
 * and Home is now the only pre-commit surface. Self-hides when everything is
 * fine. Emits ffmpeg availability so the composer can gate video-purpose sends.
 */
const emit = defineEmits<{ (e: 'ffmpeg-available', value: boolean): void }>()

const router = useRouter()
const checked = ref(false)
const ffmpegAvailable = ref(true)
const scenedetectAvailable = ref(true)
const isTempDirUnsafe = ref(false)

watch(ffmpegAvailable, (v) => emit('ffmpeg-available', v), { immediate: true })

onMounted(async () => {
  try {
    const result = await (window as any).api?.checkSystemRequirements()
    if (result) {
      ffmpegAvailable.value = result.ffmpegAvailable
      scenedetectAvailable.value = result.scenedetectAvailable
      isTempDirUnsafe.value = result.isTempDirUnsafe
    }
  } catch (e) {
    console.error('Failed to check system requirements:', e)
  } finally {
    checked.value = true
  }
})
</script>
