<template>
	<div class="h-full flex flex-col bg-ground overflow-hidden">
		<AppTopBar brand :show-settings="false" />

		<div class="flex-1 min-h-0 flex">
			<!-- Step rail -->
			<aside class="w-[400px] shrink-0 hair-r px-12 py-16 flex flex-col max-lg:hidden">
				<div class="font-heading font-black text-[30px] tracking-[-0.02em] leading-[1.1]">Set up FrameFlow</div>
				<p class="mt-2.5 text-zinc-500 dark:text-zinc-400 leading-normal">Three things, once. You can change any of them later in Settings.</p>
				<ol class="mt-9 hair-t">
					<li v-for="(s, i) in steps" :key="s.title" class="flex gap-3.5 py-3.5 hair-b"
						:class="i === step ? 'shadow-[inset_2px_0_0_rgb(var(--primary))]' : ''" :aria-current="i === step ? 'step' : undefined">
						<span class="w-[22px] h-[22px] rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold font-mono"
							:class="i < step ? 'bg-accent/15 text-accent-dark dark:text-accent-light'
								: i === step ? 'bg-primary text-white' : 'bg-zinc-900/[0.07] dark:bg-white/[0.08] text-zinc-500 dark:text-zinc-400'">
							{{ i < step ? '✓' : i + 1 }}
						</span>
						<div class="min-w-0">
							<div class="font-semibold" :class="i > step ? 'text-zinc-500 dark:text-zinc-400' : ''">{{ s.title }}</div>
							<div class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400 truncate" :class="i < step && s.mono ? 'font-mono' : ''">{{ i < step ? s.done : s.sub }}</div>
						</div>
					</li>
				</ol>
				<div class="flex-1"></div>
				<p class="text-[11px] text-zinc-500 leading-normal">Nothing is saved until you press Start on the last step.</p>
			</aside>

			<!-- Step body -->
			<main class="flex-1 min-w-0 overflow-y-auto custom-scrollbar">
				<div class="w-[600px] max-w-full px-10 lg:pl-[120px] lg:pr-0 box-content pt-20 pb-16">
					<!-- 1. Folder -->
					<section v-if="step === 0">
						<div class="lbl">Step 1 of 3</div>
						<h1 class="mt-2.5 font-heading font-bold text-[30px] tracking-[-0.01em]">Where should projects live?</h1>
						<p class="mt-2.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">Each project keeps its media, renders and cache in this folder on your computer. Pick a place that is backed up and not cleared by the system.</p>

						<label class="lbl block mt-8" for="proj-folder">Projects folder</label>
						<div class="mt-2 flex items-center gap-2.5 h-10" style="border-bottom: 1px solid var(--ff-hairline-strong)">
							<span class="iconify tabler--folder w-4 h-4 text-primary shrink-0"></span>
							<input id="proj-folder" class="flex-1 bg-transparent outline-none font-mono text-[13px] min-w-0" :value="folderShown" readonly />
							<button class="btn-text btn-text-primary" @click="chooseFolder">Choose…</button>
						</div>
						<p v-if="folderCheck && !folderCheck.ok" class="mt-2 flex items-center gap-2 text-xs text-red-500 dark:text-red-400" role="alert">
							<span class="iconify tabler--alert-circle w-3.5 h-3.5 shrink-0"></span>{{ folderCheck.reason }}
						</p>
						<p v-else class="mt-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
							<span class="iconify tabler--check w-3.5 h-3.5 text-accent shrink-0"></span>
							<span>{{ folderIsSuggested ? 'Suggested. ' : '' }}Created when you press Start.
								<template v-if="freeGb"> <span class="font-mono text-zinc-700 dark:text-zinc-300">{{ freeGb }}</span> free on this disk.</template></span>
						</p>

						<div class="mt-7 hair-t">
							<div class="flex gap-3 py-3.5 hair-b">
								<span class="iconify tabler--list w-4 h-4 mt-px text-zinc-500 shrink-0"></span>
								<div class="leading-normal"><div class="font-semibold">Already have FrameFlow projects?</div><div class="text-xs text-zinc-500 dark:text-zinc-400">Choose that folder and they show up on Home.</div></div>
							</div>
							<div class="flex gap-3 py-3.5 hair-b">
								<span class="iconify tabler--alert-triangle w-4 h-4 mt-px text-amber-500 shrink-0"></span>
								<div class="leading-normal"><div class="font-semibold">Pick a folder you keep</div><div class="text-xs text-zinc-500 dark:text-zinc-400">System temporary folders are not allowed: the OS can clear them.</div></div>
							</div>
						</div>

						<div class="mt-10 flex items-center gap-5">
							<button class="btn-fill !h-10 !px-[22px] !text-[13px] !gap-2" :disabled="!folderCheck?.ok" @click="step = 1">
								Continue <span class="iconify tabler--arrow-right w-3.5 h-3.5"></span>
							</button>
						</div>
					</section>

					<!-- 2. Keys -->
					<section v-else-if="step === 1">
						<div class="lbl">Step 2 of 3</div>
						<h1 class="mt-2.5 font-heading font-bold text-[30px] tracking-[-0.01em]">Connect your AI keys</h1>
						<p class="mt-2.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">Keys stay on this computer. Each one is checked with a small test call when you paste it.</p>

						<div class="mt-8 flex items-center gap-2.5">
							<label for="gem-key" class="font-bold text-sm">Gemini API key</label>
							<span class="tag bg-primary/15 text-primary">Required</span>
						</div>
						<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-normal">Transcripts, scene descriptions, image generation, and the Gemini engine.</p>
						<div class="mt-2.5 flex items-center gap-2.5 h-10" style="border-bottom: 1px solid var(--ff-hairline-strong)">
							<input id="gem-key" v-model="geminiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste your Gemini API key"
								class="flex-1 bg-transparent outline-none font-mono text-[13px] min-w-0" @input="onKeyInput" @paste="onKeyPaste" @keydown.enter="testKey" />
							<span v-if="keyState === 'checking'" class="flex items-center gap-1.5 text-xs font-semibold text-zinc-500">
								<span class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin"></span>Checking…
							</span>
							<span v-else-if="keyState === 'ok'" class="flex items-center gap-1.5 text-xs font-semibold text-accent-dark dark:text-accent-light">
								<span class="iconify tabler--check w-3.5 h-3.5"></span>Key works
							</span>
							<button v-else-if="geminiKey.trim()" class="btn-text btn-text-primary" @click="testKey">Check</button>
						</div>
						<p v-if="keyState === 'bad'" class="mt-2 text-xs text-red-500 dark:text-red-400" role="alert">{{ keyError }}</p>
						<p class="mt-2 text-xs">
							<a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer"
								class="text-primary hover:text-primary-dark border-b border-dotted border-primary transition-colors">Get a key from Google AI Studio</a>
						</p>

						<div class="mt-8 flex items-center gap-2.5">
							<label for="el-key" class="font-bold text-sm">ElevenLabs API key</label>
							<span class="tag bg-zinc-900/[0.07] dark:bg-white/[0.07] text-zinc-500 dark:text-zinc-400">Optional</span>
						</div>
						<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-normal">Generated voices, sound effects and music. The built-in synth works without it.</p>
						<div class="mt-2.5 flex items-center gap-2.5 h-10" style="border-bottom: 1px solid var(--ff-hairline-strong)">
							<input id="el-key" v-model="elevenLabsKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste key, or skip"
								class="flex-1 bg-transparent outline-none font-mono text-[13px] min-w-0" />
						</div>
						<p class="mt-2 text-xs text-zinc-500">Skipping is fine. Add it later under Settings › Audio providers.</p>

						<div class="mt-8 flex items-center gap-5">
							<button class="btn-fill !h-10 !px-[22px] !text-[13px] !gap-2" :disabled="keyState !== 'ok'" @click="step = 2">
								Continue <span class="iconify tabler--arrow-right w-3.5 h-3.5"></span>
							</button>
							<button class="btn-text !h-10 !text-[13px] !text-zinc-700 dark:!text-zinc-300" @click="step = 0">Back</button>
						</div>
					</section>

					<!-- 3. Engine -->
					<section v-else>
						<div class="lbl">Step 3 of 3</div>
						<h1 class="mt-2.5 font-heading font-bold text-[30px] tracking-[-0.01em]">Who edits when you chat?</h1>
						<p class="mt-2.5 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">The AI that changes your timeline and images. Switch any time from the engine chip in the chat bar.</p>

						<div role="radiogroup" aria-label="AI engine" class="mt-6 hair-t">
							<label class="flex gap-3.5 py-4 hair-b cursor-pointer">
								<input v-model="engineId" type="radio" value="claude-code" class="mt-0.5 w-4 h-4 accent-primary" />
								<div class="flex-1 min-w-0">
									<div class="flex items-center gap-2.5">
										<span class="font-bold text-sm">Claude Code</span>
										<span class="tag" :class="claudeFound ? 'bg-accent/15 text-accent-dark dark:text-accent-light' : 'bg-zinc-900/[0.07] dark:bg-white/[0.07] text-zinc-500 dark:text-zinc-400'">{{ claudeTag }}</span>
										<span v-if="claudeFound" class="text-[11px] text-zinc-500">Recommended</span>
									</div>
									<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-normal">{{ ENGINES['claude-code'].blurb }}</p>
									<div class="mt-2.5 flex items-center gap-3 text-xs">
										<label for="claude-model" class="lbl !text-[9px]">Model</label>
										<select id="claude-model" v-model="claudeModel" class="field !w-[150px] !py-1" aria-label="Claude model" @click.stop>
											<option v-for="m in claudeModels" :key="m.value" :value="m.value">{{ m.label }}</option>
										</select>
										<span class="font-mono text-[11px] text-zinc-500 truncate">{{ claudeFound ? (claudeDetection?.displayPath || 'claude on your PATH') : 'not found on your PATH' }}</span>
									</div>
								</div>
							</label>
							<label class="flex gap-3.5 py-4 hair-b cursor-pointer">
								<input v-model="engineId" type="radio" value="gemini-api" class="mt-0.5 w-4 h-4 accent-primary" />
								<div class="flex-1">
									<div class="flex items-center gap-2.5">
										<span class="font-bold text-sm">Gemini API</span>
										<span class="tag bg-accent/15 text-accent-dark dark:text-accent-light">Ready</span>
									</div>
									<p class="mt-1 text-xs text-zinc-500 dark:text-zinc-400 leading-normal">One reply per turn, using the key from step 2. Costs show in the project header.</p>
								</div>
							</label>
						</div>

						<div class="lbl mt-7 !text-zinc-900 dark:!text-zinc-50">Before you start</div>
						<ul class="mt-2 hair-t">
							<li v-for="c in checks" :key="c.id" class="flex items-center gap-2.5 h-[34px] hair-b text-xs">
								<span class="iconify w-3.5 h-3.5 shrink-0"
									:class="c.state === 'ok' ? 'tabler--check text-accent' : c.state === 'bad' ? 'tabler--x text-red-500' : 'tabler--minus text-zinc-500'"></span>
								<span class="flex-1 text-zinc-700 dark:text-zinc-200">{{ c.label }}</span>
								<span class="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 truncate max-w-[55%]">{{ c.detail }}</span>
							</li>
						</ul>

						<p v-if="startError" class="mt-4 text-xs text-red-500 dark:text-red-400" role="alert">{{ startError }}</p>
						<div class="mt-7 flex items-center gap-5">
							<button class="btn-fill !h-10 !px-[22px] !text-[13px] !gap-2" :disabled="!canStart || starting" @click="start">
								<span v-if="starting" class="iconify tabler--loader-2 w-3.5 h-3.5 animate-spin"></span>
								Start using FrameFlow <span v-if="!starting" class="iconify tabler--arrow-right w-3.5 h-3.5"></span>
							</button>
							<button class="btn-text !h-10 !text-[13px] !text-zinc-700 dark:!text-zinc-300" :disabled="starting" @click="step = 1">Back</button>
						</div>
					</section>
				</div>
			</main>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CLI_MODELS, ENGINES, asSetIn, type EngineId } from '@shared/engines'
