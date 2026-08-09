import { PreviewBanner } from "@/components/admin/PreviewBanner";
import { AppShell } from "@/components/shell/AppShell";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * 带外壳的页面组。登录页不在这个组里 —— 未绑定的人不该看到导航，
 * 那会暴露还没资格访问的入口。
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      {/* 横幅在外壳之外，且在最前面 —— 预览态下它必须比任何页面内容先出现 */}
      <PreviewBanner />
      <AppShell>{children}</AppShell>
    </ToastProvider>
  );
}
