import { Archive, CloudOff, HardDrive, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { TruncationNote } from "@/components/ui/Pagination";
import { Callout, Card, Empty, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { offsiteSummary } from "@/lib/backup/offsite";
import { DRILL_AFTER_MS, STATUS_LABELS, statusTone } from "@/lib/backup/rules";
import { formatBytes } from "@/lib/storage/tiers";

export const metadata: Metadata = { title: "备份与异地副本" };
export const dynamic = "force-dynamic";

/**
 * 备份与异地副本。
 *
 * 这一页只回答一个问题：**明天早上服务器没了，站还能不能回来。**
 *
 * 所以它刻意不做成一堆绿色的对勾。没配置异地备份是红的、
 * 传上去但没读回来对过哈希是黄的 —— 因为「备份任务一直在成功」
 * 正是备份最常见的失败方式：日志里全是 ✓，直到需要恢复的那天
 * 才发现文件是空的、或者根本没上传。
 */
export default async function AdminBackupPage() {
  await requireAdmin("system.dashboard");

  const s = offsiteSummary();
  const tone = statusTone(s.status) as "success" | "warning" | "danger";

  const localBytes = s.localFiles.reduce((n, f) => n + f.bytes, 0);
  const backups = s.localFiles.filter((f) => f.name.startsWith("backups/"));
  const archives = s.localFiles.filter((f) => f.name.startsWith("archive/"));

  const lastDrill = s.recent.find((r) => r.kind === "drill" && r.status === "success");

  return (
    <>
      <PageHeader
        title="备份与异地副本"
        subtitle={`${s.localFiles.length} 个本地文件 · ${formatBytes(localBytes)}`}
      />

      {/* 结论摆最前面：明天服务器没了，站还回不回得来 */}
      <Callout
        tone={tone}
        title={STATUS_LABELS[s.status]}
        icon={
          tone === "success" ? (
            <ShieldCheck className="h-5 w-5" strokeWidth={2} aria-hidden />
          ) : s.status === "unconfigured" ? (
            <CloudOff className="h-5 w-5" strokeWidth={2} aria-hidden />
          ) : (
            <TriangleAlert className="h-5 w-5" strokeWidth={2} aria-hidden />
          )
        }
      >
        <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">{s.detail}</p>

        {s.missingKeys.length > 0 && (
            <div className="mt-2.5">
              <p className="t-caption2 text-[var(--ink-tertiary)]">
                在服务器的 <code className="font-mono">.env.local</code> 里补上这几项，
                然后 <code className="font-mono">npm run offsite</code>：
              </p>
              <ul className="mt-1 space-y-0.5">
                {s.missingKeys.map((k) => (
                  <li key={k} className="t-caption2 font-mono text-[var(--ink-secondary)]">
                    {k}
                  </li>
                ))}
              </ul>
              <p className="t-caption2 mt-1.5 leading-relaxed text-[var(--ink-quaternary)]">
                任何 S3 协议的对象存储都行 —— Cloudflare R2、Backblaze B2、MinIO。
                每天几 MB，基本落在免费额度里。
              </p>
            </div>
        )}
      </Callout>

      {s.drillDue && (
        <Callout tone="warning" title="该做一次恢复演练了">
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            <strong>没演练过的备份只是一堆字节。</strong>
            真要用的时候才发现打不开，那时候原库已经没了 ——
            演练会从<strong>远端</strong>下载最新那份、解压、打开、数行，
            是唯一能提前发现这件事的办法。
          </p>
          <p className="t-caption2 mt-2 font-mono text-[var(--ink-tertiary)]">
            npm run offsite -- --drill
          </p>
        </Callout>
      )}

      <Section title="链路">
        <div className="space-y-2">
          <Step
            icon={<HardDrive className="h-4 w-4" strokeWidth={2} aria-hidden />}
            title="本机快照"
            ok
            detail={`${backups.length} 份数据库备份 · ${formatBytes(backups.reduce((n, f) => n + f.bytes, 0))}`}
            note="在线快照，不会拿到写到一半的数据"
          />
          <Step
            icon={<Archive className="h-4 w-4" strokeWidth={2} aria-hidden />}
            title="归档文件"
            ok={archives.length > 0 || true}
            detail={
              archives.length > 0
                ? `${archives.length} 个月度包 · ${formatBytes(archives.reduce((n, f) => n + f.bytes, 0))}`
                : "还没有归档（也就还没裁剪过冷层）"
            }
            note="冷层正文的唯一副本 —— 比数据库备份更不能只放在一块磁盘上"
          />
          <Step
            icon={<CloudOff className="h-4 w-4" strokeWidth={2} aria-hidden />}
            title="异地副本"
            ok={s.status === "ok"}
            detail={s.detail}
            note="传完立刻读回来核对 —— 「上传成功」只证明请求没报错，不证明存对了"
          />
          <Step
            icon={<ShieldCheck className="h-4 w-4" strokeWidth={2} aria-hidden />}
            title="恢复演练"
            ok={!!lastDrill && !s.drillDue}
            detail={
              lastDrill
                ? `上次 ${relativeTime(lastDrill.finishedAt ?? lastDrill.createdAt)}`
                : "从没演练过"
            }
            note={`每 ${Math.round(DRILL_AFTER_MS / 86_400_000)} 天一次：真的下载、解压、打开、数行`}
          />
        </div>
      </Section>

      <Section title="本地文件">
        {s.localFiles.length === 0 ? (
          <Empty title="一个备份文件都没有" hint="定时任务可能没在跑 —— 查 agenticlab-backup.timer" />
        ) : (
          <div className="inset-group">
            {s.localFiles
              .slice()
              .sort((a, b) => b.modifiedAt - a.modifiedAt)
              .map((f) => (
                <div key={f.name} className="inset-row flex items-center gap-2 px-4 py-2.5">
                  <span className="t-body min-w-0 flex-1 truncate font-mono text-[13px]">
                    {f.name}
                  </span>
                  <span className="tabular t-caption shrink-0 text-[var(--ink-tertiary)]">
                    {formatBytes(f.bytes)} · {relativeTime(f.modifiedAt)}
                  </span>
                </div>
              ))}
          </div>
        )}
      </Section>

      <Section title="最近动作">
        {s.recent.length === 0 ? (
          <Empty title="还没有异地备份记录" hint="配好之后跑一次 npm run offsite" />
        ) : (
          <div className="inset-group">
            {s.recent.map((r) => (
              <div key={r.id} className="inset-row px-4 py-2.5">
                <p className="t-body flex items-center gap-1.5">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background:
                        r.status === "success"
                          ? "var(--success)"
                          : r.status === "skipped"
                            ? "var(--ink-quaternary)"
                            : "var(--danger)",
                    }}
                    aria-hidden
                  />
                  <span className="t-caption2 text-[var(--ink-quaternary)]">{KIND_LABELS[r.kind]}</span>
                  <span className="t-caption min-w-0 flex-1 truncate text-[var(--ink-secondary)]">
                    {r.error ?? `${r.files} 个文件 · ${formatBytes(r.bytes)}`}
                  </span>
                  <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                    {relativeTime(r.createdAt)}
                  </span>
                </p>
              </div>
            ))}
          </div>
        )}
        <TruncationNote shown={s.recent.length} total={s.runsTotal} noun="次动作" />
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          失败的也留着 —— 备份最常见的失败方式是<strong>「一直在成功」</strong>，
          而分辨「没跑」和「跑了但失败」的唯一办法是两种都留痕。
        </p>
      </Section>
    </>
  );
}

const KIND_LABELS: Record<string, string> = {
  upload: "上传",
  verify: "校验",
  drill: "演练",
};

function Step({
  icon,
  title,
  ok,
  detail,
  note,
}: {
  icon: ReactNode;
  title: string;
  ok: boolean;
  detail: string;
  note: string;
}) {
  return (
    <Card className="flex gap-3">
      <span
        className="mt-0.5 shrink-0"
        style={{ color: ok ? "var(--success)" : "var(--ink-quaternary)" }}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="t-body flex flex-wrap items-baseline gap-1.5 font-medium">
          {title}
          <span className="t-caption font-normal text-[var(--ink-tertiary)]">{detail}</span>
        </p>
        <p className="t-caption2 mt-1 leading-relaxed text-[var(--ink-quaternary)]">{note}</p>
      </div>
    </Card>
  );
}
