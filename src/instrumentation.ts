/**
 * 进程启动钩子。
 *
 * 通知轮询器要在这里起，而不是等第一条 SSE 连接：
 * 半夜没人挂在网页上时，cron 进程照样在写关键词雷达通知 ——
 * 轮询器不跑的话，这些通知的锁屏推送要等到第二天第一个访客
 * 打开页面才补发，「即时推送」在最该用的场景里恰好失灵。
 *
 * ⚠️ 这个文件会被打进**两个**运行时，所以它自己不能碰
 * Node 专有的东西（`process.once`、`fs`、better-sqlite3…）——
 * 那些全在 `instrumentation.node.ts` 里，只有 Node 那一侧才加载。
 * 见那个文件顶上的说明。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./instrumentation.node");
  await registerNode();
}