import { buildChecks, checksPass, tildePath, type KeyTestResult } from '@shared/setup'
import AppTopBar from '../components/AppTopBar.vue'
import { useEngineStore } from '../stores/engineStore'
import { WELCOME_KEY } from '../utils/setupWelcome'

/**
 * First-launch setup. Everything here is local state until Start: the folder
 * is only suggested or picked, the keys only held and tested. The one commit is
 * `setupComplete`, so a quit halfway leaves nothing half-configured.
 */
const api = (window as any).api
const router = useRouter()
const engine = useEngineStore()

const step = ref(0)
const home = ref('')
const suggested = ref('')
const folder = ref('')
const folderCheck = ref<{ ok: boolean; reason?: string; writable: boolean; freeBytes?: number } | null>(null)
const ffmpeg = ref<{ available: boolean; version?: string }>({ available: true })

const geminiKey = ref('')
const keyState = ref<'idle' | 'checking' | 'ok' | 'bad'>('idle')
const keyError = ref('')
const elevenLabsKey = ref('')

const engineId = ref<EngineId>('gemini-api')
const claudeModel = ref('opus')
const starting = ref(false)
const startError = ref('')

const folderShown = computed(() => tildePath(folder.value, home.value))
const folderIsSuggested = computed(() => folder.value === suggested.value)
const freeGb = computed(() => folderCheck.value?.freeBytes ? `${Math.round(folderCheck.value.freeBytes / 1e9)} GB` : '')

