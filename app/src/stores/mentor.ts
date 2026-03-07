import { defineStore } from 'pinia'

export const useMentorStore = defineStore('mentor', {
  state: () => ({
    enabled: true,
    profile: {
      mode: 'social_mentor',
      goal: 'improve-communication'
    }
  })
})
