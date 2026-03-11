<template>
  <section class="panel" style="margin-bottom: 12px">
    <strong>实时连接:</strong>
    <span v-if="chat.streamConnected" style="color: #067647"> 已连接 </span>
    <span v-else-if="chat.streamConnecting" style="color: #b54708"> 重连中... </span>
    <span v-else style="color: #b42318"> 未连接 </span>
    <span v-if="chat.streamReconnectCount > 0">（重连 {{ chat.streamReconnectCount }} 次）</span>
    <span v-if="chat.streamStale" style="color: #b42318">（连接超时，等待自动恢复）</span>
    <button
      v-if="!chat.realtimeUnsupported"
      style="margin-left: 8px"
      :disabled="chat.streamConnecting"
      @click="chat.reconnectStream"
    >
      立即重连
    </button>
    <p v-if="chat.connectionHint" style="margin-top: 8px; color: #b42318">{{ chat.connectionHint }}</p>
  </section>

  <section v-if="showDiag" class="panel" style="margin-bottom: 12px; font-size: 12px; color: #475467">
    <div>diag: roomId={{ chat.roomId || 'none' }} rooms={{ chat.rooms.length }} loadingRooms={{ chat.loadingRooms }}</div>
    <div>diag: messages={{ chat.messages.length }} loadingMessages={{ chat.loadingMessages }} loaded={{ chat.messagesLoaded }}</div>
    <div>diag: sessionId={{ chat.sessionId || 'none' }} streamConnected={{ chat.streamConnected }}</div>
    <div>
      diag: streamConnecting={{ chat.streamConnecting }} reconnectCount={{ chat.streamReconnectCount }}
      stale={{ chat.streamStale }} realtimeUnsupported={{ chat.realtimeUnsupported }}
    </div>
    <div>diag: sessionError={{ chat.sessionError || 'none' }}</div>
    <div>diag: streamError={{ chat.streamError || 'none' }}</div>
    <div>diag: lastError={{ chat.lastError || 'none' }}</div>
    <div>diag: connectionHint={{ chat.connectionHint || 'none' }}</div>
    <div>diag: roomNames={{ roomNamesText }}</div>
    <div>diag: tailMessages={{ tailMessagesText }}</div>
  </section>

  <section class="panel chat-shell">
    <header class="chat-head">
      <strong>{{ currentRoomName }}</strong>
      <small>{{ chat.loadingMessages ? '加载消息中...' : `${chat.messages.length} 条消息` }}</small>
    </header>

    <div ref="listRef" class="chat-list">
      <div v-if="!chat.messages.length && !chat.loadingMessages" class="chat-empty">暂无消息，发送第一条消息开始聊天。</div>
      <article
        v-for="item in chat.messages"
        :key="item._id"
        :class="['msg', item.senderId === auth.userId ? 'me' : 'ai']"
      >
        <div class="meta">
          <span>{{ item.senderId === auth.userId ? '我' : 'AI' }}</span>
          <span>{{ formatTime(item.createdAt) }}</span>
          <span v-if="item.status === 'sending'">发送中</span>
          <span v-else-if="item.status === 'failed'" style="color: #b42318">发送失败</span>
        </div>
        <div class="bubble">{{ formatMessageContent(item.content) }}</div>
        <div v-if="isToolCallLeak(item.content)" class="degraded-note">
          已拦截工具中间消息，等待最终答案...
        </div>
        <div v-if="item.meta?.degradedReason" class="degraded-note">
          降级回复: {{ item.meta.degradedReason }}
        </div>
      </article>
    </div>

    <form class="chat-input" @submit.prevent="sendNow">
      <input ref="fileInputRef" type="file" style="display: none" @change="onPickFile" />
      <input
        ref="cameraInputRef"
        type="file"
        accept="image/*"
        capture="environment"
        style="display: none"
        @change="onPickCamera"
      />
      <button
        class="voice-btn"
        type="button"
        :class="{ recording, canceling: voiceWillCancel }"
        :disabled="voiceActionLocked"
        :title="voiceDisabledReason || '按住说话'"
        @pointerdown.prevent="onVoicePressStart"
        @pointermove.prevent="onVoicePressMove"
        @pointerup.prevent="onVoicePressEnd"
        @pointercancel.prevent="onVoicePressCancel"
        @pointerleave.prevent="onVoicePressMove"
        @touchstart.prevent="onVoiceTouchStart"
        @touchmove.prevent="onVoiceTouchMove"
        @touchend.prevent="onVoiceTouchEnd"
        @touchcancel.prevent="onVoiceTouchCancel"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3" width="6" height="12" rx="3" ry="3" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" fill="none" stroke="currentColor" stroke-width="2" />
        </svg>
        <span>{{ recording ? (voiceWillCancel ? '松开取消' : '松开发送') : '按住说话' }}</span>
      </button>
      <textarea
        ref="textInputRef"
        v-model="draft"
        class="chat-text-input"
        placeholder="输入消息..."
        rows="1"
        :disabled="sending || uploadingVoice || startupBlocked"
        @input="adjustTextareaHeight"
        @keydown.enter.exact.prevent="sendNow"
        @focus="composerMenuOpen = false"
      />
      <button
        class="icon-btn"
        type="button"
        :disabled="sending || uploadingFile || startupBlocked"
        title="上传文件"
        @click="openFilePicker"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8.5 7.5V16a3.5 3.5 0 1 0 7 0V6.75a2.25 2.25 0 0 0-4.5 0V16a1 1 0 0 0 2 0V8"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        class="send-btn"
        :class="{ plus: primaryAction === 'plus' }"
        :type="primaryAction === 'send' ? 'submit' : 'button'"
        :disabled="sending || uploadingVoice || startupBlocked"
        @click="onPrimaryActionClick"
      >
        {{ sending ? '发送中...' : primaryAction === 'send' ? '发送' : '+' }}
      </button>
    </form>
    <div v-if="composerMenuOpen" class="composer-menu">
      <button class="composer-menu-item" type="button" @click="onMenuFile">
        <span>文件</span>
      </button>
      <button class="composer-menu-item" type="button" @click="onMenuCamera">
        <span>拍照</span>
      </button>
    </div>
    <div class="chat-input-hint">
      <span v-if="recording && !voiceWillCancel" style="color: #b42318">录音中 {{ recordingDurationText }}（上滑取消）</span>
      <span v-else-if="recording && voiceWillCancel" style="color: #b42318">松开后取消发送</span>
      <span v-else-if="uploadingVoice">语音识别中...</span>
      <span v-else-if="uploadingFile">文件处理中...</span>
      <span v-else-if="pendingFileName">待发送文件: {{ pendingFileName }}</span>
      <span v-else-if="startupBlocked" style="color: #b42318">{{ startupBlockedReason }}</span>
      <span v-else-if="voiceDisabledReason">{{ voiceDisabledReason }}</span>
      <span v-else>支持文本、文件与语音输入</span>
    </div>
    <div v-if="recording" class="voice-overlay">
      <div class="voice-overlay-card">
        <strong>{{ voiceWillCancel ? '松开取消发送' : '正在录音' }}</strong>
        <p>{{ recordingDurationText }}{{ voiceWillCancel ? ' · 已进入取消区' : ' · 上滑可取消' }}</p>
      </div>
    </div>
  </section>

  <section v-if="failedMessages.length" class="panel" style="margin-top: 12px">
    <h3 class="page-title">发送失败消息</h3>
    <ul>
      <li v-for="item in failedMessages" :key="item._id" style="margin-bottom: 8px">
        <div>{{ item.content || '[语音消息]' }}</div>
        <button @click="chat.retryMessage(item._id)">重试发送</button>
      </li>
    </ul>
  </section>

  <section v-if="chat.lastError" class="panel" style="margin-top: 12px; color: #b42318">
    {{ chat.lastError }}
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { voiceApi } from '../services/api/voice.api'
import { requestMicPermission } from '../platform/media'
import type { MessageEntity } from '../types/domain'

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

