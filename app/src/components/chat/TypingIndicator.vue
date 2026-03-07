<template>
  <div class="panel" style="padding: 8px">{{ text }}</div>
</template>

<script setup lang="ts">
defineProps<{ text: string }>()
</script>
