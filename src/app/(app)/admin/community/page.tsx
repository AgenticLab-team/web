import type { Metadata } from "next";
import Link from "next/link";

import { HealthSparkline } from "@/components/admin/HealthSparkline";
import { MirrorAudit } from "@/components/admin/MirrorAudit";
import { PageHeader } from "@/components/shell/PageHeader";
import { AdminMeter } from "@/components/admin/ui";
import { Callout, Card, Empty, PageNote } from "@/components/ui/primitives";
import {
  archiveGaps,
  communityHealth,
  VERDICT_LABELS,
  type GroupHealth,
  type HealthVerdict,
} from "@/lib/admin/community-health";
import { requireAdmin } from "@/lib/admin/guard";

export const metadata: Metadata = { title: "社群健康度" };
export const dynamic = "force-dynamic";

/**
 * 社群健康度看板。
 *
 * ─────────────────────────────────────────
 * 「群与数据源」问数据，这一页问人
 * ─────────────────────────────────────────
 *
 * 那一页问的是**数据有没有进来**。这一页问的是**群还活着吗** ——
 * 同步一切正常、消息一条不落，而群本身正在凉，那一页会一路绿灯。
 *
 * 群主判断「群是不是要凉了」现在全凭感觉，而 12 个群没法凭感觉横向比。
 *
 * ─────────────────────────────────────────
 * 排序即结论
 * ─────────────────────────────────────────
 *
 * 按人数或消息数排的话，最大的群永远在最上面 —— 而一个 400 人的
 * 健康群不需要每天看它，一个正在退潮的 40 人小群需要。
 * 所以**最需要干预的排在最前面**，健康的沉到底下。
 */

const TONES: Record<HealthVerdict, string> = {
  fading: "var(--danger)",
  idle: "var(--ink-tertiary)",
  concentrated: "var(--warning)",
  quiet: "var(--ink-secondary)",
  healthy: "var(--success)",
};

