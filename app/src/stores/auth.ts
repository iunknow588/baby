import { defineStore } from 'pinia'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    userId: 'u_current',
    token: localStorage.getItem('baby_token') || ''
  }),
  actions: {
    setToken(token: string) {
      this.token = token
      localStorage.setItem('baby_token', token)
    }
  }
})
