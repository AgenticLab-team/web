import { AlertTriangle } from "lucide-react";
import type { Metadata } from "next";

import { LevelEditor } from "@/components/admin/LevelEditor";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { listBoardsForAdmin } from "@/lib/admin/boards";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";

import { unlocksByLevel } from "@/lib/points/level-rules";
import { configuredLevels, levelCounts, levelsHealth } from "@/lib/points/levels";

export const metadata: Metadata = { title: "等级门槛" };
export const dynamic = "force-dynamic";

/**
 * 等级门槛与解锁。
 *
 * ─────────────────────────────────────────
 * 门槛以前写死在代码里
 * ─────────────────────────────────────────
 *
 * `LEVELS` 是 rules.ts 里的一个常量数组。而「一切阈值走配置、
 * 后台可改、改动有历史」是这个站写在 defaults.ts 顶上的规则 ——
 * 等级门槛是全站影响面最大的一组数字，偏偏是硬编码的。
 *
 * ─────────────────────────────────────────
 * 「解锁了什么」是反查出来的，不是编的
 * ─────────────────────────────────────────
 *
 * 全站按等级卡的只有一处：版块的 `post_min_level`。
 * 编一个「L5 解锁私信、L7 解锁自定义头像」的列表很容易，
 * 而那些东西没有任何代码在读 —— 那是又一个死开关，
 * 只不过这次穿着说明文档的皮。
 */
export default async function AdminLevelsPage() {
  await requireAdmin("points.rules.manage");

  const levels = configuredLevels();
  const health = levelsHealth();
  const boards = listBoardsForAdmin();

  const unlocks = Object.fromEntries(
    unlocksByLevel(
      boards.map((b) => ({ name: b.name, postMinLevel: b.postMinLevel })),
      levels,
    ).map((u) => [u.level, u.boards]),
  );

  // 升降预览要在浏览器里实时算，所以把累计分那一列直接传过去
  const totals = db.select({ total: users.pointsTotal }).from(users).all().map((r) => r.total);

  return (
    <>
      <BackLink href="/admin/points">积分经济</BackLink>

      <PageHeader title="等级门槛" subtitle={`${levels.length} 级 · ${totals.length} 个账号`} />

      {!health.ok && (
        <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-card)] border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3.5">
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]"
            strokeWidth={2.2}
            aria-hidden
          />
          <div>
            <p className="t-subhead font-medium">库里那份门槛表是坏的，现在用的是代码里的默认值</p>
            <p className="t-caption mt-0.5 text-[var(--ink-secondary)]">{health.error}</p>
          </div>
        </div>
      )}

      <Section>
        <LevelEditor initial={levels} totals={totals} unlocks={unlocks} counts={levelCounts()} />
      </Section>

      <PageNote>
        等级按<b className="font-medium">累计获得</b>算，不是当前余额 ——
        否则花积分兑换东西会掉级，等于惩罚使用积分的人，最后所有人都攒着不花。
        <br />
        改门槛之后所有人的等级会立刻重算。不重算的话，一个人的等级会停在旧门槛下
        算出来的值，而按等级卡的版块立刻按新门槛判 ——
        于是「我明明是 L3」和「这里需要 L3」同时成立却进不去。
        <br />
        改动进配置历史，可以回滚（系统设置 → 变更历史）。
      </PageNote>
    </>
  );
}
