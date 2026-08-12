import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/shell/PageHeader";
import { AdminMeter, adminButtonClass } from "@/components/admin/ui";
import { Callout, Card, PageNote, Section, StatTile } from "@/components/ui/primitives";
import { dailyCapPressure, economySnapshot, topEarners } from "@/lib/admin/economy";
import { requireAdmin } from "@/lib/admin/guard";
import { resolveDisplayName } from "@/lib/users/display-name";
import { todayKey } from "@/lib/time";

export const metadata: Metadata = { title: "积分经济" };
export const dynamic = "force-dynamic";

/**
 * 积分经济看板。
 *
 * 通胀是测出来的，不是感觉出来的。等到能凭感觉察觉的时候，
 * 存量已经大到收不回来了 —— 积分只能发不能收，
 * 唯一能调的是**未来的发行速度**。所以这一页的重点不是好看，
 * 是让「该收紧了」这件事**提前几周**被看见。
 *
 * 页面顶部是结论一句话，不是一堆数字。管理员看不懂的指标等于没有。
 */

const VERDICT_TONE: Record<string, "success" | "warning" | "danger"> = {
  healthy: "success",
  watch: "warning",
  inflating: "danger",
  deflating: "warning",
};

const VERDICT_LABEL: Record<string, string> = {
  healthy: "健康",
  watch: "留意",
  inflating: "发行过快",
  deflating: "回收过快",
};