export default async function CommunityHealthPage() {
  /*
   * 和群页同一对权限点。
   *
   * 这一页全是只读的规模与分布数字 —— 正是 `group.stats.read`
   * 该看的东西。只认 `group.manage` 的话，那个只读权限点又一次
   * 变成一个授出去也没用的勾。
   */
  await requireAdmin(["group.manage", "group.stats.read"]);

  const groups = communityHealth();
  const attention = groups.filter((g) => g.verdict === "fading" || g.verdict === "idle");
  const gaps = archiveGaps();

  if (groups.length === 0) {
    return (
      <>
        <PageHeader title="社群健康度" subtitle="群还活着吗 —— 和「数据有没有进来」是两件事" />
        <Empty title="还没有接入的群" hint="在「群与数据源」里接入之后，这里会开始出现每个群的节奏与分布" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="社群健康度"
        subtitle={`${groups.length} 个群 · 最需要看的排在最前`}
      />

      {/*
        归档的洞排在最前面。

        它不是「某个群的问题」，而是**这一页上所有趋势的可信度问题** ——
        缺的那几天会被当成零活跃，把势头算歪。放在下面的话，
        人会先看完一堆数字，最后才知道那些数字不能全信。

        它同时解释了势头那一格为什么是空的。
      */}
      {gaps.length > 0 && (
        <Callout tone="warning" title="归档里有缺口">
          <ul className="mt-1.5 space-y-0.5">
            {gaps.map((gap) => (
              <li key={gap.from} className="t-caption text-[var(--ink-secondary)]">
                · {gap.from} 到 {gap.to}，{gap.days} 天没有任何一个群的记录
              </li>
            ))}
          </ul>
          <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
            12 个群同时安静这么久不太可能。缺口有两种来源，要做的事完全相反：
            <span className="text-[var(--ink-secondary)]">同步漏了</span>能补，
            <span className="text-[var(--ink-secondary)]">上游本来就没有</span>补不了。
            下面「和上游对账」按一下就能分清。
            另外，按天回看翻到那几天会是空的，而页面只会说「这天没有消息」——
            和真的没人说话长得一模一样；趋势与势头也会因此偏低，
            所以基线落在缺口上时这一页不给结论。
          </p>
        </Callout>
      )}

      {/* 结论先行 —— 没有需要干预的就一句话带过，不制造警报墙 */}
      {attention.length > 0 && (
        <Callout tone="danger" title={`${attention.length} 个群需要看一眼`}>
          <ul className="mt-1.5 space-y-0.5">
            {attention.map((g) => (
              <li key={g.convId} className="t-caption text-[var(--ink-secondary)]">
                · {g.name}：{g.reasons[0]}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {/*
        对账紧跟在缺口提示后面。

        它是那条提示唯一的下一步 —— 隔着十二张卡片放在页尾的话，
        看到缺口的人不会滚到那里，只会记住「有个缺口」然后什么也不做。
      */}
      <Card className="mb-4">
        <MirrorAudit />
      </Card>

      <div className="space-y-3">
        {groups.map((g) => (
          <GroupCard key={g.convId} g={g} />
        ))}
      </div>

      <PageNote>
        {/*
          少两块而不说的话，看的人会以为这就是全部 ——
          而「留存率」恰恰是群主最想要的那个数。
          说清楚它为什么不在，比悄悄不做要紧。
        */}
        <span className="text-[var(--ink-secondary)]">两个指标今天做不了，所以没有摆在上面。</span>{" "}
        「新人 7/30 天留存」——「入群时间」其实是第一次同步到这个人的时间，
        2,037 个成员里 2,033 个挤在接入那一天，拿它算留存算出来的是别的东西；
        「话题分布与漂移」—— 站里没有主题抽取。
        一个写着「留存率 87%」而其实是别的东西的仪表，比没有仪表糟得多。
      </PageNote>
    </>
  );
}

function GroupCard({ g }: { g: GroupHealth }) {
  const tone = TONES[g.verdict];

  return (
    <Card>
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="t-subhead truncate font-medium">{g.name}</h2>
          <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">
            {g.members} 人 · {g.everSpoke} 人说过话
          </p>
        </div>
        <span
          className="t-caption shrink-0 rounded-[var(--radius-pill)] px-2 py-0.5 font-medium"
          style={{ background: `color-mix(in oklab, ${tone} 14%, transparent)`, color: tone }}
        >
          {VERDICT_LABELS[g.verdict]}
        </span>
      </div>

      <HealthSparkline trend={g.trend} tone={tone} />
      <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">
        近 14 天 · 峰值 {Math.max(...g.trend).toLocaleString("zh-CN")} 条/天
      </p>

      {/*
        四个比例用同一种条，而不是四个数字。

        「沉默 57%」这种数字读过就忘，一条填了一半的横条会留下印象 ——
        而这一页的用处正是让人扫一眼就知道哪个群不对劲。
      */}
      <div className="mt-3 space-y-2">
        <AdminMeter
          label="从没说过话"
          value={g.silentRatio}
          hint={`${g.members - g.everSpoke} / ${g.members} 人`}
          /*
           * 沉默比例高**不一定是坏事**：大群天然如此。
           * 所以这一条不染警示色，只有集中度会 ——
           * 每个比例都是红的话，人会停止分辨。
           */
          tone="var(--ink-tertiary)"
        />
        <AdminMeter
          label="前三人发言占比"
          value={g.top3Share}
          hint={`基尼 ${g.gini.toFixed(2)}`}
          tone={g.gini >= 0.6 ? "var(--warning)" : "var(--ink-tertiary)"}
        />
        <AdminMeter
          label="高质量占比"
          value={g.qualityRatio}
          hint="近 30 天"
          tone="var(--ink-tertiary)"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Figure label="近 7 天" value={`${g.messages7.toLocaleString("zh-CN")} 条`} />
        <Figure label="开口" value={`${g.speakers7} 人`} />
        {/*
          势头旁边永远跟着「基于几天」。

          归档是有洞的（线上 7 月中有 15 天没回填），
          「比之前少了 60%」和「基于 4 天」是两条完全不同的信息 ——
          只给前者，等于把一个薄样本包装成了结论。
        */}
        {g.momentum !== null ? (
          <Figure
            label="较前两周"
            value={`${g.momentum >= 0 ? "+" : ""}${Math.round(g.momentum * 100)}%`}
            hint={`基于 ${g.baselineDays} 天`}
            tone={g.momentum <= -0.5 ? "var(--danger)" : g.momentum >= 0.2 ? "var(--success)" : undefined}
          />
        ) : (
          <Figure label="较前两周" value="—" hint="历史记录不够，不下结论" />
        )}
      </div>

      {g.reasons.length > 0 && (
        <p className="t-caption mt-2.5 leading-relaxed text-[var(--ink-secondary)]">
          {/* 只给结论的仪表没人会信 —— 判定后面永远跟着它的依据 */}
          {g.reasons.join("；")}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <Jump href={`/archive?group=${encodeURIComponent(g.convId)}`}>翻这个群</Jump>
        <Jump href="/admin/groups">同步状态</Jump>
      </div>
    </Card>
  );
}

function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: string;
}) {
  return (
    <span className="t-caption text-[var(--ink-tertiary)]">
      {label}{" "}
      <span className="tabular-nums font-medium" style={tone ? { color: tone } : { color: "var(--ink)" }}>
        {value}
      </span>
      {hint && <span className="ml-1">（{hint}）</span>}
    </span>
  );
}

function Jump({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="t-caption inline-flex items-center rounded-[var(--radius-pill)] bg-[var(--fill)] px-2.5 py-1 text-[var(--ink-secondary)] transition-colors hover:bg-[var(--fill-strong)]"
    >
      {children}
    </Link>
  );
}
