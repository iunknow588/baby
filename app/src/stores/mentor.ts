import { defineStore } from 'pinia'
import { toUserError } from '../services/api/errorMap'
import { cozeApi } from '../services/api/coze.api'
import { getCozeApiUri, getCozeUserId } from '../platform/env'

export const useMentorStore = defineStore('mentor', {
  state: () => ({
    enabled: true,
    profile: {
      mode: 'social_mentor',
      goal: 'improve-communication'
    },
    coze: {
      apiUri: getCozeApiUri(),
      userId: getCozeUserId()
    },
    conversationId: '',
    asking: false,
    lastReply: '',
    lastError: ''
  }),
  actions: {
    async askTeacher(message: string) {
      const content = message.trim()
      if (!content) return ''

      this.asking = true
      this.lastError = ''
      try {
        const result = await cozeApi.chat({
          message: content,
          conversationId: this.conversationId || undefined
        })
        this.conversationId = result.conversationId
        this.lastReply = result.answer
        return result.answer
      } catch (error) {
        this.lastError = toUserError(error)
        return ''
      } finally {
        this.asking = false
      }
    }
  }
})
