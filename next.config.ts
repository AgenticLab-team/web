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

  /*
   * 开发时允许从哪些 host 取 dev 资源。**只影响 next dev，不影响线上。**
   *
   * ─────────────────────────────────────────
   * 症状是「页面出来了，但什么都点不动」
   * ─────────────────────────────────────────
   *
   * Next 16 默认只放行 localhost 取 `/_next/static/...`。用局域网地址
   * （`http://192.168.x.x:3000`）打开的话，chunk 全部被拦掉 ——
   * 服务端渲染的 HTML 照常显示，但**客户端一行都没水合**：
   * 所有 onClick 都是死的，登录按钮、主题切换、验证码轮询一起失灵。
   *
   * 而这个站有一半以上的人在微信里用手机看，「拿手机连局域网试一下」
   * 是这个项目最常见的一次自测 —— 撞上它的人只会以为自己把界面改坏了。
   * 浏览器控制台里也看不出所以然，那条提示只出现在 dev server 的终端里。
   *
   * 写成环境变量而不是把 IP 写死在仓库里：局域网地址每个人都不一样，
   * 而且它换一个 Wi-Fi 就变。
   *
   *   NEXT_DEV_ORIGINS=192.168.8.4 npm run dev
   *   NEXT_DEV_ORIGINS=192.168.8.4,10.0.0.7 npm run dev   # 多个用逗号分开
   */
  allowedDevOrigins: (process.env.NEXT_DEV_ORIGINS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),

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
