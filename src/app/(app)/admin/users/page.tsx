import type { Metadata } from "next";
import Link from "next/link";

import { AdminNote, AdminTag } from "@/components/admin/ui";
import { Avatar } from "@/components/Avatar";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Empty, Group, Pill, PillRow, Row, SearchField, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listDepartures, listUsers, userFacets } from "@/lib/admin/users";

export const metadata: Metadata = { title: "用户管理" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  active: "正常",
  pending: "待绑定",
  suspended: "已暂停",
  banned: "已封禁",
  left: "已退群",
  deleted: "已删除",
};

const STATUS_COLOR: Record<string, string> = {
  active: "var(--success)",
  suspended: "var(--warning)",
  banned: "var(--danger)",
};

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; role?: string; page?: string }>;
}) {
  await requireAdmin("user.list");
  const params = await searchParams;

  const { rows, total, slice } = listUsers({
    keyword: params.q,
    status: params.status,
    roleKey: params.role,
    page: params.page,
  });
  const facets = userFacets();
  // 只取最近一批 —— 这一段是「最近有人走吗」，不是一份完整名册
  const departures = listDepartures(20);

  // 筛选链接刻意不带 page —— 换了筛选条件之后停在第 5 页多半是空页
  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { q: params.q, status: params.status, role: params.role, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/users?${qs}` : "/admin/users";
  };

  return (
    <>
      <PageHeader title="用户管理" subtitle={`${total} 个账号`} />

      <form action="/admin/users" className="mb-4">
        {params.status && <input type="hidden" name="status" value={params.status} />}
        {params.role && <input type="hidden" name="role" value={params.role} />}
        <SearchField defaultValue={params.q} placeholder="搜昵称、微信 ID、邮箱或账号 ID" />
      </form>

      <PillRow wrap>
        <Pill href={href({ status: undefined })} active={!params.status}>
          全部状态
        </Pill>
        {facets.status.map((f) => (
          <Pill key={f.value} href={href({ status: f.value })} active={params.status === f.value}>
            {STATUS_LABEL[f.value] ?? f.value} {f.count}
          </Pill>
        ))}
      </PillRow>

      <PillRow>
        <Pill href={href({ role: undefined })} active={!params.role}>
          全部身份
        </Pill>
        {facets.roles.map((f) => (
          <Pill key={f.key} href={href({ role: f.key })} active={params.role === f.key}>
            {f.name} {f.count}
          </Pill>
        ))}
      </PillRow>

      {rows.length === 0 ? (
        <Empty title="没有匹配的账号" hint="换个关键词或筛选条件" />
      ) : (
        <div className="inset-group">
          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/admin/users/${row.id}`}
              className="inset-row flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--fill)]"
            >
              <Avatar wxId={row.wxId ?? row.id} name={row.name} src={row.avatarUrl} size={34} />

              <div className="min-w-0 flex-1">
                <p className="t-body flex items-center gap-1.5 leading-tight">
                  <span className="truncate">{row.name}</span>
                  {STATUS_COLOR[row.status] && row.status !== "active" && (
                    <AdminTag color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status]}</AdminTag>
                  )}
                </p>
                <p className="tabular t-caption mt-0.5 truncate text-[var(--ink-tertiary)]">
                  L{row.level} · {row.points} 分 · {row.groupCount} 个群
                  {row.roleNames.length > 0 && ` · ${row.roleNames.join(" ")}`}
                </p>
              </div>

              <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                {row.lastActiveAt ? relativeTime(row.lastActiveAt) : "未登录过"}
              </span>
            </Link>
          ))}
        </div>
      )}

      <Pagination
        slice={slice}
        total={total}
        noun="个账号"
        basePath="/admin/users"
        params={{ q: params.q, status: params.status, role: params.role }}
      />

      {/*
        离开的人。

        注销掉的账号不在上面那个列表里（它第一个条件就是
        `isNull(deleted_at)`）—— 于是这些人从后台整个消失了，
        连带那句他们留下的话。而注销表单上写着「只有管理员看得到」。

        这一档只给**时间、谁发起的、那句话**，不给身份：
        注销把昵称头像 wx_id 全清了就是为了不再被认出来，
        在这里反查回去等于把刚做掉的匿名化又拆开。
        真要查具体是谁（合规、纠纷）去审计日志 ——
        顺手看得到的和特意去查的，不该是同一个门槛。
      */}
      {departures.length > 0 && (
        <Section title="离开的人" className="mt-8">
          <Group>
            {departures.map((d) => (
              <Row key={d.id}>
                <div className="min-w-0 flex-1">
                  <p className="t-subhead">
                    {d.reason ?? (
                      <span className="text-[var(--ink-tertiary)]">没有留话</span>
                    )}
                  </p>
                  <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
                    {d.bySelf ? "自助注销" : "管理员操作"} ·{" "}
                    {new Date(d.deletedAt).toLocaleString("zh-CN", { hour12: false })}
                  </p>
                </div>
              </Row>
            ))}
          </Group>
          <AdminNote>
            这里不显示是谁 —— 注销的意义就在于不再被认出来。
            确有必要（合规、纠纷）时去
            <Link href="/admin/audit?action=user.delete" className="text-[var(--accent)]">
              审计日志
            </Link>
            ，那里留着删除前的昵称，而查这件事本身也会被记下来。
          </AdminNote>
        </Section>
      )}
    </>
  );
}
