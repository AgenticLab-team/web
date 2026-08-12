import { eq } from "drizzle-orm";
import type { Metadata } from "next";

import { GrantManager } from "@/components/api/GrantManager";
import { SendLog } from "@/components/api/SendLog";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { SEND_LIMIT } from "@/lib/api-tokens/rules";
import { allGrants, sendLog } from "@/lib/api-tokens/store";
import { requireAdmin } from "@/lib/admin/guard";
import { listGroupsForAdmin } from "@/lib/admin/groups";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { resolveDisplayName } from "@/lib/users/display-name";

export const metadata: Metadata = { title: "开放 API" };
export const dynamic = "force-dynamic";

/**
 * 站长这一侧：谁能往哪个群发，以及他们发了什么。
 *
 * ═════════════════════════════════════════
 * 「发了什么」和「谁能发」摆在同一页
 * ═════════════════════════════════════════
 *
 * 分成两页的话，授权那一页会变成一张没有人回头看的名单 ——
 * 而判断「这条授权还该不该留着」的唯一依据，正是他到底用它做了什么。
 */
export default async function AdminApiPage() {
  await requireAdmin("system.settings");

  const grants = allGrants();
  // 全站视角：这一页的意义就是看别人发了什么
  const log = sendLog({ userId: null, limit: 100 });
  const groups = listGroupsForAdmin()
    .filter((g) => g.syncEnabled)
    .map((g) => ({ convId: g.convId, name: g.name }));

  /*
   * 可以授权给谁 —— 直接把人列出来。
   *
   * 原来这个表单要**手打账号 id**（`01JABC…`），而没有人知道另一个人的
   * 内部 id 长什么样：得先开用户管理页、找到他、复制、切回来。
   * 于是这个功能虽然做出来了，实际上很难用 —— 站长的原话是
   * 「我也可以单独授权某个群给某个人」。
   *
   * 全站注册账号 137 个，一个下拉框装得下，不需要搜索。
   * （群成员两千多，但那是 people；能被授权的只能是有账号的人。）
   */
  const people = db
    .select({
      id: users.id,
      site: users.siteNickname,
      wx: users.wxNickname,
      wxId: users.wxId,
    })
    .from(users)
    .where(eq(users.status, "active"))
    .all()
    .map((u) => ({
      id: u.id,
      name: resolveDisplayName([u.site, u.wx], { wxId: u.wxId, fallback: "成员" }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  return (
    <>
      <BackLink href="/admin">管理</BackLink>
      <PageHeader
        title="开放 API"
        subtitle="谁能借机器人的嘴说话，以及他们说了什么"
      />

      <Section title="逐群发送授权">
        <GrantManager grants={grants} groups={groups} people={people} limits={SEND_LIMIT} />
      </Section>

      <Section title="代发日志（全站）">
        <SendLog rows={log} showWho />
      </Section>

      <PageNote>
        授权给出去的是<strong>「以机器人的身份在这个群里说话」</strong>——
        群里的人看到的是机器人，所以每条消息都会自动带一行
        「本消息由「某某」使用 AgenticLab.sh 代发」，这一行去不掉。
        额度这里只能往严了调：上游的发送额度是全站共用的，
        放宽会挤掉你自己的群发公告和系统告警。
      </PageNote>
    </>
  );
}
