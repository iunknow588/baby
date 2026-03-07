<template>
  <div class="panel">
    <h4 style="margin: 0 0 6px">AI 导师建议</h4>
    <p style="margin: 0">{{ content }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ content: string }>()
</script>
