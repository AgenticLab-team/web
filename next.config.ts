import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * 构建产物往哪放。
   *
   * 线上是蓝绿两份：`.next-blue` 和 `.next-green`，一份在跑、另一份在建。
   * 这不是为了花哨 —— 是因为**在线上直接 `next build` 会把正在跑的那个
   * 进程脚下的 `.next` 换掉**。构建那一分多钟里，运行中的实例按老的
   * chunk 名去读文件，而那些文件已经不在了：页面报错、502。
   * 站长看到的「502 时间特别长」，大半是这一段，而不是重启那几秒。
   *
   * 本地不设这个变量，还是 `.next`，开发一切照旧。
   * distDir 不能跑到项目目录外面去（Next 的限制），所以只能是这种相对名字。
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",

  // 不指定的话 Turbopack 会往上找到 /home/jmr 并把家目录当作项目根
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ["better-sqlite3"],
  images: {
    // 微信头像的两个域名。只放行这些，避免变成任意图片代理。
    // 存库时会统一升级成 https（见 src/lib/avatar.ts），这里只留 https。
    remotePatterns: [
      { protocol: "https", hostname: "wx.qlogo.cn" },
      { protocol: "https", hostname: "mmhead.hk.wechat.com" },
      { protocol: "https", hostname: "wework.qpic.cn" },
    ],
  },
};

export default nextConfig;
