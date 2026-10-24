<template>
  <div class="h-full flex flex-col bg-ground overflow-hidden">
    <AppTopBar title="Settings" show-back :show-settings="false" @back="router.back()" />

    <div class="flex-1 min-h-0 flex">
      <nav aria-label="Settings sections" class="w-[248px] shrink-0 box-border px-4 py-6 hair-r flex flex-col gap-0.5">
        <button v-for="s in SECTIONS" :key="s.id" type="button"
          class="flex items-center gap-3 h-[38px] px-3 rounded-md text-[13px] text-left transition"
          :class="section === s.id
            ? 'font-semibold text-zinc-900 dark:text-zinc-50 bg-zinc-500/10 shadow-[inset_2px_0_0_rgb(var(--primary))]'
            : 'font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200'"
          :aria-current="section === s.id ? 'page' : undefined" @click="section = s.id">
          <span class="iconify w-4 h-4 shrink-0" :class="s.icon"></span>{{ s.label }}
        </button>
      </nav>

      <main class="flex-1 min-w-0 overflow-y-auto custom-scrollbar flat-fields">
        <div class="max-w-[820px] pl-[72px] pr-10 pt-10 pb-12 max-lg:pl-10 box-content">
          <GeneralSection v-if="section === 'general'" />
          <ConnectionsSection v-else-if="section === 'connections'" />
          <VideoSection v-else-if="section === 'video'" />
          <ImageSection v-else-if="section === 'image'" />
          <AudioSection v-else-if="section === 'audio'" />
          <AgentSection v-else-if="section === 'agent'" />
          <UsageSection v-else />
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '../components/AppTopBar.vue'
import GeneralSection from '../components/settings/GeneralSection.vue'
import ConnectionsSection from '../components/settings/ConnectionsSection.vue'
import VideoSection from '../components/settings/VideoSection.vue'
import ImageSection from '../components/settings/ImageSection.vue'
import AudioSection from '../components/settings/AudioSection.vue'
import AgentSection from '../components/settings/AgentSection.vue'
import UsageSection from '../components/settings/UsageSection.vue'
import { useModelSettings } from '../components/settings/useModelSettings'

const SECTIONS = [
  { id: 'general', label: 'General', icon: 'tabler--folder' },
  { id: 'connections', label: 'Connections', icon: 'tabler--link' },
  { id: 'video', label: 'Video editing', icon: 'tabler--movie' },
  { id: 'image', label: 'Image editing', icon: 'tabler--photo' },
  { id: 'audio', label: 'Audio', icon: 'tabler--wave-square' },
  { id: 'agent', label: 'Agent access', icon: 'tabler--plug' },
  { id: 'usage', label: 'Usage and pricing', icon: 'tabler--receipt' }
] as const
type SectionId = (typeof SECTIONS)[number]['id']

const router = useRouter()

// The last section stays open between visits. Storage can be blocked, so it is optional.
const STORAGE_KEY = 'frameflow.settings.section'
const remembered = (): SectionId => {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return SECTIONS.some((s) => s.id === v) ? (v as SectionId) : 'general'
  } catch {
    return 'general'
  }
}
const section = ref<SectionId>(remembered())
watch(section, (v) => {
  try { localStorage.setItem(STORAGE_KEY, v) } catch { /* not remembered */ }
})

onMounted(() => useModelSettings().load())
</script>