const auth = useAuthStore()
const chat = useChatStore()
const draft = ref('')
const sending = ref(false)
const recording = ref(false)
const uploadingVoice = ref(false)
const uploadingFile = ref(false)
const pendingFileName = ref('')
const listRef = ref<HTMLElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const cameraInputRef = ref<HTMLInputElement | null>(null)
const textInputRef = ref<HTMLTextAreaElement | null>(null)
const mediaRecorderRef = ref<MediaRecorder | null>(null)
const mediaStreamRef = ref<MediaStream | null>(null)
const voiceChunks = ref<Blob[]>([])
const speechRecognitionRef = ref<SpeechRecognitionLike | null>(null)
const speechDraftText = ref('')
const speechCancelled = ref(false)
const skipNextVoiceSubmit = ref(false)
const voicePressing = ref(false)
const voiceWillCancel = ref(false)
const voicePressStartY = ref(0)
const composerMenuOpen = ref(false)
const recordingDurationSec = ref(0)
let recordTickerId = 0
const VOICE_CANCEL_DISTANCE = 56

const failedMessages = computed(() => chat.messages.filter(msg => msg.status === 'failed'))
const currentRoomName = computed(() => {
  const room = chat.rooms.find(item => item.roomId === chat.roomId) || chat.rooms[0]
  return room?.roomName || 'AI 助手'
})
const showDiag = computed(() => {
  if (typeof window === 'undefined') return false
  const search = new URLSearchParams(window.location.search)
  return search.get('diag') === '1' || localStorage.getItem('baby_diag') === '1'
})
const roomNamesText = computed(() => chat.rooms.map(item => `${item.roomId}:${item.roomName}`).join(' | ') || 'none')
const speechSupported = computed(() => {
  if (typeof window === 'undefined') return false
  const maybeWindow = window as typeof window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  return Boolean(maybeWindow.SpeechRecognition || maybeWindow.webkitSpeechRecognition)
})
const tailMessagesText = computed(() => {
  const tail = chat.messages.slice(-5)
  if (!tail.length) return 'none'
  return tail
    .map(item => `${item._id}:${item.senderId}:${item.status}:${(item.content || '').slice(0, 24)}`)
    .join(' | ')
})
const primaryAction = computed<'send' | 'plus'>(() =>
  draft.value.trim() || pendingFileName.value ? 'send' : 'plus'
)
const startupBlocked = computed(() => chat.startupChecked && !chat.aiReplyReady)
const startupBlockedReason = computed(() => {
  if (!startupBlocked.value) return ''
  const missing = chat.missingStartupDeps.length ? chat.missingStartupDeps.join(', ') : 'COZE_*'
  return `系统配置缺失：${missing}，暂不可发送消息。`
})
const recordingDurationText = computed(() => {
  const mins = String(Math.floor(recordingDurationSec.value / 60)).padStart(2, '0')
  const secs = String(recordingDurationSec.value % 60).padStart(2, '0')
  return `${mins}:${secs}`
})
const voiceActionLocked = computed(() => uploadingVoice.value || startupBlocked.value)
const voiceDisabledReason = computed(() => {
  if (startupBlocked.value) return startupBlockedReason.value
  if (uploadingVoice.value) return '语音识别处理中，请稍候。'
  if (uploadingFile.value) return '文件处理中，请稍后再试语音。'
  if (!chat.roomId) return '聊天房间未就绪，请稍后重试。'
  return ''
})

