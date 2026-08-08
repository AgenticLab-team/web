import { ChevronLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { UserActions } from "@/components/admin/UserActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { getUserDetail } from "@/lib/admin/users";
import { describeDevice } from "@/lib/auth/devices";
import { db } from "@/lib/db";
import { roles } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const metadata: Metadata = { title: "用户详情" };
export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  active: "正常",
  pending: "待绑定",
  suspended: "已暂停",
  banned: "已封禁",
  left: "已退群",
};

const ACTION_LABEL: Record<string, string> = {
  warn: "警告", hide: "隐藏内容", delete: "删除内容", restore: "恢复",
  lock: "锁定", collapse: "折叠回复", mute: "禁言", suspend: "暂停", ban: "封禁", unban: "解封",
};

export default async function AdminUserDetail({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin("user.detail.read");
  const { id } = await params;

  const detail = getUserDetail(id);
  if (!detail) notFound();

  const assignable = db
    .select({ key: roles.key, name: roles.name })
    .from(roles)
    .where(eq(roles.assignable, true))
    .all();

  const { user } = detail;

  return (
    <>
      <Link
        href="/admin/users"
        className="t-subhead -ml-1 inline-flex items-center gap-0.5 text-[var(--accent)] transition active:opacity-60"
      >
        <ChevronLeft className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        用户管理
      </Link>

      <PageHeader title={detail.name} subtitle={`${STATUS_LABEL[user.status] ?? user.status} · ${user.kind}`} />

      <Section>
        <div className="inset-group flex items-center gap-4 p-4">
          <Avatar wxId={user.wxId ?? user.id} name={detail.name} src={detail.avatarUrl} size={56} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap gap-1.5">
              {detail.roles.map((role) => (
                <span
                  key={role.id}
                  className="t-caption rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
                  style={{
                    background: `color-mix(in srgb, ${role.color ?? "var(--ink)"} 14%, transparent)`,
                    color: role.color ?? "var(--ink-secondary)",
                  }}
                  title={role.scopeId ? `范围：${role.scopeId}` : "全站"}
                >
                  {role.name}
                  {role.scopeId && " ·限定"}
                  {role.expiresAt && " ·临时"}
                </span>
              ))}
            </div>
            <p className="t-caption font-mono text-[var(--ink-tertiary)]">
              {user.wxId ?? "未绑定微信"}
            </p>
            <p className="tabular t-caption text-[var(--ink-quaternary)]">
              {user.id} · 注册于 {new Date(user.createdAt).toLocaleDateString("zh-CN")}
            </p>
          </div>
        </div>
      </Section>

      <Section title="操作">
        <UserActions
          userId={user.id}
          status={user.status}
          canAdjustPoints={admin.has("points.adjust")}
          canSuspend={admin.has("user.suspend")}
          canGrantRole={admin.has("role.grant")}
          canRevokeSessions={admin.has("user.session.revoke")}
          canNote={admin.has("user.note.write")}
          assignableRoles={assignable}
          heldRoles={detail.roles.map((r) => ({ id: r.id, key: r.key, name: r.name }))}
        />
      </Section>

      <Section title="概况">
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile
            label="积分"
            value={user.points}
            hint={`累计 ${user.pointsTotal} · L${user.level}`}
            accent
          />
          <StatTile label="打卡" value={detail.checkins} hint={`连胜 ${user.streakCurrent}`} />
          <StatTile
            label="论坛"
            value={detail.forum.posts + detail.forum.replies}
            hint={`${detail.forum.posts} 帖 ${detail.forum.replies} 回`}
          />
        </div>
      </Section>

      {detail.groups.length > 0 && (
        <Section title={`所在群（${detail.groups.filter((g) => !g.left).length}）`}>
          <Group>
            {detail.groups.map((group) => (
              <Row key={group.convId}>
                <span className="t-body min-w-0 flex-1 truncate">{group.name}</span>
                {group.left && (
                  <span className="t-caption text-[var(--ink-quaternary)]">已退</span>
                )}
                <span className="tabular t-caption text-[var(--ink-tertiary)]">
                  {group.messages} 条
                </span>
              </Row>
            ))}
          </Group>
        </Section>
      )}

      {detail.moderation.length > 0 && (
        <Section title="处罚记录">
          <Group>
            {detail.moderation.map((action) => (
              <Row key={action.id}>
                <span className="t-subhead shrink-0">
                  {ACTION_LABEL[action.action] ?? action.action}
                </span>
                <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-secondary)]">
                  {action.reason}
                </span>
                {action.revertedAt && (
                  <span className="t-caption2 shrink-0 text-[var(--success)]">已撤销</span>
                )}
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(action.createdAt)}
                </span>
              </Row>
            ))}
          </Group>
        </Section>
      )}

      <Section title="积分流水">
        <Group>
          {detail.ledger.slice(0, 10).map((entry) => (
            <Row key={entry.id}>
              <span className="t-subhead min-w-0 flex-1 truncate">{entry.reason}</span>
              <span
                className={`tabular t-subhead shrink-0 font-medium ${
                  entry.delta > 0 ? "text-[var(--success)]" : "text-[var(--ink-secondary)]"
                }`}
              >
                {entry.delta > 0 ? "+" : ""}
                {entry.delta}
              </span>
              <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                {relativeTime(entry.createdAt)}
              </span>
            </Row>
          ))}
          {detail.ledger.length === 0 && (
            <Row>
              <span className="t-subhead text-[var(--ink-secondary)]">还没有积分变动</span>
            </Row>
          )}
        </Group>
      </Section>

      <Section title={`登录设备（${detail.sessions.length}）`}>
        <Group>
          {detail.sessions.map((session) => (
            <Row key={session.id}>
              <span className="t-subhead min-w-0 flex-1 truncate">
                {session.deviceName ?? describeDevice(session.userAgent)}
              </span>
              <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                {session.ip}
              </span>
              <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                {relativeTime(session.lastSeenAt)}
              </span>
            </Row>
          ))}
          {detail.sessions.length === 0 && (
            <Row>
              <span className="t-subhead text-[var(--ink-secondary)]">没有活跃会话</span>
            </Row>
          )}
        </Group>
        {detail.credentials.length > 0 && (
          <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">
            凭证：{detail.credentials.map((c) => c.name ?? c.type).join("、")}
          </p>
        )}
      </Section>

      {detail.notes.length > 0 && (
        <Section title="管理员备注">
          <Group>
            {detail.notes.map((note) => (
              <Row key={note.id}>
                <span className="t-subhead min-w-0 flex-1">{note.content}</span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-quaternary)]">
                  {relativeTime(note.createdAt)}
                </span>
              </Row>
            ))}
          </Group>
          <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">用户本人看不到这些备注</p>
        </Section>
      )}

      <Section title={`有效权限（${detail.permissions.length}）`}>
        <details className="inset-group">
          <summary className="t-subhead cursor-pointer list-none px-4 py-3">
            展开查看每一项的来源
          </summary>
          <div className="border-t border-[var(--separator)] px-4 py-3">
            <ul className="grid gap-1 sm:grid-cols-2">
              {detail.permissions.map((permission) => (
                <li key={permission.key} className="t-caption flex justify-between gap-2">
                  <span className="truncate font-mono text-[var(--ink-secondary)]">
                    {permission.key}
                  </span>
                  <span className="shrink-0 text-[var(--ink-quaternary)]">{permission.source}</span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </Section>
    </>
  );
}
