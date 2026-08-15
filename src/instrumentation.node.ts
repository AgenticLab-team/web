/**
 * 进程启动钩子里**只能在 Node 运行时跑**的那部分。
 *
 * ═════════════════════════════════════════
 * 为什么要单独一个文件
 * ═════════════════════════════════════════
 *
 * `instrumentation.ts` 会被打进**两个**运行时（Node 和 Edge），
 * 而 `process.once` 在 Edge 里不存在。
 *
 * 运行时其实早就挡住了（`NEXT_RUNTIME !== "nodejs"` 直接返回），
 * 但**打包器是静态看的**：它在 Edge 那一份里看见 `process.once`
 * 就要报一条警告。于是每次 `next build` 都顶着几条警告 ——
 * 而一个长期有警告的构建，等于没有构建输出可看：
 * 真出问题那天，那条新的会混在老的里面。
 *
 * 按 Next 文档的做法拆开：入口只留一句分支，
 * 具体实现放在只有 Node 那一侧才会加载的文件里。
 */
export async function registerNode() {
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
