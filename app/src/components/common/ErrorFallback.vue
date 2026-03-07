<template>
  <div class="panel">
    <h3 class="page-title">加载失败</h3>
    <p>{{ message }}</p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ message: string }>()
</script>
