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
    <div>diag: chatUiReady={{ chatUiReady }} roomId={{ chat.roomId || 'none' }}</div>
    <div>
      diag: loadingRooms={{ chat.loadingRooms }} roomsLoaded={{ chat.roomsLoaded }} rooms={{ chat.rooms.length }}
      vacLoadingRooms={{ vacLoadingRooms }} vacRoomsLoaded={{ vacRoomsLoaded }}
    </div>
    <div>
      diag: loadingMessages={{ chat.loadingMessages }} messagesLoaded={{ chat.messagesLoaded }} messages={{ chat.messages.length }}
      vacMessagesLoaded={{ vacMessagesLoaded }}
    </div>
    <div>diag: sessionId={{ chat.sessionId || 'none' }} streamConnected={{ chat.streamConnected }}</div>
  </section>

  <section v-if="chatUiReady" class="panel" style="padding: 0; overflow: hidden">
    <vue-advanced-chat
      :current-user-id.prop="auth.userId"
      :rooms.prop="vacRooms"
      :room-id.prop="chat.roomId"
      :messages.prop="vacMessages"
      :loading-rooms="vacLoadingRooms"
      :rooms-loaded="vacRoomsLoaded"
      :messages-loaded="vacMessagesLoaded"
      :show-audio="true"
      :show-files="true"
      :show-emojis="true"
      @fetch-messages="onFetchMessages"
      @fetch-more-rooms="onFetchMoreRooms"
      @send-message="onSendMessage"
    />
  </section>
  <section v-else class="panel">聊天组件加载中...</section>

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
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { chatAdapter } from '../adapters/chatAdapter'

const auth = useAuthStore()
const chat = useChatStore()
const chatUiReady = ref(false)

const vacRooms = computed(() => chatAdapter.toVacRooms(chat.rooms))
const vacMessages = computed(() => chatAdapter.toVacMessages(chat.messages))
const failedMessages = computed(() => chat.messages.filter(msg => msg.status === 'failed'))
const vacLoadingRooms = computed(() => chat.loadingRooms && chat.rooms.length === 0)
const vacRoomsLoaded = computed(() => chat.roomsLoaded || (!chat.loadingRooms && chat.rooms.length > 0))
const vacMessagesLoaded = computed(
  () => chat.messagesLoaded || (!chat.loadingMessages && !!chat.roomId)
)
const showDiag = computed(() => {
  if (typeof window === 'undefined') return false
  const search = new URLSearchParams(window.location.search)
  return search.get('diag') === '1' || localStorage.getItem('baby_diag') === '1'
})

const roomLoadingSince = ref(0)
const messageLoadingSince = ref(0)
const autoHealInFlight = ref(false)
const autoHealTimerId = ref(0)

watch(
  () => chat.loadingRooms,
  val => {
    roomLoadingSince.value = val ? Date.now() : 0
  },
  { immediate: true }
)

watch(
  () => chat.loadingMessages,
  val => {
    messageLoadingSince.value = val ? Date.now() : 0
  },
  { immediate: true }
)

onMounted(async () => {
  await ensureChatUiReady()
  startAutoHealWatchdog()
  await chat.fetchRooms()
  if (chat.roomId) {
    await chat.fetchMessages(chat.roomId)
    await chat.ensureSession()
  }
})

onBeforeUnmount(() => {
  stopAutoHealWatchdog()
  chat.closeStream()
  chat.stopTts()
})

type VacFetchPayload = {
  room?: { roomId?: string }
  options?: { reset?: boolean }
}

function normalizeVacPayload(payload: unknown): VacFetchPayload {
  if (!payload || typeof payload !== 'object') return {}
  const eventLike = payload as { detail?: unknown }
  if (eventLike.detail && typeof eventLike.detail === 'object') {
    return eventLike.detail as VacFetchPayload
  }
  return payload as VacFetchPayload
}

async function onFetchMessages(payload: unknown) {
  const normalized = normalizeVacPayload(payload)
  const roomId = normalized.room?.roomId || chat.roomId || vacRooms.value[0]?.roomId
  if (!roomId) {
    chat.lastError = '聊天房间信息缺失，请刷新后重试。'
    return
  }
  const reset = normalized.options?.reset !== false
  if (reset) {
    await chat.fetchMessages(roomId, true)
  } else {
    await chat.fetchMoreMessages(roomId)
  }
  await chat.ensureSession()
}

async function onFetchMoreRooms() {
  await chat.fetchMoreRooms()
}

async function onSendMessage(payload: unknown) {
  const normalized = normalizeVacPayload(payload)
  const directContent = (normalized as { content?: unknown }).content
  const messageContent = (normalized as { message?: { content?: unknown } }).message?.content
  const content = typeof directContent === 'string'
    ? directContent
    : typeof messageContent === 'string'
      ? messageContent
      : ''
  await chat.sendText(content)
}

async function ensureChatUiReady() {
  if (chatUiReady.value) return
  const module = await import('vue-advanced-chat')
  module.register()
  chatUiReady.value = true
}

function startAutoHealWatchdog() {
  if (typeof window === 'undefined') return
  stopAutoHealWatchdog()
  autoHealTimerId.value = window.setInterval(async () => {
    if (autoHealInFlight.value) return
    const now = Date.now()

    if (chat.loadingRooms && chat.rooms.length === 0 && roomLoadingSince.value && now - roomLoadingSince.value > 8000) {
      autoHealInFlight.value = true
      try {
        await chat.fetchRooms(true)
      } finally {
        autoHealInFlight.value = false
      }
      return
    }

    const activeRoomId = chat.roomId || vacRooms.value[0]?.roomId || ''
    if (chat.loadingMessages && activeRoomId && messageLoadingSince.value && now - messageLoadingSince.value > 8000) {
      autoHealInFlight.value = true
      try {
        await chat.fetchMessages(activeRoomId, true)
        await chat.ensureSession()
      } finally {
        autoHealInFlight.value = false
      }
    }
  }, 3000)
}

function stopAutoHealWatchdog() {
  if (!autoHealTimerId.value) return
  window.clearInterval(autoHealTimerId.value)
  autoHealTimerId.value = 0
}
</script>

<style scoped>
:deep(.vac-room-footer) {
  display: none !important;
}
</style>
