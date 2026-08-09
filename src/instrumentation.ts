/**
 * 进程启动钩子。
 *
 * 通知轮询器要在这里起，而不是等第一条 SSE 连接：
 * 半夜没人挂在网页上时，cron 进程照样在写关键词雷达通知 ——
 * 轮询器不跑的话，这些通知的锁屏推送要等到第二天第一个访客
 * 打开页面才补发，「即时推送」在最该用的场景里恰好失灵。
 */
export async function register() {
  // 只在 Node 运行时起 —— 早年 middleware 的 edge 环境里没有 better-sqlite3
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startWatcher, stopWatcher, closeAllStreams } = await import(
    "@/lib/notifications/live"
  );
  startWatcher();

  /*
   * ─────────────────────────────────────────
   * 收到停止信号时松手
   * ─────────────────────────────────────────
   *
   * SSE 是一条永远不结束的响应，而 `next start` 会等手上的请求跑完再退 ——
   * 于是它永远等不到，最后被 systemd 在 90 秒后 SIGKILL。
   *
   * 表现是每次部署慢一分半，而且被停掉的那一边留下一个 `failed` 单元。
   * 蓝绿部署之前这件事不明显（一次部署本来就要重启），
   * 换成蓝绿之后它变成了「切完流量之后还要再干等一分半」。
   *
   * 这里只**释放资源**，不调用 process.exit：
   * 该由谁来结束进程就由谁结束。自己 exit 的话，
   * 正在写库的那一笔会被拦腰截断 —— 为了快一秒钟不值得。
   *
   * `once` 而不是 `on`：systemd 停不掉时会再发一次信号，
   * 而第二次进来时该断的已经断了，重复跑一遍只会在日志里多一行噪音。
   */
  const release = () => {
    try {
      closeAllStreams();
      stopWatcher();
    } catch {
      /* 释放失败也要让信号继续走下去，不能把退出流程挡住 */
    }
  };
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
}
