/**
 * 进程启动钩子。
 *
 * 通知轮询器要在这里起，而不是等第一条 SSE 连接：
 * 半夜没人挂在网页上时，cron 进程照样在写关键词雷达通知 ——
 * 轮询器不跑的话，这些通知的锁屏推送要等到第二天第一个访客
 * 打开页面才补发，「即时推送」在最该用的场景里恰好失灵。
 */
export async function register() {
  // 只在 Node 运行时起 —— middleware 的 edge 环境里没有 better-sqlite3
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startWatcher } = await import("@/lib/notifications/live");
    startWatcher();
  }
}
