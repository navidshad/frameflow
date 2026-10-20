<template>
  <div class="h-screen flex flex-col bg-transparent transition-colors duration-300 overflow-hidden relative">
    <div class="container mx-auto px-6 py-12 max-w-7xl flex flex-col h-full z-10 relative">
      <!-- Header -->
      <PageHeader
        title="Settings"
        subtitle="Configure application preferences and manage your data."
        :show-back="true"
      >
        <template #back>
          <IconButton @click="router.back()" icon="IconArrowLeft" size="sm" class="bg-white/50 dark:bg-zinc-800/50 backdrop-blur-md" />
        </template>
      </PageHeader>

      <div class="flex-1 overflow-y-auto -mx-6 px-6 pb-8 custom-scrollbar">
        <div class="max-w-4xl mx-auto space-y-8 pb-12">
          <!-- Temp Directory section -->
          <Card
            class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
            <div class="flex items-center space-x-5 mb-8">
              <div
                class="w-14 h-14 rounded-lg bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400 border border-blue-100 dark:border-blue-500/20">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M20 10V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6" />
                  <path d="M12 2v10l3-3 3 3V2" />
                </svg>
              </div>
              <div>
                <h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">Temporary Directory</h3>
                <p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Location where intermediate files are stored</p>
              </div>
            </div>

            <div class="space-y-6">
              <div
                class="p-5 bg-zinc-50 dark:bg-zinc-950/50 rounded-lg border border-zinc-200 dark:border-zinc-800 font-mono text-sm text-zinc-600 dark:text-zinc-400 break-all relative group">
                {{ tempDir || 'Loading...' }}
                
                <div v-if="isTempDirUnsafe" class="mt-4 flex items-start gap-3 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-400 font-sans animate-in fade-in slide-in-from-top-2 duration-300">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <div class="text-xs">
                    <p class="font-bold mb-0.5">Unstable Storage Location</p>
                    <p class="opacity-80 leading-relaxed">This folder may be cleared by the OS. Use a persistent directory to keep your project artifacts safe.</p>
                  </div>
                </div>
              </div>

              <div class="flex gap-4 justify-between">
                <Button @click="handleChange" outline color="secondary" size="sm" label="Change Location" class="w-full"/>
                <Button @click="handleOpen" color="primary" size="sm" label="Open Folder" class="w-full"/>
                <Button @click="handleReset" size="sm" label="Reset to Default" class="w-full"/>
              </div>
            </div>
          </Card>

          <!-- Agent access (MCP) — board 4's lower card -->
          <AgentAccessCard />

          <!-- Gemini API Key section -->
          <Card
            class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
            <div class="flex items-center space-x-5 mb-8">
              <div
                class="w-14 h-14 rounded-lg bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400 border border-amber-100 dark:border-amber-500/20">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 2l-2 2" />
                  <circle cx="7" cy="13" r="5" />
                  <path d="M11 9l9-9 3 3-3 3-4 4-4-4" />
                  <path d="M13 13l4 4" />
                </svg>
              </div>
              <div>
                <h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">Gemini API Key</h3>
                <p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Your secret API key for Gemini services</p>
              </div>
            </div>

            <div class="space-y-4">
              <Input v-model="apiKey" type="password" placeholder="Enter API Key..."/>
              <Button @click="handleSaveApiKey" :disabled="!apiKey || apiKey === initialApiKey" size="sm" class="w-full disabled:!bg-zinc-100 dark:disabled:!bg-zinc-800 disabled:!text-zinc-400 dark:disabled:!text-zinc-600 transition-all font-bold" label="Save API Key" />
            </div>
          </Card>
          
          <!-- Model Selection section -->
          <Card
            class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
            <div class="flex items-center justify-between mb-8">
              <div class="flex items-center space-x-5">
                <div
                  class="w-14 h-14 rounded-lg bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center text-purple-600 dark:text-purple-400 border border-purple-100 dark:border-purple-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round"
                    stroke-linejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z" />
                    <path d="m2 17 10 5 10-5" />
                    <path d="m2 12 10 5 10-5" />
                  </svg>
                </div>
                <div>
                  <h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">Model Selection</h3>
                  <p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Assign models to specific operations</p>
                </div>
              </div>
              <Button @click="handleResetModels" outline size="xs" label="Reset Models" />
            </div>

            <div class="space-y-4">
              <div v-for="op in orderedOperations" :key="op"
                class="flex items-center justify-between p-4 bg-zinc-50 dark:bg-zinc-950/50 rounded-lg border border-zinc-200 dark:border-zinc-800 hover:border-purple-500/30 transition-colors">
                <span class="text-sm font-bold text-zinc-700 dark:text-zinc-300 capitalize">{{
                  getOpLabel(op) }}</span>
                <select v-model="modelSettings.selection[op]" @change="handleSaveModelSettings"
                  class="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg px-4 py-2 text-sm text-zinc-900 dark:text-white focus:ring-2 focus:ring-purple-500 outline-none transition-all cursor-pointer font-medium hover:border-purple-500/50">
                  <option v-for="mName in getModelsForOp(op)" :key="mName" :value="mName">{{ getModelLabel(mName) }}
                  </option>
                </select>
              </div>
            </div>
          </Card>

          <!-- Model Pricing section -->
          <Card
            class="!bg-white/90 dark:!bg-zinc-900/90 backdrop-blur-xl !rounded-lg border !border-zinc-200 dark:!border-zinc-700 !p-8">
            <div class="flex items-center justify-between mb-8">
              <div class="flex items-center space-x-5">
                <div
                  class="w-14 h-14 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400 border border-emerald-100 dark:border-emerald-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round"
                    stroke-linejoin="round">
                    <line x1="12" y1="1" x2="12" y2="23" />
                    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                  </svg>
                </div>
                <div>
                  <h3 class="font-heading font-bold text-xl text-zinc-900 dark:text-white">Model Pricing</h3>
                  <p class="text-sm text-zinc-500 dark:text-zinc-400 font-medium">Configure cost per 1M tokens (USD)</p>
                </div>
              </div>
              <Button @click="handleResetPricing" outline size="xs" label="Reset Pricing" />
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-left text-sm">
                <thead>
                  <tr
                    class="text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
                    <th class="pb-4 pr-4 font-bold uppercase tracking-wider text-xs">Model</th>
                    <th class="pb-4 px-4 font-bold uppercase tracking-wider text-xs text-center">Input (Std)</th>
                    <th class="pb-4 px-4 font-bold uppercase tracking-wider text-xs text-center">Output (Std)</th>
                    <th class="pb-4 px-4 font-bold uppercase tracking-wider text-xs text-center">Output (Image)</th>
                    <th class="pb-4 pl-4 font-bold uppercase tracking-wider text-xs text-center">Input (Audio)</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-zinc-100 dark:divide-zinc-800/50">
                  <tr v-for="(pricing, mName) in modelSettings.pricing" :key="mName" class="group hover:bg-zinc-50/50 dark:hover:bg-zinc-800/20 transition-colors">
                    <td class="py-5 pr-4">
                      <div class="font-bold text-zinc-900 dark:text-white truncate max-w-[150px]"
                        :title="String(mName)">{{ getModelLabel(mName) }}</div>
                      <div class="text-[10px] text-zinc-400 font-medium truncate max-w-[150px] mt-0.5 opacity-60" :title="String(mName)">{{ mName }}</div>
                    </td>
                    <td class="py-5 px-2">
                      <div class="flex items-center justify-center">
                        <span class="text-zinc-400 mr-1.5 font-mono">$</span>
                        <input type="number" step="0.01" v-model.number="pricing.input.standard"
                          @change="handleSaveModelSettings"
                          class="w-20 bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2 py-1.5 text-center outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-xs" />
                      </div>
                    </td>
                    <td class="py-5 px-2">
                      <div class="flex items-center justify-center">
                        <span class="text-zinc-400 mr-1.5 font-mono">$</span>
                        <input type="number" step="0.01" v-model.number="pricing.output.standard"
                          @change="handleSaveModelSettings"
                          class="w-20 bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2 py-1.5 text-center outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-xs" />
                      </div>
                    </td>
                    <td class="py-5 px-2">
                      <div class="flex items-center justify-center">
                        <template v-if="pricing.output.image !== undefined">
                          <span class="text-zinc-400 mr-1.5 font-mono">$</span>
                          <input type="number" step="0.0001" v-model.number="pricing.output.image"
                            @change="handleSaveModelSettings"
                            class="w-24 bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2 py-1.5 text-center outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-xs" />
                        </template>
                        <template v-else>
                          <span class="text-zinc-400 font-mono opacity-30">—</span>
                        </template>
                      </div>
                    </td>
                    <td class="py-5 pl-2">
                      <div class="flex items-center justify-center">
                        <template v-if="pricing.input.audio !== undefined">
                          <span class="text-zinc-400 mr-1.5 font-mono">$</span>
                          <input type="number" step="0.01" v-model.number="pricing.input.audio"
                            @change="handleSaveModelSettings"
                            class="w-20 bg-zinc-50 dark:bg-zinc-950/50 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2 py-1.5 text-center outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-xs" />
                        </template>
                        <template v-else>
                          <span class="text-zinc-400 font-mono opacity-30">—</span>
                        </template>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <!-- Danger Zone -->
          <Card
            class="!bg-red-50/50 dark:!bg-red-900/10 backdrop-blur-xl !rounded-lg border !border-red-200 dark:!border-red-500/20 !p-8 hover:border-red-300 dark:hover:border-red-500/30 transition-colors">
            <div class="flex items-center space-x-5 mb-6">
              <div
                class="w-14 h-14 rounded-lg bg-red-100 dark:bg-red-500/20 flex items-center justify-center text-red-600 dark:text-red-400">
                <svg xmlns="http://www.w3.org/2000/svg" class="w-7 h-7" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </div>
              <div>
                <h3 class="font-heading font-bold text-xl text-red-600 dark:text-red-400">Danger Zone</h3>
                <p class="text-sm text-red-500/70 dark:text-red-400/70 font-medium">Irreversible actions</p>
              </div>
            </div>

            <div class="space-y-6">
              <p class="text-sm text-zinc-600 dark:text-red-200/80 font-medium">
                Permanently delete all chats, video summaries, and cached files. This action cannot be
                undone.
              </p>
              <Button @click="handleDeleteAll" label="Delete All Data" outline color="danger" class="w-full" />
            </div>
          </Card>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed, toRaw } from 'vue'
import { useRouter } from 'vue-router'
import { Button, IconButton, Card } from 'pilotui/elements'
import { Input } from 'pilotui/form'
import { useVideoStore } from '../stores/videoStore'
import PageHeader from '../components/PageHeader.vue'
import AgentAccessCard from '../components/settings/AgentAccessCard.vue'
import { ModelSettings } from '../../../shared/types'
// In a real scenario we'd import constants, but we can also use the IPC-returned defaults if we added a method.
// For now, we'll manually ensure the new model and selection are present if missing.
const router = useRouter()
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
  if (confirm('Reset model selection to defaults?')) {
    const mSettings = await (window as any).api.resetModelSettings()
    modelSettings.value.selection = mSettings.selection
  }
}

const handleResetPricing = async () => {
  if (confirm('Reset model pricing to defaults?')) {
    const mSettings = await (window as any).api.resetModelSettings()
    modelSettings.value.pricing = mSettings.pricing
  }
}

const handleDeleteAll = async () => {
  if (confirm('Are you sure you want to delete all data? This cannot be undone.')) {
    await videoStore.deleteAllThreads()
    alert('All data deleted successfully.')
  }
}

onMounted(() => {
  fetchSettings()
})
</script>
