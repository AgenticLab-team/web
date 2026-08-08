import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
