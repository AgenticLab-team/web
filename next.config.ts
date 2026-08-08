import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 不指定的话 Turbopack 会往上找到 /home/jmr 并把家目录当作项目根
  turbopack: {
    root: __dirname,
  },
  serverExternalPackages: ["better-sqlite3"],
  images: {
    // 微信头像域名。只放行这一个，避免变成任意图片代理
    remotePatterns: [{ protocol: "http", hostname: "wx.qlogo.cn" }],
  },
};

export default nextConfig;
