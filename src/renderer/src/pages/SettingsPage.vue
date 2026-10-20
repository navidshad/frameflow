<template>
  <div class="h-full flex flex-col bg-ground overflow-hidden">
    <AppTopBar title="Settings" subtitle="Configure application preferences and manage your data." show-back
      :show-settings="false" @back="router.back()" />

    <div class="flex-1 overflow-y-auto custom-scrollbar">
      <div class="mx-auto w-full max-w-[880px] px-10 pb-16 flat-fields">
        <!-- Storage -->
        <SettingsSection title="Storage" description="Where intermediate files are kept.">
          <div class="font-mono text-xs break-all py-2" :style="{ borderBottom: '1px solid var(--ff-hairline-strong)' }">
            {{ tempDir || 'Loading...' }}
          </div>
          <div v-if="isTempDirUnsafe" class="strip strip-warn mt-2.5 text-[11px] text-amber-600 dark:text-amber-400">
            <span>
              <b class="font-semibold">Unstable Storage Location.</b>
              This folder may be cleared by the OS. Use a persistent directory to keep your project artifacts safe.
            </span>
          </div>
          <div class="flex gap-5 mt-3">
            <button @click="handleChange" class="btn-text btn-text-primary !px-0">Change location</button>
            <button @click="handleOpen" class="btn-text btn-text-primary !px-0">Open folder</button>
            <button @click="handleReset" class="btn-text !px-0">Reset to default</button>
          </div>
        </SettingsSection>

        <!-- AI engine -->
        <AiEngineCard />

        <!-- Agent access (MCP) -->
        <AgentAccessCard />

        <!-- More sections (audio providers, ...) are appended here. -->

        <!-- Gemini API key -->
        <SettingsSection title="Gemini API key"
          description="Used for transcripts, scene descriptions, and the Gemini API engine.">
          <label for="gemini-key" class="sr-only">Gemini API key</label>
          <input id="gemini-key" v-model="apiKey" type="password" placeholder="Enter API Key..." autocomplete="off"
            class="field font-mono !py-2" />
          <button @click="handleSaveApiKey" :disabled="!apiKey || apiKey === initialApiKey"
            class="btn-text btn-text-primary !px-0 mt-3">Save API key</button>
        </SettingsSection>

        <!-- Model selection -->
        <SettingsSection title="Model selection" description="Assign models to specific operations. Changes save by themselves.">
          <div class="flex justify-end -mt-1 mb-1">
            <button @click="handleResetModels" class="btn-text !text-[11px]">Reset models</button>
          </div>
          <div v-for="op in orderedOperations" :key="op" class="flex items-center justify-between gap-4 py-2 hair-b">
            <span class="text-zinc-700 dark:text-zinc-300 capitalize">{{ getOpLabel(op) }}</span>
            <select v-model="modelSettings.selection[op]" @change="handleSaveModelSettings"
              class="field !w-60 !py-1 cursor-pointer">
              <option v-for="mName in getModelsForOp(op)" :key="mName" :value="mName">{{ getModelLabel(mName) }}</option>
            </select>
          </div>
        </SettingsSection>

        <!-- Model pricing -->
        <SettingsSection title="Model pricing" description="Cost per 1M tokens in USD.">
          <div class="flex justify-end -mt-1 mb-2">
            <button @click="handleResetPricing" class="btn-text !text-[11px]">Reset pricing</button>
          </div>
          <div class="overflow-x-auto">
            <div class="min-w-[520px]">
              <div :class="PRICING_COLS" class="gap-3 pb-1.5 text-[10px] font-bold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <span>Model</span><span>Input std</span><span>Output std</span><span>Output image</span><span>Input audio</span>
              </div>
              <div v-for="(pricing, mName) in modelSettings.pricing" :key="mName" :class="PRICING_COLS"
                class="gap-3 py-2 hair-t items-center">
                <div class="min-w-0">
                  <div class="font-semibold truncate" :title="String(mName)">{{ getModelLabel(mName) }}</div>
                  <div class="text-[10px] text-zinc-400 truncate" :title="String(mName)">{{ mName }}</div>
                </div>
                <label class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
                  <input type="number" step="0.01" v-model.number="pricing.input.standard" @change="handleSaveModelSettings"
                    class="field !w-full font-mono !py-1" />
                </label>
                <label class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
                  <input type="number" step="0.01" v-model.number="pricing.output.standard" @change="handleSaveModelSettings"
                    class="field !w-full font-mono !py-1" />
                </label>
                <label v-if="pricing.output.image !== undefined" class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
                  <input type="number" step="0.0001" v-model.number="pricing.output.image" @change="handleSaveModelSettings"
                    class="field !w-full font-mono !py-1" />
                </label>
                <span v-else class="text-zinc-400 font-mono opacity-40">—</span>
                <label v-if="pricing.input.audio !== undefined" class="flex items-center gap-1 font-mono"><span class="text-zinc-400">$</span>
                  <input type="number" step="0.01" v-model.number="pricing.input.audio" @change="handleSaveModelSettings"
                    class="field !w-full font-mono !py-1" />
                </label>
                <span v-else class="text-zinc-400 font-mono opacity-40">—</span>
              </div>
            </div>
          </div>
        </SettingsSection>

        <!-- Danger zone -->
        <SettingsSection title="Danger zone" description="Irreversible actions.">
          <p class="text-zinc-600 dark:text-zinc-300 leading-relaxed">
            Permanently delete all chats, video summaries, and cached files. This action cannot be undone.
          </p>
          <button @click="handleDeleteAll" class="btn-text btn-text-danger !px-0 mt-3">Delete all data</button>
        </SettingsSection>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, toRaw } from 'vue'
