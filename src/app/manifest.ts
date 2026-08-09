import type { MetadataRoute } from "next";

/**
 * PWA manifest。
 *
 * ─────────────────────────────────────────
 * 这不是为了「能装成 App」
 * ─────────────────────────────────────────
 *
 * 是为了 iPhone 能收到推送。
 *
 * iOS 上的 Web Push **只对加到主屏的站点开放** —— 在 Safari 里
 * 直接打开的网页，`Notification` 那套 API 根本不存在。
 * 而加到主屏这条路要求站点有 manifest。
 *
 * 也就是说：在这个文件存在之前，「支持一下即时推送通知」这件事
 * 对所有 iPhone 用户是彻底关死的，而推送设置页只会告诉他们
 * 「这个浏览器收不到推送」，不会告诉他们有一条路可以走。
 *
 * ─────────────────────────────────────────
 * display 用 standalone
 * ─────────────────────────────────────────
 *
 * `browser` 会让 iOS 认为这只是个书签，仍然不给推送权限。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Agentic Lab",
    short_name: "AgenticLab",
    description: "Agentic Lab 社区 —— 群聊之外的家",
    start_url: "/",
    scope: "/",
    display: "standalone",
    /*
     * 背景色和主题色跟着浅色主题走。
     *
     * 这两个值在启动画面和状态栏上用，而系统**不会**跟着切深色 ——
     * 给深色值的话，浅色系统里打开会闪一下深色底。
     */
    background_color: "#ffffff",
    theme_color: "#0d5c47",
    lang: "zh-CN",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // maskable 给 Android 的自适应图标 —— 没有它系统会自己裁一刀，
      // 而那一刀多半会切掉耳朵
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
