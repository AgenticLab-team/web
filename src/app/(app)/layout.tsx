import { AppShell } from "@/components/shell/AppShell";

/**
 * 带外壳的页面组。登录页不在这个组里 —— 未绑定的人不该看到导航，
 * 那会暴露还没资格访问的入口。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
