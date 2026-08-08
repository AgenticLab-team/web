import { desc, eq, gte, sql } from "drizzle-orm";
import Link from "next/link";

import { Avatar } from "@/components/Avatar";
import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { dailyStats, groups, messages } from "@/lib/db/schema";
import { peopleByIds } from "@/lib/sync/people";
import { shiftDateKey, todayKey } from "@/lib/time";

export default async function HomePage() {
  const user = await getCurrentUser();

  const stats = db
    .select({
      total: sql<number>`count(*)`,
      quality: sql<number>`sum(${messages.isQuality})`,
      people: sql<number>`count(distinct ${messages.senderWxId})`,
    })
    .from(messages)
    .get();

  const syncedGroups = db
    .select({ convId: groups.convId, name: groups.name })
    .from(groups)
    .where(eq(groups.syncEnabled, true))
    .all();

  const today = todayKey();
  const weekAgo = shiftDateKey(today, -6);
  const board = db
    .select({
      wxId: dailyStats.wxId,
      quality: sql<number>`sum(${dailyStats.qualityMessages})`,
      messages: sql<number>`sum(${dailyStats.messages})`,
    })
    .from(dailyStats)
    .where(gte(dailyStats.date, weekAgo))
    .groupBy(dailyStats.wxId)
    .orderBy(desc(sql`sum(${dailyStats.qualityMessages})`))
    .limit(10)
    .all();

  // 名字与头像统一从 people 表取。
  // 早期这里用 max(sender_name)，但 SQL 的 max() 是字典序比较，
  // "wxid_examplemember01" 会赢过 "jmr"，导致站长在榜上显示成一串 wxid。
  const profiles = peopleByIds(board.map((r) => r.wxId));

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-6">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <h1 className="text-[34px] font-bold leading-tight tracking-[-0.02em]">Agentic Lab</h1>
          <p className="text-[15px] text-[var(--color-ink-secondary)]">
            {syncedGroups.length} 个群 · 群聊之外的家
          </p>
        </div>
        {user ? (
          <span className="rounded-full bg-[var(--color-accent-soft)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--color-accent)]">
            {user.siteNickname ?? user.wxNickname ?? "已登录"}
          </span>
        ) : (
          <Link
            href="/login"
            className="rounded-[var(--radius-control)] bg-[var(--color-accent)] px-4 py-2 text-[15px] font-medium text-[var(--color-accent-ink)] transition active:scale-[0.97]"
          >
            登录
          </Link>
        )}
      </header>

      <section className="mb-8 grid grid-cols-3 gap-3">
        <Stat label="消息" value={stats?.total ?? 0} />
        <Stat label="高质量" value={Number(stats?.quality ?? 0)} />
        <Stat label="发言人" value={stats?.people ?? 0} />
      </section>

      <section className="space-y-3">
        <h2 className="px-1 text-[13px] font-medium uppercase tracking-[0.08em] text-[var(--color-ink-tertiary)]">
          本周贡献榜
        </h2>
        <div className="inset-group">
          {board.map((row, i) => (
            <div key={row.wxId} className="inset-row flex items-center gap-3 px-4 py-2.5">
              <span
                className={`tabular w-5 text-center text-[15px] font-semibold ${
                  i < 3 ? "text-[var(--color-accent)]" : "text-[var(--color-ink-tertiary)]"
                }`}
              >
                {i + 1}
              </span>
              <Avatar
                wxId={row.wxId}
                name={profiles.get(row.wxId)?.displayName ?? row.wxId}
                src={profiles.get(row.wxId)?.avatarUrl}
                size={34}
              />
              <span className="flex-1 truncate text-[17px]">
                {profiles.get(row.wxId)?.displayName ?? row.wxId}
              </span>
              <span className="tabular text-[15px] font-medium">{row.quality}</span>
              <span className="tabular w-14 text-right text-[13px] text-[var(--color-ink-tertiary)]">
                /{row.messages}
              </span>
            </div>
          ))}
          {board.length === 0 && (
            <p className="px-4 py-6 text-center text-[15px] text-[var(--color-ink-secondary)]">
              还没有数据，先跑一次同步
            </p>
          )}
        </div>
        <p className="px-1 text-[13px] leading-relaxed text-[var(--color-ink-tertiary)]">
          按<strong>高质量消息</strong>排名（≥15 字的文本或引用回复）。
          按总条数排会让复读机上榜。
        </p>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-card)] bg-[var(--color-surface)] p-4">
      <p className="tabular text-[26px] font-semibold leading-none tracking-tight">
        {value.toLocaleString("zh-CN")}
      </p>
      <p className="mt-1.5 text-[13px] text-[var(--color-ink-secondary)]">{label}</p>
    </div>
  );
}
