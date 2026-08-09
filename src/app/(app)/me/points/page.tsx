import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, Empty, Group, PageNote, Section, StatTile } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth/session";
import { recentCheckins } from "@/lib/points/checkin";
import { auditBalance, listLedger } from "@/lib/points/ledger";
import { configuredLevels } from "@/lib/points/levels";
import { levelProgress } from "@/lib/points/rules";

export const metadata: Metadata = { title: "积分" };
export const dynamic = "force-dynamic";

export default async function PointsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const ledger = listLedger(user.id, 60);
  const checkins = recentCheckins(user.id, 90);
  // 门槛走配置 —— 「我的等级」和实际判定必须用同一份表
  const progress = levelProgress(user.pointsTotal, configuredLevels());
  const audit = auditBalance(user.id);

  return (
    <>
      <BackLink href="/me">我的</BackLink>

      <PageHeader title="积分" subtitle={`${progress.current.name} · L${progress.current.level}`} />

      <Section>
        <div className="grid grid-cols-3 gap-2.5">
          <StatTile label="当前余额" value={user.points} accent />
          <StatTile label="累计获得" value={user.pointsTotal} hint="用于算等级" />
          <StatTile label="连胜" value={user.streakCurrent} hint={`最长 ${user.streakBest} 天`} />
        </div>
      </Section>

      {progress.next && (
        <Section title="等级进度">
          <div className="inset-group p-4">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="t-subhead">
                L{progress.current.level} {progress.current.name}
              </span>
              <span className="t-caption text-[var(--ink-tertiary)]">
                L{progress.next.level} {progress.next.name}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--fill)]">
              <div
                className="progress-fill h-full rounded-full bg-[var(--accent)]"
                style={{ transform: `translateX(${progress.ratio * 100 - 100}%)` }}
              />
            </div>
            <p className="tabular t-caption mt-2 text-[var(--ink-tertiary)]">
              还差 {progress.remaining} 分升级 ·
              等级按<strong className="font-medium">累计获得</strong>算，花掉积分不会掉级
            </p>
          </div>
        </Section>
      )}

      <Section title={`打卡记录（近 90 天 ${checkins.length} 次）`}>
        {checkins.length === 0 ? (
          <Empty title="还没有打卡记录" hint="在群里发几条有内容的话就能打卡了" />
        ) : (
          <Group>
            {checkins.slice(0, 10).map((record) => (
              <div key={record.id} className="inset-row flex items-center gap-3 px-4 py-3">
                <span className="tabular t-subhead w-[5.5rem] shrink-0 text-[var(--ink-secondary)]">
                  {record.date}
                </span>
                <span className="t-caption min-w-0 flex-1 text-[var(--ink-tertiary)]">
                  基础 {record.basePoints}
                  {record.qualityBonus > 0 && ` · 高质量 +${record.qualityBonus}`}
                  {record.streakBonus > 0 && ` · 连胜 +${record.streakBonus}`}
                  {record.qualityRaw !== record.qualityCounted && (
                    <span title="同分钟折叠与近似内容去重后的计数">
                      {" "}
                      · 计 {record.qualityCounted}/{record.qualityRaw} 条
                    </span>
                  )}
                </span>
                <span className="tabular t-subhead shrink-0 font-medium text-[var(--accent)]">
                  +{record.pointsAwarded}
                </span>
              </div>
            ))}
          </Group>
        )}
      </Section>

      <Section title="积分流水">
        {ledger.length === 0 ? (
          <Empty title="还没有积分变动" />
        ) : (
          <Group>
            {ledger.map((entry) => (
              <div key={entry.id} className="inset-row flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="t-subhead truncate leading-tight">{entry.reason}</p>
                  <p className="tabular t-caption text-[var(--ink-tertiary)]">
                    {relativeTime(entry.createdAt)} · 余额 {entry.balanceAfter}
                  </p>
                </div>
                <span
                  className={`tabular t-subhead shrink-0 font-medium ${
                    entry.delta > 0 ? "text-[var(--success)]" : "text-[var(--ink-secondary)]"
                  }`}
                >
                  {entry.delta > 0 ? "+" : ""}
                  {entry.delta}
                </span>
              </div>
            ))}
          </Group>
        )}
      </Section>

      {!audit.consistent && (
        <p className="t-caption px-1 text-[var(--danger)]">
          余额与流水对不上（缓存 {audit.cached} / 流水 {audit.computed}），请联系管理员
        </p>
      )}

      <PageNote>
        积分只由服务端按规则发放。同一分钟内的多条发言折叠成一条，
        重复内容也只算一次 —— 刷屏拿不到分。
      </PageNote>
    </>
  );
}
