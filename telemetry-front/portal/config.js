/* ═══════════════════════════════════════════════════════════
   config.js — 部署期配置（不参与构建，可直接改）
   运维/部署时只改这个文件即可，无需改动 bright.js 源码。
   ═══════════════════════════════════════════════════════════ */
window.APP_CONFIG = {
  // 后端 API 前缀（telemetry-api-contract.md，看板接口在 /dashboard/* 下）。
  // 同域部署示例： "/api/v1"
  // 跨域/独立网关示例： "https://api.example.com/api/v1"
  apiBase: "/api/v1",

  // true  = 使用内建 mock 数据（mock-data.js），不发真实请求，用于本地预览/演示
  // false = 走真实后端接口（apiBase）
  useMock: false,

  // fetch 超时（毫秒）
  timeout: 15000,

  // 需要携带 Cookie / 同源凭证时设为 "include"，否则 "same-origin"
  credentials: "same-origin",
};
