import type { Metadata } from "next";
import Link from "next/link";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { buildMatrix, categoryLabel, whoHasPermission } from "@/lib/admin/permissions";
import { MatrixEditor } from "@/components/admin/MatrixEditor";
import { MatrixHistory } from "@/components/admin/MatrixHistory";
import { getPermission, type PermissionKey } from "@/lib/rbac/permissions";
import { startPreviewAction } from "@/lib/rbac/preview-actions";
import { listSnapshots } from "@/lib/rbac/matrix-snapshots";
import { findPreviewCandidates, recentPreviews } from "@/lib/rbac/preview-queries";
import { PREVIEW_PERMISSION } from "@/lib/rbac/preview-rules";

export const metadata: Metadata = { title: "身份组与权限" };
export const dynamic = "force-dynamic";

const DANGER_LABEL = ["", "敏感", "危险", "极危"];

export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ lookup?: string; category?: string; as?: string; preview_error?: string }>;
}) {
  const admin = await requireAdmin("role.read");
  const params = await searchParams;

  const canPreview = admin.has(PREVIEW_PERMISSION as PermissionKey);
  const canEditMatrix = admin.has("role.manage");
  const snapshots = listSnapshots();
  const candidates = canPreview ? findPreviewCandidates(params.as ?? "") : [];
  const history = recentPreviews();

  const matrix = buildMatrix();

  const lookupKey = params.lookup as PermissionKey | undefined;
  const lookupDef = lookupKey ? getPermission(lookupKey) : undefined;
  const holders = lookupKey ? whoHasPermission(lookupKey) : [];

  const href = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    const merged = { lookup: params.lookup, category: params.category, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) next.set(k, v);
    const qs = next.toString();
    return qs ? `/admin/roles?${qs}` : "/admin/roles";
  };

  return (
    <>
      <PageHeader
        title="身份组与权限"
        subtitle={`${matrix.roles.length} 个身份组 · ${matrix.categories.reduce((n, c) => n + c.permissions.length, 0)} 个权限点`}
      />

      {/* 权限反查：定期回顾「谁能封人」是最基本的治理动作，没有它就只能靠记忆 */}
      {lookupKey && lookupDef && (
        <Section title="权限反查">
          <div className="inset-group p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="t-headline">{lookupDef.label}</span>
              <code className="t-caption font-mono text-[var(--ink-tertiary)]">{lookupKey}</code>
              {lookupDef.dangerLevel ? (
                <span className="t-caption2 rounded-[var(--radius-pill)] bg-[var(--danger)]/15 px-2 py-0.5 font-medium text-[var(--danger)]">
                  {DANGER_LABEL[lookupDef.dangerLevel]}
                </span>
              ) : null}
              <span className="flex-1" />
              <Link href={href({ lookup: undefined })} className="t-caption text-[var(--accent)]">
                收起
              </Link>
            </div>

            {lookupDef.description && (
              <p className="t-footnote mb-3 text-[var(--ink-secondary)]">{lookupDef.description}</p>
            )}

            {holders.length === 0 ? (
              <p className="t-subhead text-[var(--ink-secondary)]">目前没有人拥有这个权限</p>
            ) : (
              <>
                <p className="t-caption mb-2 text-[var(--ink-tertiary)]">
                  当前有 {holders.length} 人拥有：
                </p>
                <ul className="space-y-1.5">
                  {holders.map((holder) => (
                    <li key={holder.userId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Link
                        href={`/admin/users/${holder.userId}`}
                        className="t-subhead font-medium text-[var(--accent)]"
                      >
                        {holder.name}
                      </Link>
                      <span className="t-caption text-[var(--ink-tertiary)]">
                        ← {holder.source}
                        {holder.scope && `（限 ${holder.scope}）`}
                      </span>
                      {holder.expiresAt && (
                        <span className="t-caption2 text-[var(--warning)]">
                          {new Date(holder.expiresAt).toLocaleDateString("zh-CN")} 到期
                        </span>
                      )}
                      <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                        {relativeTime(holder.grantedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Section>
      )}

      <Section title="身份组">
        <div className="inset-group">
          {matrix.roles.map((role) => (
            <div key={role.id} className="inset-row flex items-center gap-3 px-4 py-3">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: role.color ?? "var(--ink-tertiary)" }}
                aria-hidden
              />
              <span className="t-body min-w-0 flex-1">{role.name}</span>
              <code className="t-caption font-mono text-[var(--ink-quaternary)]">{role.key}</code>
              {role.isSystem && (
                <span className="t-caption2 text-[var(--ink-quaternary)]">内置</span>
              )}
              <Link
                href={`/admin/users?role=${role.key}`}
                className="tabular t-caption shrink-0 text-[var(--accent)]"
              >
                {role.holders} 人
              </Link>
            </div>
          ))}
        </div>
      </Section>

      <Section title="权限矩阵">
        <MatrixEditor
          roles={matrix.roles.map((r) => ({
            id: r.id,
            name: r.name,
            color: r.color,
            holders: r.holders,
          }))}
          categories={matrix.categories.map((c) => ({
            category: c.category,
            label: categoryLabel(c.category),
            permissions: c.permissions.map((p) => ({
              key: p.key,
              label: p.label,
              dangerLevel: p.dangerLevel ?? 0,
            })),
          }))}
          initial={Object.fromEntries(
            [...matrix.cells].map(([roleId, perms]) => [roleId, Object.fromEntries(perms)]),
          )}
          canEdit={canEditMatrix}
          lookupBase="/admin/roles?lookup="
        />
      </Section>

      <Section title="矩阵变更历史">
        <MatrixHistory rows={snapshots} canRollback={canEditMatrix} />
      </Section>

      <Section title="以某身份预览">
        <div className="inset-group p-4">
          <p className="t-subhead mb-1">
            看矩阵永远想不清楚「版主到底能不能删别人的帖」—— 切过去点一下就知道了。
          </p>
          <p className="t-caption mb-3 leading-relaxed text-[var(--ink-tertiary)]">
            预览是<strong>只读</strong>的：页面按他的视角渲染，按钮该出现就出现，
            但真去点的时候不会执行 —— 否则审计日志会把这笔记在他头上。
            权限**只减不增**，他有你没有的那些不会生效，横幅里会告诉你少了哪几项。
            30 分钟自动过期。
          </p>

          {params.preview_error && (
            <p
              role="alert"
              className="t-subhead mb-3 rounded-lg border border-[#b91c1c]/40 bg-[#b91c1c]/8 px-3 py-2 text-[#b91c1c]"
            >
              {params.preview_error}
            </p>
          )}

          {canPreview ? (
            <>
              <form method="get" className="mb-3 flex gap-2" action="/admin/roles">
                {params.category && <input type="hidden" name="category" value={params.category} />}
                <input
                  type="search"
                  name="as"
                  defaultValue={params.as ?? ""}
                  placeholder="搜微信号或昵称"
                  aria-label="搜索要预览的人"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--surface)] px-3 py-1.5 text-[14px] outline-none focus-visible:border-[var(--accent)]"
                />
                <button
                  type="submit"
                  className="shrink-0 rounded-lg border border-[var(--hairline)] px-3 py-1.5 text-[13px] transition-colors hover:bg-[var(--surface-hover)]"
                >
                  搜索
                </button>
              </form>

              {params.as && candidates.length === 0 && (
                <p className="t-caption px-1 text-[var(--ink-tertiary)]">没找到这个人。</p>
              )}

              <ul className="divide-y divide-[var(--hairline)]">
                {candidates.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <span className="t-body min-w-0 flex-1 truncate">
                      {c.name}
                      {c.wxId && (
                        <span className="t-caption ml-1.5 text-[var(--ink-tertiary)]">{c.wxId}</span>
                      )}
                    </span>
                    {c.roleNames.map((r) => (
                      <span
                        key={r}
                        className="t-caption shrink-0 rounded-full border border-[var(--hairline)] px-1.5 py-px text-[var(--ink-secondary)]"
                      >
                        {r}
                      </span>
                    ))}
                    <span className="t-caption tabular-nums text-[var(--ink-tertiary)]">
                      {c.permissionCount} 项权限
                    </span>
                    {c.status === "active" ? (
                      <form action={startPreviewAction.bind(null, c.id)} className="shrink-0">
                        <button
                          type="submit"
                          className="rounded-md border border-[#b91c1c] px-2.5 py-1 text-[13px] text-[#b91c1c] transition-colors hover:bg-[#b91c1c] hover:text-white"
                        >
                          以他的身份预览
                        </button>
                      </form>
                    ) : (
                      <span className="t-caption shrink-0 text-[var(--ink-tertiary)]">
                        {c.status === "banned" ? "已封禁" : "不可预览"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="t-caption text-[var(--ink-tertiary)]">
              你没有「以他人身份预览」的权限。可以在用户详情页展开「有效权限」，
              逐项看到每个权限来自哪个身份组。
            </p>
          )}
        </div>
      </Section>

      <Section title="预览记录">
        <div className="inset-group overflow-x-auto">
          {history.length === 0 ? (
            <Empty title="还没有人用过预览" />
          ) : (
            <table className="w-full min-w-[30rem] text-left">
              <thead>
                <tr className="t-caption text-[var(--ink-tertiary)]">
                  <th className="px-4 py-2 font-normal">谁</th>
                  <th className="px-4 py-2 font-normal">看了谁</th>
                  <th className="px-4 py-2 font-normal">什么时候</th>
                  <th className="px-4 py-2 font-normal">结束</th>
                </tr>
              </thead>
              <tbody className="t-subhead">
                {history.map((row) => (
                  <tr key={row.id} className="border-t border-[var(--hairline)]">
                    <td className="px-4 py-2">{row.viewerName}</td>
                    <td className="px-4 py-2">
                      {row.subjectName}
                      {row.withheldCount > 0 && (
                        <span className="t-caption ml-1.5 text-[var(--ink-tertiary)]">
                          少 {row.withheldCount} 项
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-[var(--ink-tertiary)]">
                      {relativeTime(row.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-[var(--ink-tertiary)]">
                      {row.endedAt
                        ? { exit: "已退出", expired: "已过期", revoked: "被掐断" }[
                            row.endReason ?? "exit"
                          ]
                        : "进行中"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="t-caption px-4 py-2 leading-relaxed text-[var(--ink-tertiary)]">
            一个只读的功能，唯一的制衡就是事后看得见 —— 所以这张表不能省。
            每一次进出也都在审计日志里，记的是**真人**，不是被预览的那个人。
          </p>
        </div>
      </Section>

    </>
  );
}
