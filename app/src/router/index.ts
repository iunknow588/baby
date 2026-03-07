import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: () => import('../pages/HomePage.vue') },
    { path: '/chat', component: () => import('../pages/ChatPage.vue') },
    { path: '/contacts', component: () => import('../pages/ContactsPage.vue') },
    { path: '/social', component: () => import('../pages/SocialPage.vue') },
    { path: '/profile', component: () => import('../pages/ProfilePage.vue') }
  ]
})

export default router
