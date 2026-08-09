/*
 * Web Push 的 Service Worker。
 *
 * 刻意保持最小：只收推送、只处理点击，不做离线缓存 ——
 * 缓存策略出错的代价（用户永远看到旧页面）远大于这里能带来的收益，
 * 而且这个文件没有构建管线，写进来的每一行都要能被直接读懂。
 *
 * 体积也是预算的一部分：首屏 JS 预算 160KB，这个文件必须忽略不计。
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
