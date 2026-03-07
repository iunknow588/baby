<template>
  <div class="app-shell">
    <header class="topbar">
      <h1>Lumen Social</h1>
      <nav>
        <RouterLink to="/">首页</RouterLink>
        <RouterLink to="/chat">聊天</RouterLink>
        <RouterLink to="/contacts">联系人</RouterLink>
        <RouterLink to="/social">发现</RouterLink>
        <RouterLink to="/profile">我的</RouterLink>
      </nav>
    </header>
    <main class="page-container">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts"></script>