import { useRouter } from 'vue-router'
import { useVideoStore } from '../stores/videoStore'
import AppTopBar from '../components/AppTopBar.vue'
import SettingsSection from '../components/settings/SettingsSection.vue'
import { dialog } from '../composables/useDialog'
import AgentAccessCard from '../components/settings/AgentAccessCard.vue'
import AiEngineCard from '../components/settings/AiEngineCard.vue'
import { ModelSettings } from '../../../shared/types'
// In a real scenario we'd import constants, but we can also use the IPC-returned defaults if we added a method.
// For now, we'll manually ensure the new model and selection are present if missing.
const router = useRouter()
const PRICING_COLS = 'grid grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))]'
const videoStore = useVideoStore()
const tempDir = ref('')
const isTempDirUnsafe = ref(false)
const apiKey = ref('')
const initialApiKey = ref('')

const modelMetadata = ref<Record<string, { label: string; description?: string }>>({})

const modelSettings = ref<ModelSettings>({
  pricing: {},
  selection: {}
})

const orderedOperations = computed(() => {
  const allOps = Object.keys(modelSettings.value.selection)
  const priority = [
    'raw-transcript', 'corrected-transcript', 'intent', 
    'timeline-new', 'timeline-edit', 'thumbnail', 
    'scene-description', 'image-extraction', 'image-intent', 
    'image-generation', 'image-upscale'
  ]
  return priority.filter(op => allOps.includes(op))
})

const getOpLabel = (op: string) => {
  if (op === 'thumbnail') return 'Thumbnail Generation'
  if (op === 'scene-description') return 'Scene Description'
  if (op === 'image-extraction') return 'Image Analysis'
  if (op === 'image-intent') return 'Image Instruction'
  if (op === 'image-generation') return 'Image Generation'
  if (op === 'image-upscale') return 'Image Upscaling'
  return String(op).replace('-', ' ')
}

const availableModels = computed(() => Object.keys(modelSettings.value.pricing))

const getModelsForOp = (op: string) => {
  const all = availableModels.value
  if (op === 'image-upscale' || op === 'image-generation' || op === 'thumbnail') {
    // Only show models that support image output (based on whether image pricing is defined)
    return all.filter(m => modelSettings.value.pricing[m]?.output?.image !== undefined)
  }
  return all
}

const getModelLabel = (mName: string) => {
  return modelMetadata.value[mName]?.label || mName
}

const fetchSettings = async () => {
  tempDir.value = await (window as any).api.getTempDir()
  isTempDirUnsafe.value = await (window as any).api.isTempDirUnsafe()
  const key = await (window as any).api.getGeminiApiKey()
  if (key) {
    apiKey.value = key
    initialApiKey.value = key
  }

  const mMetadata = await (window as any).api.getModelMetadata()
  if (mMetadata) {
    modelMetadata.value = mMetadata
  }

  const mSettings = await (window as any).api.getModelSettings()
  if (mSettings) {
    // Failsafe: Ensure all default operations are present if missing
    const priority = [
      'raw-transcript', 'corrected-transcript', 'intent', 
      'timeline-new', 'timeline-edit', 'thumbnail', 
      'scene-description', 'image-extraction', 'image-intent', 
      'image-generation', 'image-upscale'
    ]
    
    // Auto-fix missing selections using defaults if they don't exist
    priority.forEach(op => {
      if (!mSettings.selection[op]) {
        // We don't have the full defaults object here easily, but we can assume common sense or just let it be.
        // Actually, the SettingsManager.mergeModelSettings already handles this on the backend!
        // But for local ref state, we might want to ensure they exist.
      }
    })
    
    // Apply to ref
    modelSettings.value = mSettings
  }
}

const handleChange = async () => {
  const result = await (window as any).api.setTempDir()
  if (result) {
    tempDir.value = result
    isTempDirUnsafe.value = await (window as any).api.isTempDirUnsafe()
    
    // Refresh threads and go home
    await videoStore.fetchThreads()
    router.push('/home')
  }
}

const handleOpen = () => {
  ; (window as any).api.openTempDir()
}

const handleReset = async () => {
  const result = await (window as any).api.resetTempDir()
  if (result) {
    tempDir.value = result
    isTempDirUnsafe.value = await (window as any).api.isTempDirUnsafe()
    
    // Refresh threads and go home
    await videoStore.fetchThreads()
    router.push('/home')
  }
}

const handleSaveApiKey = async () => {
  if (apiKey.value) {
    await (window as any).api.setGeminiApiKey(apiKey.value)
    initialApiKey.value = apiKey.value
  }
}

const handleSaveModelSettings = async () => {
  await (window as any).api.setModelSettings(toRaw(modelSettings.value))
}

const handleResetModels = async () => {
  const ok = await dialog.confirm({
    title: 'Reset models',
    message: 'Reset model selection to defaults?',
    confirmLabel: 'Reset'
  })
  if (ok) {
    const mSettings = await (window as any).api.resetModelSettings()
    modelSettings.value.selection = mSettings.selection
  }
}

const handleResetPricing = async () => {
  const ok = await dialog.confirm({
    title: 'Reset pricing',
    message: 'Reset model pricing to defaults?',
    confirmLabel: 'Reset'
  })
  if (ok) {
    const mSettings = await (window as any).api.resetModelSettings()
    modelSettings.value.pricing = mSettings.pricing
  }
}

const handleDeleteAll = async () => {
  const ok = await dialog.confirm({
    title: 'Delete all data',
    message: 'Are you sure you want to delete all data? This cannot be undone.',
    confirmLabel: 'Delete all data',
    danger: true
  })
  if (ok) {
    await videoStore.deleteAllThreads()
    await dialog.notify({ title: 'Data deleted', message: 'All data deleted successfully.', tone: 'success' })
  }
}

onMounted(() => {
  fetchSettings()
})
</script>
