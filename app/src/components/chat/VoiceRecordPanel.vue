<template>
  <div class="panel">
    <h3 class="page-title">语音输入</h3>
    <p v-if="!support">当前设备不支持录音，请使用文本输入。</p>
    <div v-else>
      <p>状态: {{ recording ? '录音中' : '空闲' }}</p>
      <button @click="toggleRecord" :disabled="busy">
        {{ recording ? '停止录音' : '开始录音' }}
      </button>
      <p v-if="busy">语音处理中...</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { requestMicPermission } from '../../platform/media'

const props = defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ recorded: [blob: Blob] }>()

const support = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
const recording = ref(false)
const recorder = ref<MediaRecorder | null>(null)
let chunks: BlobPart[] = []

async function toggleRecord() {
  if (!support || props.busy) return

  if (!recording.value) {
    const ok = await requestMicPermission()
    if (!ok) return

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mediaRecorder = new MediaRecorder(stream)
    chunks = []

    mediaRecorder.ondataavailable = event => {
      chunks.push(event.data)
    }

    mediaRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'audio/webm' })
      emit('recorded', blob)
      stream.getTracks().forEach(track => track.stop())
    }

    recorder.value = mediaRecorder
    mediaRecorder.start()
    recording.value = true
    return
  }

  recorder.value?.stop()
  recording.value = false
}

onBeforeUnmount(() => {
  if (recording.value) {
    recorder.value?.stop()
  }
})
</script>
