<template>
  <section class="panel" style="margin-bottom: 12px">
    <h3 class="page-title">发起好友申请</h3>
    <div style="display: flex; gap: 8px">
      <input v-model="targetUserId" placeholder="输入目标用户ID，如 u_1001" style="flex: 1" />
      <button :disabled="social.actionLoading" @click="sendRequest">发送</button>
    </div>
  </section>

  <ContactList
    :contacts="social.contacts"
    :loaded="social.contactsLoaded"
    :loading-more="social.loadingMoreContacts"
    @load-more="social.fetchMoreContacts"
  />
  <FriendRequestPanel
    style="margin-top: 12px"
    :items="social.friendRequests"
    @accept="social.acceptRequest"
    @reject="social.rejectRequest"
  />

  <section v-if="social.lastError" class="panel" style="margin-top: 12px; color: #b42318">
    {{ social.lastError }}
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import ContactList from '../components/social/ContactList.vue'
import FriendRequestPanel from '../components/social/FriendRequestPanel.vue'
import { useSocialStore } from '../stores/social'

const social = useSocialStore()
const targetUserId = ref('')

onMounted(() => {
  social.fetchContacts()
})

async function sendRequest() {
  const value = targetUserId.value.trim()
  if (!value) return
  await social.sendRequest(value)
  targetUserId.value = ''
}
</script>
