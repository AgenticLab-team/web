import type { Metadata } from "next";
import Link from "next/link";

import { Avatar } from "@/components/Avatar";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listUsers, userFacets } from "@/lib/admin/users";

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
  searchParams: Promise<{ q?: string; status?: string; role?: string }>;
}) {
  await requireAdmin("user.list");
  const params = await searchParams;

  const { rows, total } = listUsers({
    keyword: params.q,
    status: params.status,
    roleKey: params.role,
    limit: 60,
  });
  const facets = userFacets();

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
        <input
          name="q"
          defaultValue={params.q}
          placeholder="搜昵称、微信 ID、邮箱或账号 ID"
          className="t-body w-full rounded-[var(--radius-card)] bg-[var(--surface)] px-4 py-3 outline-none hairline placeholder:text-[var(--ink-quaternary)]"
        />
      </form>

      <div className="mb-2 flex flex-wrap gap-1.5">
        <Pill href={href({ status: undefined })} active={!params.status}>
          全部状态
        </Pill>
        {facets.status.map((f) => (
          <Pill key={f.value} href={href({ status: f.value })} active={params.status === f.value}>
            {STATUS_LABEL[f.value] ?? f.value} {f.count}
          </Pill>
        ))}
      </div>

      <div className="-mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
        <span className="shrink-0">
          <Pill href={href({ role: undefined })} active={!params.role}>
            全部身份
          </Pill>
        </span>
        {facets.roles.map((f) => (
          <span key={f.key} className="shrink-0">
            <Pill href={href({ role: f.key })} active={params.role === f.key}>
              {f.name} {f.count}
            </Pill>
          </span>
        ))}
      </div>

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
                    <span
                      className="t-caption2 shrink-0 rounded-[var(--radius-pill)] px-1.5 py-0.5 font-medium"
                      style={{
                        background: `color-mix(in srgb, ${STATUS_COLOR[row.status]} 15%, transparent)`,
                        color: STATUS_COLOR[row.status],
                      }}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
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
    </>
  );
}
