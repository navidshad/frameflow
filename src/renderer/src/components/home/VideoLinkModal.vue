<template>
  <AppDialog :model-value="modelValue" title="Add video from a link" size="md"
    @update:model-value="$emit('update:modelValue', $event)">
    <div class="space-y-3">
      <!-- yt-dlp setup / missing -->
      <div v-if="!ytDlpAvailable || ytDlpStatus?.status === 'downloading' || ytDlpStatus?.status === 'error'"
        class="strip" :class="{
          'strip-warn': isYtDlpMissing,
          'strip-info': ytDlpStatus?.status === 'downloading',
          'strip-error': ytDlpStatus?.status === 'error'
        }">
        <span v-if="ytDlpStatus?.status === 'downloading'" class="iconify tabler--loader-2 w-4 h-4 animate-spin text-primary shrink-0"></span>
        <span v-else class="iconify tabler--alert-triangle w-4 h-4 shrink-0"
          :class="ytDlpStatus?.status === 'error' ? 'text-red-500' : 'text-amber-500'"></span>

        <div class="flex-1 min-w-0 text-[11px] leading-snug">
          <b class="font-semibold" :class="{
            'text-amber-600 dark:text-amber-400': isYtDlpMissing,
            'text-primary': ytDlpStatus?.status === 'downloading',
            'text-red-500': ytDlpStatus?.status === 'error'
          }">{{ bannerTitle }}.</b>
          <span class="text-zinc-600 dark:text-zinc-300"> {{ bannerBody }}</span>
          <button v-if="ytDlpStatus?.status !== 'downloading'" @click="installYtDlp"
            class="ml-1 font-semibold text-primary hover:text-primary-dark transition-colors">Install now</button>

          <div v-if="ytDlpStatus?.status === 'downloading'" class="mt-2">
            <div class="h-[3px] w-full bg-zinc-200 dark:bg-white/10">
              <div class="h-full bg-primary transition-all duration-300" :style="{ width: `${ytDlpStatus?.progress || 0}%` }"></div>
            </div>
            <p class="mt-1 text-[11px] font-mono text-zinc-500">{{ ytDlpStatus?.progress || 0 }}%</p>
          </div>
        </div>
      </div>

      <!-- Self-heal succeeded: the original request is being retried -->
      <div v-else-if="retryingAfterUpdate" class="strip strip-ok items-center text-emerald-700 dark:text-emerald-400 font-medium">
        <span class="iconify tabler--refresh w-4 h-4 animate-spin shrink-0"></span>
        Downloader updated — retrying your link…
      </div>

      <!-- URL input -->
      <div>
        <label class="lbl block" for="video-link-url">Video link</label>
        <input id="video-link-url" v-model="videoUrl" type="url" placeholder="https://…" :disabled="!ytDlpAvailable || isBusy"
          class="field !text-[13px] !py-1.5" @keydown.enter.prevent="step" />
      </div>

      <!-- Resolution picker (after analysis) -->
      <div v-if="availableResolutions.length" class="flex items-center gap-3">
        <label class="lbl shrink-0" for="video-link-res">Resolution</label>
        <select id="video-link-res" v-model="selectedResolution" :disabled="isBusy" class="field flex-1">
          <option v-for="r in availableResolutions" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>

      <!-- Download progress -->
      <div v-if="isDownloading" class="text-[11px] text-zinc-500 dark:text-zinc-400">
        Downloading… <span class="font-mono tabular-nums">{{ downloadProgress }}%</span>
        <div class="h-[3px] mt-2 bg-zinc-200 dark:bg-white/10">
          <div class="h-full bg-primary transition-all duration-300" :style="{ width: `${downloadProgress}%` }"></div>
        </div>
      </div>
    </div>

    <template #footer>
      <button class="btn-text" @click="close">Cancel</button>
      <button class="btn-fill" :disabled="!canStep" @click="step">{{ stepLabel }}</button>
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import AppDialog from '../AppDialog.vue'
import { dialog } from '../../composables/useDialog'

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

// Self-heal state: an auto-recovery update started while a request was busy,
// and (once it lands) the pending "we're retrying your link" note.
const autoRecovering = ref(false)
const retryingAfterUpdate = ref(false)

const isBusy = computed(() => isAnalyzing.value || isDownloading.value)
const isYtDlpMissing = computed(() =>
  ytDlpStatus.value?.status === 'missing' || !ytDlpStatus.value ||
  (!ytDlpAvailable.value && ytDlpStatus.value?.status !== 'downloading'))

const isAutoRecovery = computed(() => ytDlpStatus.value?.reason === 'auto-recovery')

const bannerTitle = computed(() => {
  if (ytDlpStatus.value?.status === 'downloading')
    return isAutoRecovery.value ? 'Updating downloader…' : 'Setting up downloader…'
  return ytDlpStatus.value?.status === 'error' ? 'Installation failed' : 'yt-dlp required'
})

const bannerBody = computed(() => {
  if (ytDlpStatus.value?.status === 'downloading')
    return isAutoRecovery.value
      ? 'The site blocked the current downloader version. FrameFlow is updating it and will retry your link automatically.'
      : 'Please wait while we set up the video processing engine.'
  return 'Downloading videos from links requires additional components.'
})

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

      // Track the self-heal cycle: update started → landed → note the retry
      if (status.status === 'downloading' && status.reason === 'auto-recovery') {
        autoRecovering.value = true
      } else if (status.status === 'ready' && autoRecovering.value) {
        autoRecovering.value = false
        if (isBusy.value) retryingAfterUpdate.value = true
      } else if (status.status === 'error') {
        autoRecovering.value = false
      }
    }
  })
})

// The retry note lives only while the retried request is still in flight
watch(isBusy, (busy) => {
  if (!busy) retryingAfterUpdate.value = false
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
      await dialog.notify({
        title: 'Link Analysis Failed',
        message: 'Could not analyze the provided link.',
        detail: cleanMessage(e, 'Please check the URL and try again.'),
        tone: 'error'
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
    await dialog.notify({
      title: 'Download Failed',
      message: 'Could not download the video.',
      detail: cleanMessage(e, 'Please check the connection and try again.'),
      tone: 'error'
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