watch(
  () => chat.messages.length,
  async () => {
    await nextTick()
    if (!listRef.value) return
    listRef.value.scrollTop = listRef.value.scrollHeight
  }
)
watch(draft, () => {
  if (draft.value.trim()) {
    composerMenuOpen.value = false
  }
  adjustTextareaHeight()
})

onMounted(async () => {
  adjustTextareaHeight()
  await chat.checkBackendReadiness()
  await chat.fetchRooms()
  if (chat.roomId) {
    const roomId = chat.roomId
    await Promise.allSettled([
      chat.fetchMessages(roomId),
      chat.ensureSession()
    ])
  }
})

onBeforeUnmount(() => {
  cleanupRecorder()
  chat.closeStream()
  chat.stopTts()
})

async function sendNow() {
  if (startupBlocked.value) {
    chat.lastError = startupBlockedReason.value
    return
  }
  const content = draft.value.trim()
  if ((!content && !pendingFileName.value) || sending.value) return
  sending.value = true
  try {
    if (content) {
      await chat.sendText(content)
    } else if (pendingFileName.value) {
      await chat.sendMessagePayload({
        content: `[附件] ${pendingFileName.value}`,
        messageType: 'file'
      })
    }
    draft.value = ''
    pendingFileName.value = ''
    composerMenuOpen.value = false
  } finally {
    sending.value = false
    adjustTextareaHeight()
    await nextTick()
    focusTextInput()
  }
}

function adjustTextareaHeight() {
  const el = textInputRef.value
  if (!el) return
  el.style.height = 'auto'
  const nextHeight = Math.max(44, Math.min(el.scrollHeight, 120))
  el.style.height = `${nextHeight}px`
}

