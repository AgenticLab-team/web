import { AlertTriangle, Archive, Database } from "lucide-react";
import type { Metadata } from "next";

import { PruneRunner } from "@/components/admin/PruneRunner";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { TruncationNote } from "@/components/ui/Pagination";
import { Callout, Card, Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import {
  DISK_LEVEL_LABELS,
  diskLevel,
  pendingPruneTask,
  pruneTaskCount,
  recentPruneTasks,
  storageOverview,
} from "@/lib/storage/queries";
import { TIER_LABELS, configWarnings, describeTier, formatBytes } from "@/lib/storage/tiers";

export const metadata: Metadata = { title: "存储与裁剪" };
export const dynamic = "force-dynamic";

/**
 * 存储与裁剪。
 *
 * 页面的顺序就是关心的顺序：
 *   ① 已经裁掉的东西还找得回来吗（最要命，也最容易被漏掉）
 *   ② 空间花在哪了
 *   ③ 再裁一次能省多少
 *
 * 大多数后台会把 ③ 放最前面，因为那是唯一有按钮的一屏。
 * 但 ① 出问题的时候，③ 上的数字全都是在描述一件已经无法挽回的事。
 */
export default async function AdminStoragePage() {
  const admin = await requireAdmin("system.dashboard");
  const s = storageOverview();
  const pending = pendingPruneTask();
  const tasks = recentPruneTasks(8);
  const tasksTotal = pruneTaskCount();
  const warnings = configWarnings(s.config);

  const level = s.disk ? diskLevel(s.disk.pct, s.thresholds) : null;
  const totalMessages = s.tiers.reduce((n, t) => n + t.messages, 0);
  const totalDropped = s.tiers.reduce((n, t) => n + t.dropped, 0);
  const maxTier = Math.max(1, ...s.tiers.map((t) => t.messages));

  return (
    <>
      <PageHeader
        title="存储与裁剪"
        subtitle={
          s.disk
            ? `磁盘 ${s.disk.pct}% · 库 ${formatBytes(s.disk.dbBytes)} · ${totalMessages.toLocaleString()} 条消息`
            : `${totalMessages.toLocaleString()} 条消息`
        }
      />

      {/* ① 找不回来才是真事故 */}
      {s.droppedWithoutArchive && (
        <Callout
          tone="danger"
          icon={<AlertTriangle className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
          title={`有 ${totalDropped.toLocaleString()} 条正文被丢掉了，但归档目录里一个文件都没有`}
        >
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            那些内容现在只可能在上游还有。先确认归档目录（
            <code className="font-mono">ARCHIVE_DIR</code>）有没有被清理脚本或者一次手滑的
            rm 干掉，再决定要不要从上游回捞。
          </p>
        </Callout>
      )}

      {s.drift > 0 && (
        <Callout tone="warning" title={`${s.drift.toLocaleString()} 条消息的层标记和它的实际年龄对不上`}>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            说明裁剪任务没跑过、跑挂了，或者刚改过分层天数。
            这个数字本身没有危害 —— 但它是「任务真的在跑」的唯一凭据。
          </p>
        </Callout>
      )}

      {/* ② 空间花在哪了 */}
      <Section title="分层现状">
        <div className="space-y-2">
          {s.tiers.map((t) => (
            <Card key={t.tier}>
              <p className="t-body flex flex-wrap items-baseline gap-1.5">
                <span className="font-medium">{TIER_LABELS[t.tier]}</span>
                <span className="t-caption2 text-[var(--ink-quaternary)]">
                  {describeTier(t.tier, s.config)}
                </span>
                <span className="tabular t-caption ml-auto text-[var(--ink-tertiary)]">
                  {t.messages.toLocaleString()} 条
                </span>
              </p>

              {/* 条形图用条数比例，一眼看出重心在哪一层 */}
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--fill)]">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(t.messages > 0 ? 2 : 0, (t.messages / maxTier) * 100)}%`,
                    background:
                      t.tier === "hot"
                        ? "var(--accent)"
                        : t.tier === "warm"
                          ? "color-mix(in srgb, var(--accent) 55%, var(--fill))"
                          : "var(--ink-quaternary)",
                  }}
                />
              </div>

              <p className="t-caption2 mt-1.5 text-[var(--ink-quaternary)]">
                正文 {formatBytes(t.contentBytes)} · 可搜 {t.indexed.toLocaleString()} 条
                {t.dropped > 0 && ` · 已丢正文 ${t.dropped.toLocaleString()} 条`}
                {t.oldestTs && ` · 最早 ${new Date(t.oldestTs).toLocaleDateString("zh-CN")}`}
              </p>
            </Card>
          ))}
        </div>

        {s.disk && level && (
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            磁盘 {s.disk.pct}% · {DISK_LEVEL_LABELS[level]}
            （{s.thresholds.warnPct}% 提醒 / {s.thresholds.prunePct}% 该裁 /{" "}
            {s.thresholds.stopCachePct}% 停缓存）· 采样于 {relativeTime(s.disk.takenAt)}
          </p>
        )}
      </Section>

      {s.byTable.length > 0 && (
        <Section title="占地最多的表">
          <div className="inset-group">
            {s.byTable.map((t) => (
              <div key={t.name} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <Database className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]" strokeWidth={2} aria-hidden />
                <span className="t-body min-w-0 flex-1 truncate font-mono text-[13px]">{t.name}</span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                  {formatBytes(t.bytes)}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ③ 再裁一次能省多少 */}
      {admin.has("system.settings") && (
        <Section title="裁剪">
          {warnings.map((w) => (
            <p key={w} className="t-caption mb-2 px-1 leading-relaxed" style={{ color: "var(--warning)" }}>
              {w}
            </p>
          ))}
          <PruneRunner initialTaskId={pending?.id} />
          <p className="t-caption mt-3 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            三步按「删错了能不能救回来」排序：<strong>改层</strong>只写标记；
            <strong>退索引</strong>让消息搜不到但正文还在，随时能重建；
            <strong>丢正文</strong>不可逆，所以必须先归档成文件。
            设计上说「本地是缓存、需要时回源」，但上游自己也只有约两个月历史 ——
            这个前提今天还证明不了，所以默认走归档而不是靠回源。
          </p>
        </Section>
      )}

      <Section title="归档文件">
        {s.archives.length === 0 ? (
          <Empty
            title="还没有归档"
            hint={s.fullSince === null ? "也没有任何正文被丢弃过 —— 两者一致，正常" : "但已经有正文被丢过，见上方警告"}
          />
        ) : (
          <div className="inset-group">
            {s.archives.map((f) => (
              <div key={f.name} className="inset-row flex items-center gap-2 px-4 py-2.5">
                <Archive className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]" strokeWidth={2} aria-hidden />
                <span className="t-body min-w-0 flex-1 truncate font-mono text-[13px]">{f.name}</span>
                <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                  {formatBytes(f.bytes)} · {relativeTime(f.modifiedAt)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          一行一条的 gzip NDJSON，<code className="font-mono">zcat 文件 | grep 关键词</code>
          就能查 —— 出事的时候能用最土的工具打开，比格式漂亮重要。
          {s.fullSince !== null && (
            <>
              {" "}
              早于 {new Date(s.fullSince).toLocaleDateString("zh-CN")} 的非高质量正文
              只在这些文件里。
            </>
          )}
        </p>
      </Section>

      {tasks.length > 0 && (
        <Section title="历史任务">
          <div className="inset-group">
            {tasks.map((t) => {
              const result = t.result as { retiered?: number; unindexed?: number; dropped?: number; skipped?: string } | null;
              return (
                <div key={t.id} className="inset-row px-4 py-2.5">
                  <p className="t-body flex items-center gap-1.5">
                    <span className="t-caption2 text-[var(--ink-quaternary)]">{t.status}</span>
                    <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-secondary)]">
                      {result
                        ? `改层 ${result.retiered ?? 0} · 退索引 ${result.unindexed ?? 0} · 丢正文 ${result.dropped ?? 0}`
                        : t.error || "—"}
                    </span>
                    <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                      {relativeTime(t.createdAt)}
                    </span>
                  </p>
                  {result?.skipped && (
                    <p className="t-caption2 mt-0.5 text-[var(--ink-tertiary)]">{result.skipped}</p>
                  )}
                </div>
              );
            })}
          </div>
          <TruncationNote shown={tasks.length} total={tasksTotal} noun="次任务" />
        </Section>
      )}
    </>
  );
}
