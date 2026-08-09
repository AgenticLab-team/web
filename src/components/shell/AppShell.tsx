import { and, desc, eq, isNull } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { people, roles, userRoles } from "@/lib/db/schema";
import {
  moreSheetSections,
  navItemVisible,
  tabBarItems,
  visibleSections,
  type NavItem,
} from "@/lib/nav";
import { unreadCount } from "@/lib/forum/notify";
import { featureEnabled } from "@/lib/flags/server";
import { can } from "@/lib/rbac/can";
import { resolveDisplayName } from "@/lib/users/display-name";

import { LiveNotifications } from "@/components/notifications/LiveNotifications";

import { Announcements, type AnnouncementView } from "@/components/shell/Announcements";
import { announcementsFor } from "@/lib/broadcast/announce";
import { renderMarkdown } from "@/lib/markdown";
import { Shortcuts } from "./Shortcuts";
import { Sidebar, type ShellUser } from "./Sidebar";
import { TabBar } from "./TabBar";

/**
 * 应用外壳。移动端底部 Tab Bar，桌面端左侧边栏 —— 两者读同一份导航定义。
 *
 * 导航项的可见性走 can()，不是前端 if。未登录访客看到的就是访客能访问的那几项，
 * 不是「渲染出来点进去再拒绝」。
 */

/**
 * 把一条公告渲染成可以直接塞进 DOM 的 HTML。
 *
 * 走 `renderMarkdown` 而不是 `escapeHtml` —— 公告和帖子正文用同一条
 * 消毒管线，包括那条「站外图片降级成链接」的规则。
 * 另写一套的话，那些坑要重新踩一遍，而公告是管理员写的、
 * 出问题时影响的是所有人。
 */
async function toView(a: {
  id: string;
  title: string | null;
  content: string;
}): Promise<AnnouncementView> {
  const { html } = await renderMarkdown(a.content);
  return { id: a.id, title: a.title, html };
}

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const visible = (item: NavItem) =>
    navItemVisible(item, {
      loggedIn: Boolean(user),
      hasPermission: (permission) => can(user, permission).allowed,
      // 关掉的功能不出现在导航里；页面那一侧 requireFeature 还会再挡一次
      featureEnabled: (flag) => featureEnabled(flag, user),
    });

  const sections = visibleSections(visible);
  const tabs = tabBarItems(visible);
  // 「更多」= 所有不在 tab 栏里的，用减法算出来 —— 新页面自动进得去
  const moreSections = moreSheetSections(visible);

  const badges: Record<string, number> = {};
  if (user) badges.notifications = unreadCount(user.id);

  /*
   * 站内公告。
   *
   * 正文走和帖子同一条 markdown 管线 —— 一条公告常常需要给一个链接，
   * 而「详见某某页」写成纯文本等于没给。渲染不便宜（shiki + 消毒），
   * 所以**只有真的有公告时才渲染**：`announcementsFor` 在没有生效公告时
   * 一条便宜的查询就返回了，而那是绝大多数时候。
   */
  const live = announcementsFor(user);
  const announcements =
    live.modal || live.banners.length > 0
      ? {
          modal: live.modal ? await toView(live.modal) : null,
          banners: await Promise.all(live.banners.map(toView)),
        }
      : null;

  let shellUser: ShellUser | null = null;
  if (user) {
    const profile = user.wxId
      ? db.select().from(people).where(eq(people.wxId, user.wxId)).get()
      : null;

    // 一个人可能有多个身份组，展示优先级最高的那个
    const topRole = db
      .select({ name: roles.name, color: roles.color, priority: roles.priority })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
      .orderBy(desc(roles.priority))
      .get();

    shellUser = {
      name: resolveDisplayName([user.siteNickname, user.wxNickname, profile?.displayName], {
        wxId: user.wxId,
        fallback: "我",
      }),
      wxId: user.wxId ?? user.id,
      avatarUrl: user.wxAvatarUrl ?? profile?.avatarUrl ?? null,
      level: user.level,
      points: user.points,
      roleLabel: topRole?.name ?? null,
      roleColor: topRole?.color ?? null,
    };
  }

  return (
    <div className="min-h-dvh">
      {/* 跳到正文：键盘用户不必每次都 Tab 过整个侧边栏 */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-[var(--accent)] focus:px-4 focus:py-2 focus:text-[var(--accent-ink)]"
      >
        跳到正文
      </a>
      <Sidebar sections={sections} user={shellUser} badges={badges} />

      <div className="lg:pl-[var(--sidebar-width)]">
        <main
          id="main"
          className="mx-auto w-full px-4 sm:px-6"
          style={{
            /*
             * 栏宽由内容类型决定，不写死在这里 ——
             * 密集页面（后台、表格）用 [data-dense] 声明自己要宽的，
             * globals.css 里那条 :has() 会把它放到 78rem。
             */
            maxWidth: "var(--content-max)",
            // 给底部 Tab Bar 让出空间，含 Home Indicator 的安全区
            paddingBottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 1.5rem)",
          }}
        >
          {/*
            * 公告摆在正文之上、外壳之内。
            *
            * 放进 main 里而不是钉在窗口顶上：钉住的话它会一直占着
            * 一条高度，在手机上那是首屏的十分之一；而公告本来就是
            * 「看一眼就关掉」的东西，跟着页面滚走是对的。
            */}
          {announcements && (
            <Announcements banners={announcements.banners} modal={announcements.modal} />
          )}
          {children}
        </main>
      </div>

      <TabBar items={tabs} more={moreSections} badges={badges} />
      {/* 只给登录用户挂实时通道 —— 访客连上也只会收到 401 */}
      {user && <LiveNotifications />}
      <Shortcuts />
    </div>
  );
}
