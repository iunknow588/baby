<template>
  <div class="panel">
    <h3 class="page-title">AI 老师联调</h3>
    <textarea v-model="question" rows="3" style="width: 100%" placeholder="输入你想问 AI 老师的问题" />
    <div style="margin-top: 8px; display: flex; gap: 8px">
      <button :disabled="mentor.asking || !question.trim()" @click="onAsk">
        {{ mentor.asking ? '请求中...' : '发送给 Coze' }}
      </button>
      <button :disabled="mentor.asking || !mentor.conversationId" @click="resetConversation">
        重置会话
      </button>
    </div>
    <p v-if="mentor.lastError" style="color: #b42318; margin-top: 8px">{{ mentor.lastError }}</p>
    <p v-if="mentor.lastReply" style="margin-top: 8px">{{ mentor.lastReply }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMentorStore } from '../stores/mentor'

const mentor = useMentorStore()
const question = ref('')

async function onAsk() {
  const answer = await mentor.askTeacher(question.value)
  if (answer) {
    question.value = ''
  }
}

function resetConversation() {
  mentor.conversationId = ''
}
</script>
