import { defineStore } from 'pinia'

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    recording: false,
    support: typeof navigator !== 'undefined' && !!navigator.mediaDevices
  }),
  actions: {
    setRecording(value: boolean) {
      this.recording = value
    }
  }
})
