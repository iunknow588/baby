<template>
  <div class="panel">
    <h3 class="page-title">联系人</h3>
    <ul>
      <li v-for="item in contacts" :key="item.userId">
        {{ item.username }} - {{ item.relation }}
      </li>
    </ul>
    <button v-if="!loaded" :disabled="loadingMore" @click="$emit('load-more')">
      {{ loadingMore ? '加载中...' : '加载更多联系人' }}
    </button>
  </div>
</template>

<script setup lang="ts">
import type { ContactItem } from '../../services/api/social.api'

defineProps<{ contacts: ContactItem[]; loaded: boolean; loadingMore: boolean }>()

defineEmits<{ 'load-more': [] }>()
</script>
