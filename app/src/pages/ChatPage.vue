<template>
  <section class="panel" style="margin-bottom: 12px">
    <strong>实时连接:</strong>
    <span v-if="chat.streamConnected" style="color: #067647"> 已连接 </span>
    <span v-else-if="chat.streamConnecting" style="color: #b54708"> 重连中... </span>
    <span v-else style="color: #b42318"> 未连接 </span>
    <span v-if="chat.streamReconnectCount > 0">（重连 {{ chat.streamReconnectCount }} 次）</span>
    <span v-if="chat.streamStale" style="color: #b42318">（连接超时，等待自动恢复）</span>
    <button style="margin-left: 8px" :disabled="chat.streamConnecting" @click="chat.reconnectStream">
      立即重连
    </button>
  </section>

  <section v-if="chatUiReady" class="panel" style="padding: 0; overflow: hidden">
    <vue-advanced-chat
      :current-user-id.prop="auth.userId"
      :rooms.prop="vacRooms"
      :room-id.prop="chat.roomId"
      :messages.prop="vacMessages"
      :loading-rooms="chat.loadingRooms"
      :rooms-loaded="chat.roomsLoaded"
      :messages-loaded="chat.messagesLoaded"
      :show-audio="true"
      :show-files="true"
      :show-emojis="true"
      @fetch-messages="onFetchMessages"
      @fetch-more-rooms="onFetchMoreRooms"
      @send-message="onSendMessage"
    />
  </section>
  <section v-else class="panel">聊天组件加载中...</section>

  <VoiceRecordPanel style="margin-top: 12px" :busy="chat.voiceProcessing" @recorded="onVoiceRecorded" />

  <section v-if="chat.voiceDraftFileId" class="panel" style="margin-top: 12px">
    <h3 class="page-title">语音识别草稿</h3>
    <textarea v-model="chat.voiceDraftText" rows="3" style="width: 100%" />
    <div style="display: flex; gap: 8px; margin-top: 8px">
      <button @click="chat.confirmSendVoiceDraft">确认发送语音</button>
      <button @click="chat.clearVoiceDraft">取消</button>
    </div>
  </section>

  <section class="panel" style="margin-top: 12px">
    <h3 class="page-title">AI 语音播报</h3>
    <p v-if="!lastAiText">当前没有可播报的 AI 文本。</p>
    <p v-else>{{ lastAiText }}</p>
    <div style="display: flex; gap: 8px; margin-top: 8px">
      <button :disabled="!lastAiText || chat.ttsLoading" @click="playLastAiText">
        {{ chat.ttsLoading ? '生成中...' : '播报最近 AI 回复' }}
      </button>
      <button :disabled="!chat.ttsPlaying" @click="chat.stopTts">停止播放</button>
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
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useChatStore } from '../stores/chat'
import { chatAdapter } from '../adapters/chatAdapter'
import VoiceRecordPanel from '../components/chat/VoiceRecordPanel.vue'

const auth = useAuthStore()
const chat = useChatStore()
const chatUiReady = ref(false)

const vacRooms = computed(() => chatAdapter.toVacRooms(chat.rooms))
const vacMessages = computed(() => chatAdapter.toVacMessages(chat.messages))
const failedMessages = computed(() => chat.messages.filter(msg => msg.status === 'failed'))
const lastAiText = computed(() => {
  const target = [...chat.messages]
    .reverse()
    .find(msg => msg.senderType === 'ai' && msg.messageType === 'text' && !!msg.content)
  return target?.content || ''
})

onMounted(async () => {
  await ensureChatUiReady()
  await chat.fetchRooms()
  if (chat.roomId) {
    await chat.fetchMessages(chat.roomId)
    await chat.ensureSession()
  }
})

onBeforeUnmount(() => {
  chat.closeStream()
  chat.stopTts()
})

async function onFetchMessages({
  room,
  options
}: {
  room: { roomId: string }
  options?: { reset?: boolean }
}) {
  const reset = options?.reset !== false
  if (reset) {
    await chat.fetchMessages(room.roomId, true)
  } else {
    await chat.fetchMoreMessages(room.roomId)
  }
  await chat.ensureSession()
}

async function onFetchMoreRooms() {
  await chat.fetchMoreRooms()
}

async function onSendMessage({ content }: { content: string }) {
  await chat.sendText(content)
}

async function onVoiceRecorded(blob: Blob) {
  await chat.processVoiceBlob(blob)
}

async function playLastAiText() {
  if (!lastAiText.value) return
  await chat.requestTtsAndPlay(lastAiText.value)
}

async function ensureChatUiReady() {
  if (chatUiReady.value) return
  const module = await import('vue-advanced-chat')
  module.register()
  chatUiReady.value = true
}
</script>
