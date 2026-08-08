import { Check, Minus, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Empty, Pill, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { buildMatrix, categoryLabel, whoHasPermission } from "@/lib/admin/permissions";
import { getPermission, type PermissionKey } from "@/lib/rbac/permissions";

export const metadata: Metadata = { title: "身份组与权限" };
export const dynamic = "force-dynamic";

const DANGER_LABEL = ["", "敏感", "危险", "极危"];

export default async function AdminRolesPage({
  searchParams,
}: {
  searchParams: Promise<{ lookup?: string; category?: string }>;
}) {
  await requireAdmin("role.read");
  const params = await searchParams;

  const matrix = buildMatrix();
  const activeCategory = params.category ?? matrix.categories[0]?.category;
  const category = matrix.categories.find((c) => c.category === activeCategory);

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
        <div className="-mx-4 mb-3 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0">
          {matrix.categories.map((c) => (
            <span key={c.category} className="shrink-0">
              <Pill href={href({ category: c.category })} active={c.category === activeCategory}>
                {categoryLabel(c.category)} {c.permissions.length}
              </Pill>
            </span>
          ))}
        </div>

        {!category ? (
          <Empty title="没有权限点" />
        ) : (
          <div className="inset-group overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="t-caption sticky left-0 z-10 bg-[var(--surface)] px-4 py-2 text-left font-medium text-[var(--ink-tertiary)]">
                    权限点
                  </th>
                  {matrix.roles.map((role) => (
                    <th
                      key={role.id}
                      className="t-caption2 px-2 py-2 text-center font-medium text-[var(--ink-tertiary)]"
                      title={`${role.name} · ${role.holders} 人`}
                    >
                      <span className="block max-w-[3.5rem] truncate">{role.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {category.permissions.map((permission) => (
                  <tr key={permission.key} className="border-t border-[var(--separator)]">
                    <th className="sticky left-0 z-10 bg-[var(--surface)] px-4 py-2 text-left font-normal">
                      <Link
                        href={href({ lookup: permission.key })}
                        className="block"
                        title="点击反查谁拥有它"
                      >
                        <span className="t-subhead block truncate">
                          {permission.label}
                          {permission.dangerLevel ? (
                            <span
                              className="ml-1.5 text-[var(--danger)]"
                              title={DANGER_LABEL[permission.dangerLevel]}
                            >
                              ●
                            </span>
                          ) : null}
                        </span>
                        <code className="t-caption2 block truncate font-mono text-[var(--ink-quaternary)]">
                          {permission.key}
                        </code>
                      </Link>
                    </th>
                    {matrix.roles.map((role) => {
                      const state = matrix.cells.get(role.id)?.get(permission.key) ?? "none";
                      return (
                        <td key={role.id} className="px-2 py-2 text-center">
                          {state === "granted" ? (
                            <Check
                              className="mx-auto h-3.5 w-3.5 text-[var(--success)]"
                              strokeWidth={3}
                              aria-label="允许"
                            />
                          ) : state === "denied" ? (
                            <X
                              className="mx-auto h-3.5 w-3.5 text-[var(--danger)]"
                              strokeWidth={3}
                              aria-label="显式拒绝"
                            />
                          ) : (
                            <Minus
                              className="mx-auto h-3 w-3 text-[var(--ink-quaternary)]"
                              strokeWidth={2.5}
                              aria-label="未授予"
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          ✓ 允许 · ✗ 显式拒绝（优先级高于任何允许）· − 未授予。
          点权限点名可以反查谁拥有它。红点表示危险操作。
        </p>
      </Section>

      <Section title="以某身份预览">
        <div className="inset-group p-4">
          <p className="t-subhead mb-2">
            看矩阵永远想不清楚「版主到底能不能删别人的帖」——
            切过去点一下就知道了。
          </p>
          <p className="t-caption text-[var(--ink-tertiary)]">
            这个功能待建。当前可以在用户详情页展开「有效权限」，
            逐项看到每个权限来自哪个身份组。
          </p>
        </div>
      </Section>
    </>
  );
}
