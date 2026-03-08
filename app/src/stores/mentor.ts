import { defineStore } from 'pinia'
import { toUserError } from '../services/api/errorMap'
import { cozeApi } from '../services/api/coze.api'

export const useMentorStore = defineStore('mentor', {
  state: () => ({
    enabled: true,
    conversationId: '',
    selectedAgent: 'math-doctor',
    asking: false,
    lastReply: '',
    lastError: ''
  }),
  actions: {
    async askTeacher(
      message: string,
      options?: {
        agentId?: string
        model?: string
      }
    ) {
      const content = message.trim()
      if (!content) return ''

      this.asking = true
      this.lastError = ''
      try {
        const result = await cozeApi.chat({
          message: content,
          conversationId: this.conversationId || undefined,
          extra: {
            agentId: options?.agentId || this.selectedAgent,
            model: options?.model || `openclaw:${options?.agentId || this.selectedAgent}`
          }
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
