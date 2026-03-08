<template>
  <div class="panel">
    <h3 class="page-title">AI 老师联调</h3>
    <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px">
      <label for="agent-select">Bot:</label>
      <select id="agent-select" v-model="mentor.selectedAgent">
        <option value="main">默认助手</option>
        <option value="math-doctor">数学小博士</option>
      </select>
    </div>
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
  const answer = await mentor.askTeacher(question.value, {
    agentId: mentor.selectedAgent,
    model: `openclaw:${mentor.selectedAgent}`
  })
  if (answer) {
    question.value = ''
  }
}

function resetConversation() {
  mentor.conversationId = ''
}
</script>