export default async function AdminPointsPage() {
  await requireAdmin("points.rules.manage");

  const snap = economySnapshot(30);
  const earners = topEarners(30, 8);
  const pressure = dailyCapPressure(todayKey());

  const tone = VERDICT_TONE[snap.inflation.verdict];
  const maxDaily = Math.max(1, ...snap.daily.map((d) => Math.max(d.minted, d.burned)));

  return (
    <>
      <PageHeader
        title="积分经济"
        subtitle={`近 ${snap.windowDays} 天`}
        action={
          /* 这一页是体检，流水页才是逐笔查账 —— 两件事，给一条明路过去 */
          <Link href="/admin/points/ledger" className={adminButtonClass({ tone: "neutral" })}>
            看流水
          </Link>
        }
      />

      {/* 结论先行。数字在下面，先说该不该做点什么 */}
      <Callout tone={tone} title={VERDICT_LABEL[snap.inflation.verdict] ?? snap.inflation.verdict}>
        <p className="t-body mt-1 leading-relaxed">{snap.inflation.message}</p>
      </Callout>

      {/* 这一页原来自成一套排版（卡内大写小标题 + 迷你数字格），
          和其它后台页放在一起就是「割裂感」本人 —— 收敛到 Section/StatTile */}
      <Section>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="流通总量" value={snap.circulating} hint={`${snap.holders} 人持有`} />
          <StatTile
            label="近 30 天发行"
            value={snap.inflation.minted}
            hint={`净增 ${snap.inflation.net >= 0 ? "+" : ""}${snap.inflation.net}`}
          />
          <StatTile
            label="近 30 天回收"
            value={snap.inflation.burned}
            hint={`覆盖 ${Math.round(snap.inflation.sinkCoverage * 100)}%`}
          />
          <StatTile label="累计发行" value={snap.lifetimeMinted} hint="只增不减，用于等级" />
        </div>
      </Section>

      <Section title="每日发行上限的松紧">
        <Card>
          <p className="t-subhead">
            今天有 <strong className="tabular">{pressure.atCap}</strong> 人撞到上限
            {pressure.active > 0 && `（当日有收入的共 ${pressure.active} 人）`}，
            上限是 <span className="tabular">{pressure.cap}</span> 分。
          </p>
          <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
            {pressure.active === 0
              ? "今天还没有人拿到积分。"
              : pressure.atCap / pressure.active > 0.4
                ? "撞顶的人偏多 —— 上限压得太死，会让认真参与的人觉得白干。"
                : pressure.atCap === 0
                  ? "没有人撞顶 —— 上限目前形同虚设，它挡不住任何刷分行为。"
                  : "少量撞顶属于正常，说明上限起作用了但没有伤及多数人。"}
          </p>
        </Card>
      </Section>

      <Section title="分配集中度">
        <Card>
          <div className="flex items-baseline gap-4">
            <span className="tabular t-title3">{Math.round(snap.distribution.topShare * 100)}%</span>
            <span className="t-caption text-[var(--ink-tertiary)]">
              前 10% 的人握有的比例
            </span>
          </div>
          <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
            中位数 {Math.round(snap.distribution.median)} · 均值{" "}
            {Math.round(snap.distribution.mean)}。
            两者差得越远，说明积分越集中在少数人手里 ——
            那时候榜单和商店对多数人就没有意义了。
          </p>
        </Card>
      </Section>

      <Section title="积分流向">
        <div className="grid gap-2.5 md:grid-cols-2">
          <Card>
            <p className="t-group-label mb-2.5">从哪来</p>
            <Bars rows={snap.sources} tone="var(--accent)" empty="这段时间没有发行" />
          </Card>
          <Card>
            <p className="t-group-label mb-2.5">到哪去</p>
            <Bars rows={snap.sinks} tone="var(--warning)" empty="这段时间没有任何回收" />
            {snap.sinks.length === 0 && (
              <p className="t-caption mt-2 leading-relaxed text-[var(--ink-tertiary)]">
                一个回收口都没有的话，积分只会越攒越多，
                最终所有价格都要重定 —— 而重定价格等于宣布之前攒的都不算数。
              </p>
            )}
          </Card>
        </div>
      </Section>

      <Section title={`每日发行与回收（近 ${snap.windowDays} 天）`}>
        <Card>
          {/*
            * 卡片里面用的是「一行灰字」，不是 Empty。
            *
            * Empty 自带 inset-group（也就是 surface 底）—— 套在同样是
            * surface 的 Card 里，出来的是白底叠白底加一圈内边距，
            * 看着像一个渲染坏掉的方块。这一页上原来有三处这种嵌套。
            */}
          {snap.daily.length === 0 ? (
            <p className="t-subhead py-6 text-center text-[var(--ink-tertiary)]">
              这段时间一笔流水都没有
            </p>
          ) : (
            <div className="flex h-24 items-end gap-0.5" role="img" aria-label="每日发行与回收趋势">
              {snap.daily.map((d) => (
                <div key={d.date} className="flex flex-1 flex-col justify-end gap-0.5" title={`${d.date} 发行 ${d.minted} / 回收 ${d.burned}`}>
                  <div
                    className="rounded-t-[2px] bg-[var(--accent)]"
                    style={{ height: `${(d.minted / maxDaily) * 70}px` }}
                  />
                  <div
                    className="rounded-b-[2px] bg-[var(--warning)] opacity-70"
                    style={{ height: `${(d.burned / maxDaily) * 70}px` }}
                  />
                </div>
              ))}
            </div>
          )}
        </Card>
      </Section>

      <Section title="发行最多的人">
        <Card>
          {earners.length === 0 ? (
            <p className="t-subhead py-6 text-center text-[var(--ink-tertiary)]">
              近 30 天还没有人拿到过积分
            </p>
          ) : (
            <ul className="space-y-1.5">
              {earners.map((e) => (
                <li key={e.userId} className="flex items-baseline gap-2">
                  <Link href={`/admin/users/${e.userId}`} className="t-subhead min-w-0 flex-1 truncate">
                    {resolveDisplayName([e.name, e.wxName], { wxId: e.wxId, fallback: e.userId })}
                  </Link>
                  <span className="tabular t-subhead text-[var(--ink-secondary)]">{e.earned}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="t-caption mt-2 leading-relaxed text-[var(--ink-tertiary)]">
            排在最前的人不一定有问题 —— 他们可能只是最活跃的。
            但<strong>异常刷分一定会先出现在这里</strong>，所以定期扫一眼比事后追查便宜得多。
          </p>
        </Card>
      </Section>

      <PageNote>
        所有发行参数（每日上限、互动权重与折算、连胜上限、手续费比例）都在系统设置里，改错了可以回滚。
        调参前先看这一页 —— 凭感觉调的结果通常是「先发太多，再一刀砍死」。
      </PageNote>
    </>
  );
}

function Bars({
  rows,
  tone,
  empty,
}: {
  rows: { key: string; label: string; amount: number; share: number }[];
  tone: string;
  empty: string;
}) {
  // 同样在 Card 里，所以不能用自带 surface 底的 Empty
  if (rows.length === 0)
    return <p className="t-subhead py-4 text-center text-[var(--ink-tertiary)]">{empty}</p>;

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.key}>
          <AdminMeter
            label={row.label}
            value={row.share}
            hint={row.amount.toLocaleString("zh-CN")}
            tone={tone}
          />
        </li>
      ))}
    </ul>
  );
}
