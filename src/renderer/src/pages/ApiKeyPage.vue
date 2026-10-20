<template>
  <div class="h-full flex flex-col bg-ground overflow-hidden">
    <!-- Every other page sends you here until a key is saved, so no Settings button. -->
    <AppTopBar brand :show-settings="false" />

    <div class="flex-1 overflow-y-auto custom-scrollbar">
      <form class="mx-auto w-full max-w-[400px] px-6 pt-[18vh] pb-16" @submit.prevent="saveKey">
        <h1 class="font-heading font-bold text-[26px] tracking-tight">Gemini API Key</h1>
        <p class="mt-2 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">Please provide your Gemini API key to get started.</p>

        <label for="api-key" class="sr-only">Gemini API key</label>
        <input id="api-key" v-model="apiKey" type="password" placeholder="Enter API Key…" autocomplete="off" autofocus
          class="field mt-7 !h-9 !text-sm font-mono" />

        <p class="mt-2.5 text-xs">
          <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
            class="text-primary hover:text-primary-dark border-b border-dotted border-primary transition-colors">Get your key here</a>
        </p>

        <button type="submit" :disabled="!apiKey" class="btn-fill mt-[26px] w-full !h-[38px] !text-[13px]">Continue</button>

        <p class="mt-3 text-[11px] leading-relaxed text-zinc-500">
          Continue stays dimmed until there is a key. The key is stored on this computer.
        </p>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import AppTopBar from '../components/AppTopBar.vue'

const apiKey = ref('')
const router = useRouter()

onMounted(async () => {
  const existingKey = await (window as any).api.getGeminiApiKey()
  if (existingKey) {
    router.push('/home')
  }
})

const saveKey = async () => {
  if (apiKey.value) {
    await (window as any).api.setGeminiApiKey(apiKey.value)
    router.push('/home')
  }
}
</script>
