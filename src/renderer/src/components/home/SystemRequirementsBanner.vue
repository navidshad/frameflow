<template>
  <div v-if="checked && (!ffmpegAvailable || isTempDirUnsafe)" class="w-full mb-7 space-y-px">
    <!-- FFmpeg missing: blocking error -->
    <div v-if="!ffmpegAvailable" class="strip strip-error items-center">
      <span class="iconify tabler--alert-circle w-4 h-4 text-red-500 shrink-0"></span>
      <div class="flex-1 leading-snug">
        <b class="font-semibold text-red-500">FFmpeg not found.</b>
        <span class="text-zinc-600 dark:text-zinc-300"> FFmpeg is required for video processing. Please install it and restart the app.</span>
      </div>
    </div>

    <!-- Unsafe temp dir: warning -->
    <div v-if="isTempDirUnsafe" class="strip strip-warn items-center">
      <span class="iconify tabler--alert-triangle w-4 h-4 text-amber-500 shrink-0"></span>
      <div class="flex-1 leading-snug">
        <b class="font-semibold text-amber-600 dark:text-amber-400">Unstable Storage Location.</b>
        <span class="text-zinc-600 dark:text-zinc-300"> The app is using a system temporary directory. Your project artifacts might be
          deleted by the OS unexpectedly.</span>
      </div>
      <button @click="router.push('/settings')" class="btn-text btn-text-primary shrink-0">
        Go to Settings to change it
      </button>
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
const isTempDirUnsafe = ref(false)

watch(ffmpegAvailable, (v) => emit('ffmpeg-available', v), { immediate: true })

onMounted(async () => {
  try {
    const result = await (window as any).api?.checkSystemRequirements()
    if (result) {
      ffmpegAvailable.value = result.ffmpegAvailable
      isTempDirUnsafe.value = result.isTempDirUnsafe
    }
  } catch (e) {
    console.error('Failed to check system requirements:', e)
  } finally {
    checked.value = true
  }
})
</script>