function onPrimaryActionClick() {
  if (primaryAction.value !== 'plus') return
  composerMenuOpen.value = !composerMenuOpen.value
}

function onMenuFile() {
  composerMenuOpen.value = false
  openFilePicker()
}

function onMenuCamera() {
  composerMenuOpen.value = false
  openCameraPicker()
}

function openFilePicker() {
  fileInputRef.value?.click()
}

function openCameraPicker() {
  cameraInputRef.value?.click()
}

function focusTextInput() {
  textInputRef.value?.focus()
}

async function onPickFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await sendSelectedFile(file)
  input.value = ''
}

async function onPickCamera(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  await sendSelectedFile(file)
  input.value = ''
}

async function sendSelectedFile(file: File) {
  if (startupBlocked.value) {
    chat.lastError = startupBlockedReason.value
    return
  }
  if (!chat.roomId) {
    chat.lastError = '聊天房间未就绪，请稍后再试。'
    return
  }

  uploadingFile.value = true
  pendingFileName.value = file.name
  try {
    const extension = file.name.includes('.') ? file.name.split('.').pop() || '' : ''
    const messageType: MessageEntity['messageType'] = file.type.startsWith('image/') ? 'image' : 'file'
    const fallbackContent = draft.value.trim() || `[附件] ${file.name}`
    await chat.sendMessagePayload({
      content: fallbackContent,
      messageType,
      files: [
        {
          name: file.name,
          size: file.size,
          type: file.type,
          extension
        }
      ]
    })
    draft.value = ''
    pendingFileName.value = ''
  } catch (error) {
    chat.lastError = `文件发送失败: ${(error as Error)?.message || 'unknown'}`
  } finally {
    uploadingFile.value = false
    await nextTick()
    focusTextInput()
  }
}

async function startRecording() {
  if (startupBlocked.value) {
    chat.lastError = startupBlockedReason.value
    return
  }
  if (recording.value || uploadingVoice.value) return
  if (uploadingFile.value) {
    chat.lastError = '文件处理中，请稍后再试语音输入。'
    return
  }
  if (!chat.roomId) {
    chat.lastError = '聊天房间未就绪，请稍后再试。'
    return
  }
  const permission = await requestMicPermission()
  if (!permission.granted) {
    chat.lastError = permission.reason || '麦克风权限未开启。'
    return
  }
  if (speechSupported.value) {
    toggleSpeechRecognition()
    return
  }
  if (!('MediaRecorder' in window)) {
    chat.lastError = '当前浏览器不支持语音录制。'
    return
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    mediaStreamRef.value = stream
    voiceChunks.value = []
    const preferred = 'audio/webm;codecs=opus'
    const mimeType = MediaRecorder.isTypeSupported(preferred) ? preferred : 'audio/webm'
    const recorder = new MediaRecorder(stream, { mimeType })
    mediaRecorderRef.value = recorder
    recorder.ondataavailable = ev => {
      if (ev.data && ev.data.size > 0) voiceChunks.value.push(ev.data)
    }
    recorder.onerror = () => {
      chat.lastError = '录音失败，请重试。'
      cleanupRecorder()
      recording.value = false
    }
    recorder.onstop = () => {
      void processRecordedVoice()
    }
    recorder.start()
    recording.value = true
    startRecordingTicker()
  } catch (error) {
    chat.lastError = `无法开始录音: ${(error as Error)?.message || 'unknown'}`
    cleanupRecorder()
  }
}

function stopRecording() {
  if (speechSupported.value && speechRecognitionRef.value) {
    speechRecognitionRef.value.stop()
    return
  }
  const recorder = mediaRecorderRef.value
  if (!recorder || recorder.state === 'inactive') return
  recording.value = false
  recorder.stop()
}

function onVoicePressStart(event: PointerEvent) {
  if (event.pointerType === 'mouse' && event.button !== 0) return
  if (voiceActionLocked.value) {
    chat.lastError = voiceDisabledReason.value || '语音暂不可用，请稍后重试。'
    return
  }
  voicePressing.value = true
  voiceWillCancel.value = false
  voicePressStartY.value = event.clientY || 0
  void startRecording()
}

function onVoicePressMove(event: PointerEvent) {
  if (!voicePressing.value || !recording.value) return
  const deltaY = voicePressStartY.value - (event.clientY || 0)
  voiceWillCancel.value = deltaY > VOICE_CANCEL_DISTANCE
}

