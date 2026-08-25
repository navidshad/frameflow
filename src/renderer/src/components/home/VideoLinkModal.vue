<template>
  <Modal :model-value="modelValue" title="Add video from a link" size="md"
    @update:model-value="$emit('update:modelValue', $event)">
    <div class="p-5 space-y-5">
      <!-- yt-dlp setup / missing -->
      <div v-if="!ytDlpAvailable || ytDlpStatus?.status === 'downloading' || ytDlpStatus?.status === 'error'"
        class="w-full p-5 rounded-xl border backdrop-blur-md transition-all duration-500" :class="{
          'bg-amber-500/10 border-amber-500/20 text-amber-900 dark:text-amber-400': isYtDlpMissing,
          'bg-blue-500/10 border-blue-500/20 text-blue-900 dark:text-blue-400': ytDlpStatus?.status === 'downloading',
          'bg-red-500/10 border-red-500/20 text-red-900 dark:text-red-400': ytDlpStatus?.status === 'error'
        }">
        <div class="flex items-start gap-4">
          <div class="p-2 rounded-lg shrink-0" :class="{
            'bg-amber-500/20': isYtDlpMissing,
            'bg-blue-500/20': ytDlpStatus?.status === 'downloading',
            'bg-red-500/20': ytDlpStatus?.status === 'error'
          }">
            <span v-if="ytDlpStatus?.status === 'downloading'"
              class="iconify tabler--loader-2 w-5 h-5 animate-spin"></span>
            <span v-else class="iconify tabler--alert-triangle w-5 h-5"></span>
          </div>

          <div class="flex-1 min-w-0">
            <h4 class="font-bold text-base">
              {{ ytDlpStatus?.status === 'downloading'
                ? 'Setting up downloader…'
                : (ytDlpStatus?.status === 'error' ? 'Installation failed' : 'yt-dlp required') }}
            </h4>
            <p class="text-sm opacity-80 mt-1 leading-relaxed">
              {{ ytDlpStatus?.status === 'downloading'
                ? 'Please wait while we set up the video processing engine.'
                : 'Downloading videos from links requires additional components.' }}
            </p>

            <div v-if="ytDlpStatus?.status === 'downloading'" class="mt-4 space-y-2">
              <div class="h-2 w-full bg-blue-500/20 rounded-full overflow-hidden">
                <div class="h-full bg-blue-500 transition-all duration-300"
                  :style="{ width: `${ytDlpStatus?.percent || 0}%` }"></div>
              </div>
              <p class="text-[11px] font-mono opacity-70">{{ ytDlpStatus?.percent || 0 }}%</p>
            </div>

            <button v-else @click="installYtDlp"
              class="mt-3 px-3 py-1.5 rounded-lg bg-white/60 dark:bg-white/10 text-xs font-bold hover:bg-white/80 dark:hover:bg-white/20 transition active:scale-95">
              Install now
            </button>
          </div>
        </div>
      </div>

      <!-- URL input -->
      <div class="space-y-2">
        <label class="text-[10px] font-black uppercase tracking-widest text-zinc-500">Video link</label>
        <input v-model="videoUrl" type="url" placeholder="https://…" :disabled="!ytDlpAvailable || isBusy"
          class="w-full px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-sm text-zinc-800 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
          @keydown.enter.prevent="step" />
      </div>

      <!-- Resolution picker (after analysis) -->
      <div v-if="availableResolutions.length" class="space-y-2">
        <label class="text-[10px] font-black uppercase tracking-widest text-zinc-500">Resolution</label>
        <select v-model="selectedResolution" :disabled="isBusy"
          class="w-full px-4 py-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-sm font-bold text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50">
          <option v-for="r in availableResolutions" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>

      <!-- Download progress -->
      <div v-if="isDownloading" class="space-y-2">
        <div class="h-2 w-full bg-primary/20 rounded-full overflow-hidden">
          <div class="h-full bg-primary transition-all duration-300"
            :style="{ width: `${downloadProgress}%` }"></div>
        </div>
        <p class="text-[11px] font-mono text-zinc-500">Downloading… {{ downloadProgress }}%</p>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2 px-5 pb-5">
        <button @click="close"
          class="px-4 py-2 rounded-xl text-sm font-bold text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition">
          Cancel
        </button>
        <button @click="step" :disabled="!canStep"
          class="px-4 py-2 rounded-xl bg-primary text-white text-sm font-bold shadow-md shadow-primary/20 hover:bg-primary-dark transition active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">
          {{ stepLabel }}
        </button>
      </div>
    </template>
  </Modal>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Modal } from 'pilotui/complex'

