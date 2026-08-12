import { eq } from "drizzle-orm";
import type { Metadata } from "next";

import { GrantManager } from "@/components/api/GrantManager";
import { LogFilters } from "@/components/api/LogFilters";
import { paginate } from "@/lib/pagination";
import { SendLog } from "@/components/api/SendLog";
import { Pagination } from "@/components/ui/Pagination";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section, StatTile } from "@/components/ui/primitives";
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
 *
 * ─────────────────────────────────────────
 * 顶上三个数是「要不要往下看」的入口
 * ─────────────────────────────────────────
 *
 * 后台页面最常见的用法是**扫一眼确认没事**，而不是逐条读。
 * 原来这一页开头直接就是一个多字段的授权表单 —— 于是
 * 「现在一共授权了几个人」这种一秒钟的问题，要靠自己数卡片。
 */
/** 日志一页多少条 */
const PER_PAGE = 25;

export default async function AdminApiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin("system.settings");

  const sp = await searchParams;
  const one = (key: string) => {
    const value = sp[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const conv = one("conv") ?? "";
  const rawStatus = one("status");
  // 认不出来的一律当「全部」—— 地址栏里的东西什么都可能有
  const status = rawStatus === "ok" || rawStatus === "failed" ? rawStatus : "all";
  const q = one("q") ?? "";
  const grants = allGrants();
  // 全站视角：这一页的意义就是看别人发了什么
  /*
   * 先按条件数一遍，再让 lib/pagination 把页码夹进合法区间，
   * 最后才用它算出来的 offset 去取那一页。
   *
   * 顺序不能反：先取数据再夹页码的话，`?page=999` 会先打一次
   * 空查询，然后界面显示「第 3 页」而列表是空的。
   */
  const counted = sendLog({
    userId: null,
    convId: conv || null,
    status,
    query: q || null,
    limit: 1,
    offset: 0,
  });
  const slice = paginate(one("page"), counted.total, PER_PAGE);
  const log = sendLog({
    userId: null,
    convId: conv || null,
    status,
    query: q || null,
    limit: slice.perPage,
    offset: slice.offset,
  });
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

  /*
   * 拿到授权的**人数**，不是授权条数。
   *
   * 库里一个人十二个群就是十二行，直接报「12 条授权」会让人
   * 以为有十二个人能借机器人的嘴说话 —— 而那正是这一页
   * 唯一真正要盯住的数字。
   */
  const grantedPeople = new Set(grants.map((g) => g.userId)).size;

  return (
    <>
      <BackLink href="/admin">管理</BackLink>
      <PageHeader title="开放 API" subtitle="谁能借机器人的嘴说话，以及他们说了什么" />

      <div className="mb-7 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <StatTile
          label="人能代发"
          value={grantedPeople}
          hint={grantedPeople > 0 ? `共 ${grants.length} 条逐群授权` : "还没有给出去过"}
          tone={grantedPeople > 0 ? "warning" : undefined}
        />
        <StatTile label="个群可授权" value={groups.length} hint="只算开了同步的" />
        <StatTile
          label="条代发记录"
          value={counted.total}
          hint={conv || q || status !== "all" ? "当前筛选下" : "全站累计"}
        />
      </div>

      <Section title="逐群发送授权">
        <GrantManager grants={grants} groups={groups} people={people} limits={SEND_LIMIT} />
      </Section>

      <Section title="代发日志（全站）">
        <LogFilters groups={groups.map((g) => ({ value: g.convId, label: g.name }))} />
        <SendLog rows={log.rows} showWho />
        <Pagination
          slice={slice}
          total={log.total}
          noun="条代发"
          basePath="/admin/api"
          params={{ conv, status: status === "all" ? undefined : status, q }}
        />
      </Section>

      <PageNote>
        授权给出去的是「以机器人的身份在这个群里说话」—— 群里的人看到的是机器人，
        所以每条消息都会自动带一行「本消息由「某某」使用 AgenticLab.sh 代发」，这一行去不掉。
        额度只能往严了调：上游的发送额度全站共用，放宽会挤掉你自己的群发公告和系统告警。
      </PageNote>
    </>
  );
}