function onVoicePressEnd(event: PointerEvent) {
  if (!voicePressing.value) return
  onVoicePressMove(event)
  voicePressing.value = false
  if (!recording.value) {
    voiceWillCancel.value = false
    return
  }
  if (voiceWillCancel.value) {
    onVoicePressCancel()
    return
  }
  stopRecording()
  voiceWillCancel.value = false
}

function onVoicePressCancel() {
  voicePressing.value = false
  voiceWillCancel.value = false
  if (!recording.value) return
  speechCancelled.value = true
  skipNextVoiceSubmit.value = true
  stopRecording()
  chat.lastError = '已取消语音输入'
}

function getFirstTouch(event: TouchEvent): Touch | null {
  if (event.touches?.length) return event.touches[0]
  if (event.changedTouches?.length) return event.changedTouches[0]
  return null
}

function onVoiceTouchStart(event: TouchEvent) {
  if (voiceActionLocked.value) {
    chat.lastError = voiceDisabledReason.value || '语音暂不可用，请稍后重试。'
    return
  }
  const touch = getFirstTouch(event)
  voicePressing.value = true
  voiceWillCancel.value = false
  voicePressStartY.value = touch?.clientY || 0
  void startRecording()
}

function onVoiceTouchMove(event: TouchEvent) {
  if (!voicePressing.value || !recording.value) return
  const touch = getFirstTouch(event)
  const clientY = touch?.clientY || 0
  const deltaY = voicePressStartY.value - clientY
  voiceWillCancel.value = deltaY > VOICE_CANCEL_DISTANCE
}

function onVoiceTouchEnd(event: TouchEvent) {
  if (!voicePressing.value) return
  onVoiceTouchMove(event)
  voicePressing.value = false
  if (!recording.value) {
    voiceWillCancel.value = false
    return
  }
  if (voiceWillCancel.value) {
    onVoicePressCancel()
    return
  }
  stopRecording()
  voiceWillCancel.value = false
}

function onVoiceTouchCancel() {
  onVoicePressCancel()
}

function getSpeechCtor(): SpeechCtor | null {
  if (typeof window === 'undefined') return null
  const maybeWindow = window as typeof window & {
    SpeechRecognition?: SpeechCtor
    webkitSpeechRecognition?: SpeechCtor
  }
  return maybeWindow.SpeechRecognition || maybeWindow.webkitSpeechRecognition || null
}

function createRecognition(): SpeechRecognitionLike | null {
  const Ctor = getSpeechCtor()
  if (!Ctor) return null
  const recognition = new Ctor()
  recognition.lang = 'zh-CN'
  recognition.interimResults = true
  recognition.continuous = false
  recognition.onresult = event => {
    const e = event as { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }
    if (!e.results) return
    let transcript = ''
    for (let i = 0; i < e.results.length; i += 1) {
      const item = e.results[i]
      if (!item || !item[0]) continue
      transcript += item[0].transcript || ''
    }
    speechDraftText.value = transcript.trim()
  }
  recognition.onerror = () => {
    recording.value = false
    stopRecordingTicker()
    chat.lastError = '语音识别失败，请重试。'
  }
  recognition.onend = () => {
    void finalizeSpeechRecognition()
  }
  return recognition
}

function toggleSpeechRecognition() {
  if (!speechRecognitionRef.value) {
    speechRecognitionRef.value = createRecognition()
  }
  const recognition = speechRecognitionRef.value
  if (!recognition) {
    chat.lastError = '当前浏览器不支持语音识别。'
    return
  }
  if (!recording.value) {
    speechDraftText.value = ''
    speechCancelled.value = false
    recording.value = true
    chat.lastError = ''
    startRecordingTicker()
    recognition.start()
    return
  }
  recognition.stop()
}

async function finalizeSpeechRecognition() {
  const transcript = speechDraftText.value.trim()
  recording.value = false
  stopRecordingTicker()
  recordingDurationSec.value = 0
  speechDraftText.value = ''
  if (speechCancelled.value) {
    speechCancelled.value = false
    return
  }
  if (!transcript) return
  sending.value = true
  try {
    await chat.sendMessagePayload({
      content: transcript,
      messageType: 'audio',
      meta: {
        asrText: transcript,
        asrSource: 'browser_speech'
      }
    })
  } finally {
    sending.value = false
  }
}

