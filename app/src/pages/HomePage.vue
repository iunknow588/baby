<template>
  <section class="panel">
    <h2 class="page-title">Baby 跨平台 H5</h2>
    <p>支持聊天、语音交互与社交关系管理。请选择下方入口继续。</p>
  </section>

  <section class="panel" style="display: flex; gap: 8px; flex-wrap: wrap">
    <RouterLink to="/chat">进入聊天</RouterLink>
    <RouterLink to="/contacts">联系人</RouterLink>
    <RouterLink to="/social">社交广场</RouterLink>
    <RouterLink to="/profile">个人中心</RouterLink>
  </section>
</template>

<script setup lang="ts"></script>
