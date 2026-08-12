import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Avatar } from "@/components/Avatar";
import { AdminTag } from "@/components/admin/ui";
import { UserActions } from "@/components/admin/UserActions";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { TruncationNote } from "@/components/ui/Pagination";
import { BackLink, Empty, Group, Row, Section, StatTile } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { getUserDetail } from "@/lib/admin/users";
import { describeDevice } from "@/lib/auth/devices";
import { holderCount, listTitles, titlesOf } from "@/lib/titles/queries";
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

  const owned = titlesOf(id);
  const heldTitles = owned
    .filter((t) => t.revokedAt === null)
    .map((t) => ({ userTitleId: t.userTitleId, name: t.name, icon: t.icon }));

  // 剩余名额要在下拉里就标出来 —— 稀有称号发出去收不回，
  // 不能等点完了才说「名额已满」
  const ownedKeys = new Set(owned.filter((t) => t.revokedAt === null).map((t) => t.key));
  const grantableTitles = listTitles()
    .filter((t) => !ownedKeys.has(t.key))
    .map((t) => ({
      key: t.key,
      name: t.name,
      icon: t.icon,
      remaining: t.limitCount === null ? null : Math.max(0, t.limitCount - holderCount(t.id)),
    }));

  return (
    <>
      <BackLink href="/admin/users">用户管理</BackLink>

      <PageHeader title={detail.name} subtitle={`${STATUS_LABEL[user.status] ?? user.status} · ${user.kind}`} />

      <Section>
        <div className="inset-group flex items-center gap-4 p-4">
          <Avatar wxId={user.wxId ?? user.id} name={detail.name} src={detail.avatarUrl} size={56} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap gap-1.5">
              {detail.roles.map((role) => (
                <AdminTag
                  key={role.id}
                  color={role.color ?? undefined}
                  title={role.scopeId ? `范围：${role.scopeId}` : "全站"}
                >
                  {role.name}
                  {role.scopeId && " ·限定"}
                  {role.expiresAt && " ·临时"}
                </AdminTag>
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
          canGrantTitle={admin.has("user.title.grant")}
          grantableTitles={grantableTitles}
          heldTitles={heldTitles}
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

      {/*
        * 从这里往下全是「一行一条」的窄列表（群、处罚、流水、设备、备注）。
        * 一个人的档案在 63rem 宽的栏里逐块竖着排，要滚四五屏，
        * 而每一行右边都空着半屏 —— 桌面上两列排，一屏就看得完。
        *
        * columns 而不是 grid：这几块高度差得很远（有人零条处罚、
        * 几十笔流水），grid 会按最高的那块对齐行高，
        * 于是矮的那块下面留一大段空。
        */}
      <div className="lg:columns-2 lg:gap-x-6 [&>*]:break-inside-avoid">
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
          {/* 处罚记录被截断绝不能是静默的 —— 惯犯和初犯的差别就在没显示的那几条里 */}
          <TruncationNote
            shown={detail.moderation.length}
            total={detail.moderationTotal}
            noun="条处罚"
          />
        </Section>
      )}

      <Section title="积分流水">
        {detail.ledger.length === 0 ? (
          <Empty title="还没有积分变动" hint="打卡、发帖、群里发言都会在这里留下一笔" />
        ) : (
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
        </Group>
        )}
        <TruncationNote
          shown={Math.min(detail.ledger.length, 10)}
          total={detail.ledgerTotal}
          noun="笔流水"
        />
      </Section>

      <Section title={`登录设备（${detail.sessions.length}）`}>
        {detail.sessions.length === 0 ? (
          <Empty title="没有登录中的设备" hint="他没登录过，或者会话都已经过期" />
        ) : (
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
        </Group>
        )}
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

      </div>

      {/* 权限清单是宽内容（一行 key + 来源），留在通栏里，
          桌面上直接铺成三列 —— 折进两栏会让每个 key 都被截断 */}
      <Section title={`有效权限（${detail.permissions.length}）`}>
        <details className="inset-group">
          <summary className="t-subhead flex min-h-11 cursor-pointer list-none items-center px-4">
            展开查看每一项的来源
          </summary>
          <div className="border-t border-[var(--separator)] px-4 py-3">
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
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
