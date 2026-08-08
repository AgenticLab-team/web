import { and, desc, eq, isNull } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { people, roles, userRoles } from "@/lib/db/schema";
import { navItemVisible, tabBarItems, visibleSections, type NavItem } from "@/lib/nav";
import { unreadCount } from "@/lib/forum/notify";
import { can } from "@/lib/rbac/can";
import { resolveDisplayName } from "@/lib/users/display-name";

import { Shortcuts } from "./Shortcuts";
import { Sidebar, type ShellUser } from "./Sidebar";
import { TabBar } from "./TabBar";

/**
 * 应用外壳。移动端底部 Tab Bar，桌面端左侧边栏 —— 两者读同一份导航定义。
 *
 * 导航项的可见性走 can()，不是前端 if。未登录访客看到的就是访客能访问的那几项，
 * 不是「渲染出来点进去再拒绝」。
 */
export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const visible = (item: NavItem) =>
    navItemVisible(item, {
      loggedIn: Boolean(user),
      hasPermission: (permission) => can(user, permission).allowed,
    });

  const sections = visibleSections(visible);
  const tabs = tabBarItems(visible);

  const badges: Record<string, number> = {};
  if (user) badges.notifications = unreadCount(user.id);

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
          className="mx-auto w-full max-w-[52rem] px-4 sm:px-6"
          // 给底部 Tab Bar 让出空间，含 Home Indicator 的安全区
          style={{
            paddingBottom: "calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px) + 1.5rem)",
          }}
        >
          {children}
        </main>
      </div>

      <TabBar items={tabs} badges={badges} />
      <Shortcuts />
    </div>
  );
}