const steps = computed(() => [
	{ title: 'Projects folder', sub: 'Where everything is saved', done: folderShown.value, mono: true },
	{ title: 'AI keys', sub: 'Gemini, and ElevenLabs if you have it', done: `Gemini works · ElevenLabs ${elevenLabsKey.value.trim() ? 'added' : 'skipped'}`, mono: false },
	{ title: 'AI engine', sub: 'Who edits when you chat', done: ENGINES[engineId.value].label, mono: false }
])

const claudeDetection = computed(() => engine.detectionFor('claude-code'))
const claudeFound = computed(() => !!claudeDetection.value && claudeDetection.value.status !== 'missing')
const claudeTag = computed(() => !claudeDetection.value ? 'Looking…' : claudeFound.value ? (claudeDetection.value.status === 'signed-out' ? 'Signed out' : 'Found') : 'Not found')
const claudeModels = computed(() => {
	const reported = claudeDetection.value?.models || []
	return [...(reported.length ? reported : CLI_MODELS['claude-code']), { value: '', label: asSetIn('claude-code') }]
})

const checks = computed(() => buildChecks({
	ffmpeg: ffmpeg.value,
	folder: folderShown.value,
	folderWritable: !!folderCheck.value?.writable,
	geminiKeyOk: keyState.value === 'ok',
	elevenLabsKey: !!elevenLabsKey.value.trim()
}))
const canStart = computed(() => checksPass(checks.value))

