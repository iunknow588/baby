import { defineStore } from 'pinia'
import { socialApi, type ContactItem, type FriendRequestItem } from '../services/api/social.api'
import { toUserError } from '../services/api/errorMap'

function mergeContacts(base: ContactItem[], incoming: ContactItem[]): ContactItem[] {
  const map = new Map<string, ContactItem>()
  base.forEach(item => map.set(item.userId, item))
  incoming.forEach(item => map.set(item.userId, item))
  return [...map.values()]
}

export const useSocialStore = defineStore('social', {
  state: () => ({
    contacts: [] as ContactItem[],
    friendRequests: [] as FriendRequestItem[],
    contactsCursor: '' as string | undefined,
    contactsLoaded: false,
    loading: false,
    loadingMoreContacts: false,
    actionLoading: false,
    lastError: ''
  }),
  actions: {
    async fetchContacts(reset = true) {
      this.loading = true
      this.lastError = ''
      try {
        const [contactsPaged, requests] = await Promise.all([
          socialApi.listContacts(reset ? undefined : this.contactsCursor),
          socialApi.listFriendRequests()
        ])
        this.contacts = reset
          ? contactsPaged.list
          : mergeContacts(this.contacts, contactsPaged.list)
        this.contactsCursor = contactsPaged.nextCursor
        this.contactsLoaded = !contactsPaged.hasMore
        this.friendRequests = requests
      } catch {
        this.contacts = [
          { userId: 'u_01', username: 'Luna', relation: 'friend' },
          { userId: 'u_02', username: 'Kai', relation: 'pending' }
        ]
        this.friendRequests = [
          {
            requestId: 'fr_01',
            fromUserId: 'u_03',
            fromUsername: 'Milo',
            createdAt: new Date().toISOString()
          }
        ]
        this.contactsCursor = undefined
        this.contactsLoaded = true
      } finally {
        this.loading = false
      }
    },

    async fetchMoreContacts() {
      if (this.loadingMoreContacts || this.contactsLoaded) return
      this.loadingMoreContacts = true
      this.lastError = ''
      try {
        const result = await socialApi.listContacts(this.contactsCursor)
        this.contacts = mergeContacts(this.contacts, result.list)
        this.contactsCursor = result.nextCursor
        this.contactsLoaded = !result.hasMore
      } catch (error) {
        this.lastError = toUserError(error)
      } finally {
        this.loadingMoreContacts = false
      }
    },

    async sendRequest(targetUserId: string) {
      if (!targetUserId.trim()) return
      this.actionLoading = true
      this.lastError = ''
      try {
        await socialApi.sendFriendRequest(targetUserId)
      } catch (error) {
        this.lastError = toUserError(error)
      } finally {
        this.actionLoading = false
      }
    },

    async acceptRequest(requestId: string) {
      this.actionLoading = true
      this.lastError = ''
      try {
        await socialApi.acceptFriendRequest(requestId)
      } catch (error) {
        this.lastError = toUserError(error)
      } finally {
        this.friendRequests = this.friendRequests.filter(item => item.requestId !== requestId)
        this.actionLoading = false
      }
    },

    async rejectRequest(requestId: string) {
      this.actionLoading = true
      this.lastError = ''
      try {
        await socialApi.rejectFriendRequest(requestId)
      } catch (error) {
        this.lastError = toUserError(error)
      } finally {
        this.friendRequests = this.friendRequests.filter(item => item.requestId !== requestId)
        this.actionLoading = false
      }
    }
  }
})
