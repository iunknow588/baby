<template>
  <div class="panel">
    <h2 class="page-title">个人与导师偏好</h2>
    <p>导师模式: {{ mentor.profile.mode }}</p>
    <p>当前目标: {{ mentor.profile.goal }}</p>
  </div>
</template>

<script setup lang="ts">
import { useMentorStore } from '../stores/mentor'

const mentor = useMentorStore()
</script>