const applyFolder = async (path: string, check?: typeof folderCheck.value) => {
	folder.value = path
	folderCheck.value = check ?? await api.setupCheckFolder(path)
}

const chooseFolder = async () => {
	const picked = await api.setupPickFolder()
	if (picked) await applyFolder(picked.path, picked.check)
}

// Any edit voids the last answer: Continue must never be live for a key that was not the one tested.
let debounce: ReturnType<typeof setTimeout> | undefined
const onKeyInput = () => {
	keyState.value = 'idle'
	keyError.value = ''
	clearTimeout(debounce)
	if (geminiKey.value.trim().length >= 20) debounce = setTimeout(testKey, 700)
}
const onKeyPaste = () => setTimeout(testKey, 0)

const testKey = async () => {
	clearTimeout(debounce)
	const key = geminiKey.value.trim()
	if (!key || keyState.value === 'checking') return
	keyState.value = 'checking'
	const result: KeyTestResult = await api.setupTestGeminiKey(key)
	if (key !== geminiKey.value.trim()) return // edited while the call was out
	keyState.value = result.ok ? 'ok' : 'bad'
	keyError.value = result.error || ''
}

const start = async () => {
	starting.value = true
	startError.value = ''
	const result = await api.setupComplete({
		folder: folder.value,
		geminiKey: geminiKey.value.trim(),
		elevenLabsKey: elevenLabsKey.value.trim(),
		engine: {
			engine: engineId.value,
			...(engineId.value === 'claude-code' && claudeModel.value ? { models: { 'claude-code': claudeModel.value } } : {})
		}
	})
	if (!result?.ok) {
		starting.value = false
		startError.value = result?.error || 'Setup could not be saved.'
		return
	}
	try { sessionStorage.setItem(WELCOME_KEY, '1') } catch { /* the strip is a nicety */ }
	await router.replace('/home')
}

// Claude Code is the recommended engine once it is found; the user's pick after that wins.
let pickedEngine = false
watch(engineId, () => { pickedEngine = true })
watch(claudeFound, (found) => { if (found && !pickedEngine) engineId.value = 'claude-code' })

onMounted(async () => {
	const state = await api.setupState()
	home.value = state.home
	suggested.value = state.suggestedFolder
	ffmpeg.value = state.ffmpeg
	await applyFolder(state.suggestedFolder)
	await engine.load()
	engine.detect()
})
</script>

<style scoped>
.tag { @apply text-[10px] font-bold tracking-[.08em] uppercase px-1.5 py-0.5 rounded; }
</style>
