<template>
  <section class="panel unified-composer">
    <div class="composer-row">
      <button
        class="btn"
        :class="{ active: listening }"
        :disabled="!speechSupported || disabled"
        @click="toggleSpeech"
      >
        {{ listening ? '停止' : '语音' }}
      </button>

      <input
        v-model="draft"
        class="composer-input"
        type="text"
        placeholder="输入消息，或点击语音按钮说话"
        :disabled="disabled"
        @keydown.enter.prevent="send"
      />

      <button class="btn primary" :disabled="!canSend" @click="send">发送</button>
      <button class="btn" :disabled="!canPlayTts || ttsLoading" @click="$emit('play-tts')">
        {{ ttsLoading ? '播报中' : '播报' }}
      </button>
      <button class="btn" :disabled="!ttsPlaying" @click="$emit('stop-tts')">停止</button>
    </div>

    <p class="status-text">
      {{ statusText }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

type SpeechCtor = new () => SpeechRecognitionLike

const props = defineProps<{
  disabled?: boolean
  canPlayTts?: boolean
  ttsLoading?: boolean
  ttsPlaying?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  'play-tts': []
  'stop-tts': []
}>()

const draft = ref('')
const listening = ref(false)
const speechError = ref('')
const speechSupported =
  typeof window !== 'undefined' &&
  Boolean((window as typeof window & { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor })
    .SpeechRecognition ||
    (window as typeof window & { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor })
      .webkitSpeechRecognition)

let recognition: SpeechRecognitionLike | null = null

const canSend = computed(() => !!draft.value.trim() && !props.disabled)
const statusText = computed(() => {
  if (!speechSupported) return '当前浏览器不支持语音识别，请使用文本输入。'
  if (speechError.value) return speechError.value
  return listening.value ? '语音识别中...' : '语音输入待命'
})

function getSpeechCtor(): SpeechCtor | null {
  const maybeWindow = window as typeof window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  return maybeWindow.SpeechRecognition || maybeWindow.webkitSpeechRecognition || null
}

function setupRecognition() {
  const Ctor = getSpeechCtor()
  if (!Ctor) return null

  const instance = new Ctor()
  instance.lang = 'zh-CN'
  instance.interimResults = true
  instance.continuous = false
  instance.onresult = event => {
    const e = event as { results?: ArrayLike<ArrayLike<{ transcript?: string; isFinal?: boolean }>> }
    let transcript = ''
    if (!e.results) return
    for (let i = 0; i < e.results.length; i += 1) {
      const item = e.results[i]
      if (!item || !item[0]) continue
      transcript += item[0].transcript || ''
    }
    draft.value = transcript.trim()
  }
  instance.onerror = () => {
    listening.value = false
    speechError.value = '语音识别失败，请重试或改用文本输入。'
  }
  instance.onend = () => {
    listening.value = false
  }
  return instance
}

function toggleSpeech() {
  if (props.disabled) return
  speechError.value = ''
  if (!speechSupported) return

  if (!recognition) {
    recognition = setupRecognition()
  }
  if (!recognition) return

  if (!listening.value) {
    recognition.start()
    listening.value = true
    return
  }

  recognition.stop()
  listening.value = false
}

function send() {
  const text = draft.value.trim()
  if (!text || props.disabled) return
  emit('send', text)
  draft.value = ''
}

onBeforeUnmount(() => {
  recognition?.stop()
  recognition = null
})
</script>

<style scoped>
.unified-composer {
  margin-top: 12px;
}

.composer-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.composer-input {
  flex: 1;
  min-width: 0;
}

.btn {
  white-space: nowrap;
}

.btn.active {
  background: #ffe7ba;
}

.btn.primary {
  background: #1570ef;
  color: #fff;
  border-color: #1570ef;
}

.status-text {
  margin-top: 8px;
  color: #667085;
  font-size: 12px;
}
</style>