function isMockAsrText(text: string) {
  const normalized = text.replace(/\s+/g, '')
  return normalized.includes('这是语音转写示例结果')
}

async function processRecordedVoice() {
  const chunks = voiceChunks.value
  const durationSec = recordingDurationSec.value
  cleanupRecorder()
  if (skipNextVoiceSubmit.value) {
    skipNextVoiceSubmit.value = false
    return
  }
  if (!chunks.length || !chat.roomId) return

  uploadingVoice.value = true
  try {
    const blob = new Blob(chunks, { type: 'audio/webm' })
    const asr = await voiceApi.asrByAudio(blob, chat.roomId)
    if (!asr.text.trim() || isMockAsrText(asr.text)) {
      throw new Error('后端 ASR 当前仍是示例模式，请启用真实语音转写服务。')
    }
    await chat.sendMessagePayload({
      content: asr.text,
      messageType: 'audio',
      files: [
        {
          name: 'voice.webm',
          type: blob.type || 'audio/webm',
          extension: 'webm',
          audio: true,
          duration: durationSec > 0 ? durationSec : undefined
        }
      ],
      meta: {
        asrText: asr.text
      }
    })
  } catch (error) {
    chat.lastError = `语音发送失败: ${(error as Error)?.message || 'unknown'}`
  } finally {
    uploadingVoice.value = false
  }
}

function cleanupRecorder() {
  mediaRecorderRef.value = null
  if (mediaStreamRef.value) {
    mediaStreamRef.value.getTracks().forEach(track => track.stop())
  }
  mediaStreamRef.value = null
  if (speechRecognitionRef.value) {
    speechRecognitionRef.value.onresult = null
    speechRecognitionRef.value.onerror = null
    speechRecognitionRef.value.onend = null
    speechRecognitionRef.value.stop()
  }
  speechRecognitionRef.value = null
  speechDraftText.value = ''
  voicePressing.value = false
  voiceWillCancel.value = false
  voicePressStartY.value = 0
  stopRecordingTicker()
  recordingDurationSec.value = 0
}

function startRecordingTicker() {
  stopRecordingTicker()
  recordingDurationSec.value = 0
  recordTickerId = window.setInterval(() => {
    recordingDurationSec.value += 1
  }, 1000)
}

function stopRecordingTicker() {
  if (!recordTickerId) return
  window.clearInterval(recordTickerId)
  recordTickerId = 0
}

function formatTime(input: string): string {
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return '-'
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isToolCallLeak(content: string): boolean {
  const text = typeof content === 'string' ? content.trim() : ''
  if (!text.startsWith('{') || !text.endsWith('}')) return false
  try {
    const obj = JSON.parse(text)
    if (!obj || typeof obj !== 'object') return false
    const hasApiMarker =
      typeof obj.api_name === 'string' ||
      typeof obj.plugin_id === 'number' ||
      typeof obj.plugin_name === 'string' ||
      typeof obj.name === 'string'
    const hasArguments = Object.prototype.hasOwnProperty.call(obj, 'arguments')
    return hasApiMarker && hasArguments
  } catch {
    return false
  }
}

function formatMessageContent(content: string): string {
  if (!content) return '[空消息]'
  if (isToolCallLeak(content)) return '正在联网检索，请稍候...'
  const structured = formatStructuredAnswer(content)
  if (structured) return structured
  return content
}

function formatStructuredAnswer(content: string): string {
  const text = content.trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return ''
  try {
    const obj = JSON.parse(text) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return ''
    const title = typeof obj.title === 'string' ? obj.title.trim() : ''
    const summary = typeof obj.content === 'string' ? obj.content.trim() : ''
    const example = typeof obj.example === 'string' ? obj.example.trim() : ''
    const question = typeof obj.question === 'string' ? obj.question.trim() : ''
    const encourage = typeof obj.encourage === 'string' ? obj.encourage.trim() : ''
    const hasStructuredField = Boolean(title || summary || example || question || encourage)
    if (!hasStructuredField) return ''
    const lines: string[] = []
    if (title) lines.push(`【${title}】`)
    if (summary) lines.push(summary)
    if (example) lines.push(`示例：${example}`)
    if (question) lines.push(`练习：${question}`)
    if (encourage) lines.push(encourage)
    return lines.join('\n\n')
  } catch {
    return ''
  }
}
</script>

<style scoped>
.chat-shell {
  padding: 0;
  overflow: hidden;
}

.chat-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid #eaecf0;
}

