"use client";

import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { AdminActions, AdminButton, AdminRow, adminFieldClass } from "@/components/admin/ui";
import { saveLevels } from "@/lib/points/level-actions";
import { MAX_LEVEL_NAME, checkLevels, previewShift, type LevelDef } from "@/lib/points/level-rules";

/**
 * 等级门槛编辑。
 *
 * ─────────────────────────────────────────
 * 保存之前要看得到后果
 * ─────────────────────────────────────────
 *
 * 把 L2 从 50 提到 500，是在**给所有 L2 的人降级** ——
 * 而降级会连带把他们挡在按等级卡的版块外面。
 *
 * 一个只显示「已保存」的表单不会让人意识到这件事。所以这里
 * 一边改一边算：多少人会升、多少人会降。数字是在浏览器里算的
 * （累计分那一列由服务端传过来），改一个数就立刻更新，
 * 不用先保存再后悔。
 */
export function LevelEditor({
  initial,
  totals,
  unlocks,
  counts,
}: {
  initial: LevelDef[];
  /** 所有人的累计积分 —— 用来算升降人数 */
  totals: number[];
  /** 每一级解锁了哪些版块（从版块的 post_min_level 反查） */
  unlocks: Record<number, string[]>;
  /** 现在每一级各有多少人 */
  counts: Record<number, number>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rows, setRows] = useState<LevelDef[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const verdict = checkLevels(rows);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial);
  const shift = verdict.ok ? previewShift(totals, initial, verdict.levels) : null;

  const update = (index: number, patch: Partial<LevelDef>) => {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    setSaved(false);
  };

  return (
    <div className="space-y-3">
      <div className="inset-group">
        {rows.map((row, i) => (
          <AdminRow key={row.level} className="flex-wrap">
            <span className="tabular t-subhead w-8 shrink-0 font-medium text-[var(--ink-tertiary)]">
              L{row.level}
            </span>

            {/* 两个框换成全站统一的 fill 底 —— 原来是「1px 边框 + canvas 底」，
                和后台其它二十来个输入框不是一套长相 */}
            <input
              value={row.name}
              onChange={(e) => update(i, { name: e.target.value })}
              maxLength={MAX_LEVEL_NAME}
              aria-label={`L${row.level} 的名字`}
              className={`w-24 shrink-0 ${adminFieldClass}`}
            />

            <span className="t-caption shrink-0 text-[var(--ink-tertiary)]">累计满</span>
            <input
              type="number"
              min={0}
              value={row.requires}
              // L1 永远是 0 —— 改它会让刚注册的人算不出等级
              disabled={i === 0}
              onChange={(e) => update(i, { requires: Number(e.target.value) })}
              aria-label={`L${row.level} 需要多少累计积分`}
              title={i === 0 ? "L1 的门槛固定是 0，改了刚注册的人就算不出等级" : undefined}
              className={`tabular w-24 shrink-0 ${adminFieldClass}`}
            />
            <span className="t-caption shrink-0 text-[var(--ink-tertiary)]">分</span>

            <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
              现在 {counts[row.level] ?? 0} 人
            </span>

            {/*
              * 解锁了什么，从版块配置反查。
              *
              * 编一个「L5 解锁私信」的漂亮列表很容易，而那些东西没有
              * 任何代码在读 —— 那是又一个死开关，只不过穿着说明文档的皮。
              */}
            {(unlocks[row.level]?.length ?? 0) > 0 && (
              <span className="t-caption2 min-w-0 flex-1 truncate text-[var(--ink-tertiary)]">
                解锁：{unlocks[row.level].join("、")}
              </span>
            )}
          </AdminRow>
        ))}
      </div>

      {!verdict.ok && (
        <p role="alert" className="t-caption flex items-start gap-1.5 text-[var(--danger)]">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
          {verdict.error}
        </p>
      )}

      {/*
        * 升降预览。改一个数就更新，不用先保存再后悔。
        */}
      {dirty && shift && (
        <div className="rounded-[var(--radius-control)] bg-[var(--fill)] p-3">
          <p className="t-subhead font-medium">保存之后</p>
          <div className="mt-1.5 flex flex-wrap gap-3">
            <span className="t-caption inline-flex items-center gap-1 text-[var(--success)]">
              <TrendingUp className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              {shift.promoted} 人升级
            </span>
            <span
              className="t-caption inline-flex items-center gap-1"
              style={{ color: shift.demoted > 0 ? "var(--danger)" : "var(--ink-tertiary)" }}
            >
              <TrendingDown className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
              {shift.demoted} 人降级
            </span>
            <span className="t-caption text-[var(--ink-tertiary)]">{shift.unchanged} 人不变</span>
          </div>
          {shift.demoted > 0 && (
            <p className="t-caption2 mt-1.5 leading-relaxed text-[var(--ink-secondary)]">
              降级的人会被挡在按等级卡的版块外面，而他们收不到任何通知 ——
              确认这是你想要的。
            </p>
          )}
        </div>
      )}

      <AdminActions>
        <AdminButton
          tone="primary"
          disabled={pending || !dirty || !verdict.ok}
          title={dirty ? undefined : "门槛还没改动"}
          onClick={() =>
            startTransition(async () => {
              const r = await saveLevels(rows);
              if (!r.ok) setError(r.error ?? "没成功");
              else {
                setError(null);
                setSaved(true);
                router.refresh();
              }
            })
          }
        >
          {/* 按钮上写清楚会波及多少人 —— 这一下会把所有人的等级重算一遍 */}
          {dirty && shift && shift.demoted > 0
            ? `保存门槛（${shift.demoted} 人会降级）`
            : "保存门槛"}
        </AdminButton>
        {dirty && (
          <AdminButton
            tone="quiet"
            onClick={() => {
              setRows(initial);
              setSaved(false);
            }}
          >
            改回去
          </AdminButton>
        )}
        {saved && (
          <span role="status" className="t-caption text-[var(--success)]">
            存好了，等级已经重算
          </span>
        )}
      </AdminActions>

      {error && (
        <p role="alert" className="t-caption text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}