/**
 * The URL/yt-dlp flow, lifted out of the retired upload page.
 *
 * A modal rather than a route: it hands the chosen file straight back, and the
 * composer's prompt, purpose and already-attached images stay alive underneath.
 * A route push would destroy all of that.
 */
defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'select', file: { path: string; name: string }): void
}>()

const close = () => emit('update:modelValue', false)

const videoUrl = ref('')
const availableResolutions = ref<string[]>([])
const selectedResolution = ref('')
const isAnalyzing = ref(false)
const isDownloading = ref(false)
const downloadProgress = ref(0)
const ytDlpAvailable = ref(true)
const ytDlpStatus = ref<any>(null)

const api = () => (window as any).api

const isBusy = computed(() => isAnalyzing.value || isDownloading.value)
const isYtDlpMissing = computed(() =>
  ytDlpStatus.value?.status === 'missing' || !ytDlpStatus.value ||
  (!ytDlpAvailable.value && ytDlpStatus.value?.status !== 'downloading'))

const canStep = computed(() =>
  !!videoUrl.value.trim() && ytDlpAvailable.value && !isBusy.value)

const stepLabel = computed(() => {
  if (isAnalyzing.value) return 'Analyzing…'
  if (isDownloading.value) return 'Downloading…'
  return availableResolutions.value.length ? 'Download' : 'Check link'
})

onMounted(async () => {
  api()?.onDownloadProgress?.((percent: number) => { downloadProgress.value = percent })

  try {
    const result = await api()?.checkSystemRequirements()
    if (result) {
      ytDlpAvailable.value = result.ytDlpAvailable !== false
      ytDlpStatus.value = result.ytDlpStatus
    }
  } catch (e) {
    console.error('Failed to check system requirements:', e)
  }

  api()?.onDependencyUpdate?.((status: any) => {
    if (status.name === 'yt-dlp') {
      ytDlpStatus.value = status
      if (status.status === 'ready') ytDlpAvailable.value = true
    }
  })
})

const installYtDlp = async () => {
  try {
    await api()?.installDependency('yt-dlp')
  } catch (e) {
    console.error('Manual install failed:', e)
  }
}

/** Electron wraps handler errors; show the useful half. */
const cleanMessage = (e: any, fallback: string): string => {
  const raw = e?.message || fallback
  return raw.includes('Error invoking remote method')
    ? (raw.split('Error:').pop()?.trim() || raw)
    : raw
}

/** Two-stage: analyze the link, then download at the chosen resolution. */
const step = async () => {
  if (!canStep.value) return

  if (availableResolutions.value.length === 0) {
    try {
      isAnalyzing.value = true
      const res = await api()?.fetchVideoFormats(videoUrl.value)
      if (res && res.length > 0) {
        availableResolutions.value = res
        // Default to mid quality — the list is sorted descending.
        selectedResolution.value = res[Math.floor(res.length / 2)]
      } else {
        availableResolutions.value = ['Best']
        selectedResolution.value = 'Best'
      }
    } catch (e: any) {
      availableResolutions.value = []
      await api()?.showConfirmation({
        title: 'Link Analysis Failed',
        message: 'Could not analyze the provided link.',
        detail: cleanMessage(e, 'Please check the URL and try again.'),
        type: 'error',
        buttons: ['OK']
      })
    } finally {
      isAnalyzing.value = false
    }
    return
  }

  try {
    isDownloading.value = true
    downloadProgress.value = 0
    const result = await api()?.downloadVideo(videoUrl.value, selectedResolution.value)
    if (result?.path) {
      emit('select', { path: result.path, name: result.name })
      reset()
      close()
    }
  } catch (e: any) {
    await api()?.showConfirmation({
      title: 'Download Failed',
      message: 'Could not download the video.',
      detail: cleanMessage(e, 'Please check the connection and try again.'),
      type: 'error',
      buttons: ['OK']
    })
  } finally {
    isDownloading.value = false
  }
}

const reset = () => {
  videoUrl.value = ''
  availableResolutions.value = []
  selectedResolution.value = ''
  downloadProgress.value = 0
}
</script>