.chat-list {
  min-height: 360px;
  max-height: 60vh;
  overflow-y: auto;
  padding: 12px;
  background: #f9fafb;
}

.chat-empty {
  color: #667085;
  text-align: center;
  padding: 60px 12px;
}

.msg {
  margin-bottom: 10px;
}

.msg .meta {
  display: flex;
  gap: 10px;
  margin-bottom: 4px;
  font-size: 12px;
  color: #667085;
}

.msg .bubble {
  display: inline-block;
  max-width: 90%;
  padding: 8px 10px;
  border-radius: 10px;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.degraded-note {
  margin-top: 4px;
  font-size: 12px;
  color: #b54708;
}

.msg.me {
  text-align: right;
}

.msg.me .meta {
  justify-content: flex-end;
}

.msg.me .bubble {
  background: #1d4ed8;
  color: #fff;
}

.msg.ai .bubble {
  background: #fff;
  border: 1px solid #eaecf0;
  color: #101828;
}

.chat-input {
  display: grid;
  grid-template-columns: 84px 1fr 44px 84px;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #eaecf0;
  background: #fff;
  align-items: center;
}

.chat-text-input {
  width: 100%;
  min-height: 44px;
  max-height: 120px;
  resize: none;
  border: 1px solid #d0d5dd;
  border-radius: 22px;
  padding: 10px 14px;
  line-height: 1.4;
}

.send-btn {
  border: 0;
  border-radius: 22px;
  background: #175cd3;
  color: #fff;
  height: 44px;
  font-weight: 600;
}

.send-btn.plus {
  font-size: 24px;
  line-height: 1;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: 1px solid #d0d5dd;
  border-radius: 8px;
  color: #344054;
  background: #fff;
}

.icon-btn svg {
  width: 18px;
  height: 18px;
}

.icon-btn:disabled {
  opacity: 0.5;
}

.voice-btn {
  height: 44px;
  border: 1px solid #d0d5dd;
  border-radius: 22px;
  background: #fff;
  color: #1d2939;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-weight: 500;
}

.voice-btn svg {
  width: 18px;
  height: 18px;
}

.voice-btn.recording {
  border-color: #fda29b;
  background: #fff1f3;
  color: #b42318;
}

.voice-btn.canceling {
  border-color: #b42318;
  background: #fef3f2;
  color: #b42318;
}

.voice-btn:disabled {
  opacity: 0.6;
}

.chat-input-hint {
  padding: 0 12px 12px;
  font-size: 12px;
  color: #667085;
}

.composer-menu {
  display: flex;
  gap: 10px;
  padding: 0 12px 10px;
}

.composer-menu-item {
  border: 1px solid #d0d5dd;
  background: #fff;
  color: #344054;
  border-radius: 10px;
  height: 36px;
  min-width: 72px;
}

.voice-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.voice-overlay-card {
  min-width: 180px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(16, 24, 40, 0.78);
  color: #fff;
  text-align: center;
}

.voice-overlay-card p {
  margin: 6px 0 0;
  font-size: 12px;
  color: #d0d5dd;
}

@media (max-width: 768px) {
  .chat-shell {
    border-radius: 10px;
  }

  .chat-list {
    min-height: 48vh;
    max-height: 56vh;
    padding: 12px 10px;
  }

  .chat-input {
    grid-template-columns: 74px 1fr 40px 64px;
    gap: 6px;
    padding: 10px;
  }

  .chat-text-input {
    min-height: 48px;
    max-height: 132px;
    border-radius: 18px;
    padding: 12px 12px;
    font-size: 16px;
    line-height: 1.35;
  }

  .voice-btn {
    height: 48px;
    border-radius: 18px;
    gap: 4px;
    font-size: 12px;
  }

  .voice-btn svg {
    width: 16px;
    height: 16px;
  }

  .icon-btn {
    width: 40px;
    height: 48px;
    border-radius: 10px;
  }

  .icon-btn svg {
    width: 18px;
    height: 18px;
  }

  .send-btn {
    height: 48px;
    border-radius: 18px;
    font-size: 14px;
  }

  .chat-input-hint {
    padding: 0 10px 10px;
    font-size: 12px;
  }
}
</style>
