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
      {/* 身份带。用 color-mix 而不是 /12 —— 后者在暗色下算出来的
          底色比亮色下深一档，同一条带子在两套配色里不是一个东西 */}
      <div
        className="mb-5 flex items-center gap-2 rounded-[var(--radius-control)] px-3 py-2"
        style={{ background: "color-mix(in srgb, var(--warning) 12%, transparent)" }}
      >
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
        {/*
          * 目录吸顶。
          *
          * 后台页面动辄三四屏（审计日志、权限矩阵、用户列表），
          * 而原来目录是跟着正文一起滚的 —— 滚到第二屏之后想换一页，
          * 得先滚回最上面。手机上有那个选择器，桌面上什么都没有。
          *
          * top-4 而不是 top-0：贴着窗口顶边的目录看起来像是掉出去了。
          * 自己滚（overflow-y-auto + max-h）—— 24 个入口在 13 寸屏上
          * 放不下，不给它自己的滚动条的话，最后那几项永远够不着。
          */}
        <aside className="hidden shrink-0 lg:block lg:w-[13rem] lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <AdminNav sections={sections} />
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
