/*
 * Web Push 的 Service Worker。
 *
 * 刻意保持最小：收推送、处理点击，**不做离线缓存** ——
 * 缓存策略出错的代价（用户永远看到旧页面）远大于这里能带来的收益，
 * 而且这个文件没有构建管线，写进来的每一行都要能被直接读懂。
 *
 * 体积也是预算的一部分：首屏 JS 预算里这个文件必须忽略不计。
 *
 * ═════════════════════════════════════════
 * 为什么有一个 fetch 监听
 * ═════════════════════════════════════════
 *
 * 站长报「手机上用 Chrome 装成软件一直装不下来」。查下来是 Chrome 的
 * 安装条件：manifest 齐、图标齐、HTTPS 都满足了，**但它还要求
 * Service Worker 带一个 fetch 处理器** —— 而这个文件原来只有 push
 * 和 notificationclick。少这一个监听，Chrome 就永远不弹安装提示，
 * 而且**不会在任何地方说是为什么**。
 *
 * 加的这个仍然不缓存任何东西：只在**导航请求真的失败时**（断网）
 * 兜一个说人话的页面，别让人看见浏览器那只恐龙。
 * 拿不到网络就拿不到 —— 我们不留旧页面，所以「永远看到旧页面」
 * 那个风险一点都没有引进来。
 */

self.addEventListener("push", (event) => {
  // 收到 push 却不弹通知，浏览器会视为滥用并吊销订阅权 —— 所以永远兜底弹一条
  let data = { title: "有新动静", body: "", link: "/notifications", count: 1 };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* 载荷坏了就用兜底文案，总比不弹被吊销强 */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { link: data.link },
      // tag 固定：同站的多条推送合并成一条，锁屏上刷屏等于教用户关掉我们
      tag: "agenticlab-notifications",
      renotify: true,
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/notifications";
  const url = new URL(link, self.location.origin).href;

  event.waitUntil(
    // 已经开着的窗口就复用并跳转 —— 每次点通知都新开一个标签页很快会开出十几个
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.focus();
          if ("navigate" in client) return client.navigate(url);
          return undefined;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  /*
   * 只接管**页面导航**，别的（接口、图片、脚本）一律不碰 ——
   * 碰了就要考虑缓存一致性，而那正是这个文件不想要的东西。
   */
  if (request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">' +
            "<title>连不上</title><style>" +
            "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
            "font:16px/1.7 system-ui,-apple-system,'PingFang SC',sans-serif;" +
            "background:#faf9f7;color:#1c1b19;padding:24px;text-align:center}" +
            "@media(prefers-color-scheme:dark){body{background:#141312;color:#f0eeea}}" +
            "p{margin:0 0 4px}small{opacity:.55}" +
            "</style></head><body><div>" +
            "<p>现在连不上网</p>" +
            "<small>网络回来之后刷新一下就好 —— 已经收到的通知还在</small>" +
            "</div></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" }, status: 503 },
        ),
    ),
  );
});
