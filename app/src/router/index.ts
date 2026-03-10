import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', component: () => import('../pages/ChatPage.vue') },
    { path: '/contacts', component: () => import('../pages/ContactsPage.vue') },
    { path: '/social', component: () => import('../pages/SocialPage.vue') },
    { path: '/profile', component: () => import('../pages/ProfilePage.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/chat' }
  ]
})

export default router
