<template>
  <div class="panel">
    <h3 class="page-title">好友申请</h3>
    <ul v-if="items.length">
      <li v-for="item in items" :key="item.requestId" class="request-row">
        <span>{{ item.fromUsername }}</span>
        <div class="actions">
          <button @click="$emit('accept', item.requestId)">同意</button>
          <button @click="$emit('reject', item.requestId)">拒绝</button>
        </div>
      </li>
    </ul>
    <p v-else>暂无待处理申请。</p>
  </div>
</template>

<script setup lang="ts">
import type { FriendRequestItem } from '../../services/api/social.api'

defineProps<{ items: FriendRequestItem[] }>()

defineEmits<{
  accept: [requestId: string]
  reject: [requestId: string]
}>()
</script>

<style scoped>
.request-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.actions {
  display: flex;
  gap: 8px;
}
</style>
