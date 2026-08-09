import { ShieldAlert } from "lucide-react";

import { AdminNav } from "@/components/admin/AdminNav";
import { AdminNavPicker } from "@/components/admin/AdminNavPicker";
import { requireAdmin } from "@/lib/admin/guard";
import { visibleAdminNav } from "@/lib/admin/nav";

export const dynamic = "force-dynamic";

/**
 * 后台外壳。
 *
 * 视觉上要与前台**有明确区别** —— 管理员在后台的每一次点击
 * 都可能影响别人，需要一个持续的「你在管理区」的提示。
 * 但不能换一整套设计语言：那会让人觉得进了另一个产品。
 * 做法是保留同一套排版与材质，只加一条身份带。
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();
  const sections = visibleAdminNav(admin.has);

  return (
    /*
      * data-dense:告诉外壳这一片要宽栏。
      *
      * 后台没有需要「读」的长句，全是要对照着看的行和列 ——
      * 压在正文栏宽里的话，减掉左边 13rem 的目录之后只剩 592px，
      * 而屏幕有 1900px。
      */
    <div className="pb-8" data-dense>
      <div className="mb-5 flex items-center gap-2 rounded-[var(--radius-control)] bg-[var(--warning)]/12 px-3 py-2">
        <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--warning)]" strokeWidth={2} aria-hidden />
        <p className="t-caption text-[var(--warning)]">
          管理区 · 你在这里的每一次操作都会记入审计日志
        </p>
      </div>

      {/*
        * 手机上把 24 个后台入口收进一个选择器。
        *
        * 之前是同一个 <aside> 在手机上直接堆在正文上面 ——
        * 24 行链接压在每一个后台页面的头顶，
        * 人要滚过整份目录才能看到自己点进来要看的东西。
        * 那不算「有入口」，那是把内容推到了第二屏。
        */}
      <div className="mb-4 lg:hidden">
        <AdminNavPicker sections={sections} />
      </div>

      <div className="gap-8 lg:flex">
        <aside className="hidden shrink-0 lg:block lg:w-[13rem]">
          <AdminNav sections={sections} />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
