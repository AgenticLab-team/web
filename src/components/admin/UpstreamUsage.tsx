import { AlertTriangle, Plug, Timer } from "lucide-react";

import { relativeTime } from "@/components/forum/PostList";
import { Card, Empty, Group, Row, Section } from "@/components/ui/primitives";
import type { UsageSummary } from "@/lib/upstream/usage";

/**
 * 上游调用。
 *
 * ─────────────────────────────────────────
 * 健康探测只知道「此刻通不通」
 * ─────────────────────────────────────────
 *
 * 组件那一栏回答的是现在这一秒的状态。而一次十分钟前的 502 潮、
 * 一个只在拉大页时才超时的端点、一个把配额吃光的调用方 ——
 * 探测全都看不见，因为它们**现在**都是好的。
 *
 * 这一块回答的是「最近这一天发生过什么」。
 */

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  const v = (n / total) * 100;
  return v < 1 && v > 0 ? "<1%" : `${Math.round(v)}%`;
}

function ms(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`;
}

/** 调用方标识来自进程入口 —— 翻译成人看得懂的话 */
const CALLER_LABELS: Record<string, string> = {
  web: "网页请求",
  sync: "消息同步",
  health: "健康探测",
  digest: "每周精选",
  backup: "备份",
  prune: "存储裁剪",
  offsite: "异地备份",
  links: "资源库抓取",
  未知: "未知",
};

export function UpstreamUsage({ usage, hours }: { usage: UsageSummary; hours: number }) {
  const healthy = usage.calls > 0 && usage.errors === 0;

  return (
    <Section title={`上游调用（最近 ${hours} 小时）`}>
      {usage.calls === 0 ? (
        <Empty
          title="这段时间没有调用记录"
          hint="要么真的没打过上游，要么同步任务没在跑 —— 后者更值得查一眼"
        />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Card className="px-3 py-2.5">
              <p className="t-caption2 text-[var(--ink-tertiary)]">请求数</p>
              <p className="t-title3 mt-0.5 tabular-nums">{usage.calls.toLocaleString()}</p>
              {/*
                * 说清楚数的是 HTTP 尝试而不是逻辑调用 ——
                * 否则这个数和别处对不上时没人知道为什么
                */}
              <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">含重试</p>
            </Card>

            <Card className="px-3 py-2.5">
              <p className="t-caption2 text-[var(--ink-tertiary)]">失败</p>
              <p
                className={`t-title3 mt-0.5 tabular-nums ${
                  usage.errors === 0 ? "" : "text-[var(--danger)]"
                }`}
              >
                {usage.errors.toLocaleString()}
              </p>
              <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">
                {pct(usage.errors, usage.calls)}
              </p>
            </Card>

            <Card className="px-3 py-2.5">
              <p className="t-caption2 text-[var(--ink-tertiary)]">没连上</p>
              <p
                className={`t-title3 mt-0.5 tabular-nums ${
                  usage.unreachable === 0 ? "" : "text-[var(--warning)]"
                }`}
              >
                {usage.unreachable.toLocaleString()}
              </p>
              <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">隧道 / 超时</p>
            </Card>
          </div>

          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            <strong>「没连上」和「失败」要分开看</strong>：没拿到状态码说明请求根本没到上游 ——
            该去查 frp 隧道；拿到了 4xx / 5xx 说明上游收到了并且拒绝了 —— 该去查上游服务。
            混成一个数字的话，看的人得不到任何指向。
          </p>

          {healthy && (
            <p className="t-caption mt-1 px-1 text-[var(--success)]">
              这段时间一次都没失败过。
            </p>
          )}

          {/* ── 按端点 ── */}
          <h3 className="t-footnote mt-4 mb-1.5 px-1 font-medium text-[var(--ink-secondary)]">
            按端点
          </h3>
          <Group>
            {usage.byEndpoint.slice(0, 10).map((e) => (
              <Row key={e.endpoint}>
                <Plug
                  className="h-3.5 w-3.5 shrink-0 text-[var(--ink-quaternary)]"
                  strokeWidth={2}
                  aria-hidden
                />
                <span className="t-body min-w-0 flex-1 truncate font-mono text-[13px]">
                  {e.endpoint}
                </span>
                {e.errors > 0 && (
                  <span className="t-caption2 shrink-0 rounded-full bg-[var(--danger)]/10 px-1.5 py-0.5 text-[var(--danger)]">
                    {e.errors} 次失败
                  </span>
                )}
                <span className="t-caption shrink-0 tabular-nums text-[var(--ink-tertiary)]">
                  {e.calls.toLocaleString()} 次 · 中位 {ms(e.medianMs)} · P95 {ms(e.p95Ms)}
                </span>
              </Row>
            ))}
          </Group>
          <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
            {/*
              * 为什么给中位数和 P95 而不是平均：
              * 一次 20 秒超时能把平均拉到毫无意义，
              * 而看的人会据此以为「上游很慢」并去优化根本不存在的问题。
              */}
            耗时给的是<strong>中位数</strong>和 <strong>P95</strong>，不是平均 ——
            一次 20 秒超时能把平均拉到毫无意义。路径里的 id 已经归一化成{" "}
            <code className="font-mono">:id</code>：这张表不该顺带攒下一份「谁在什么时候被查了」。
          </p>

          {/* ── 按调用方 ── */}
          {usage.byCaller.length > 1 && (
            <>
              <h3 className="t-footnote mt-4 mb-1.5 px-1 font-medium text-[var(--ink-secondary)]">
                谁打的
              </h3>
              <Group>
                {usage.byCaller.map((c) => (
                  <Row key={c.caller}>
                    <span className="t-body min-w-0 flex-1 truncate">
                      {CALLER_LABELS[c.caller] ?? c.caller}
                    </span>
                    <span className="t-caption shrink-0 tabular-nums text-[var(--ink-tertiary)]">
                      {c.calls.toLocaleString()} 次
                      {c.errors > 0 && ` · ${c.errors} 次失败`}
                    </span>
                  </Row>
                ))}
              </Group>
            </>
          )}

          {/* ── 最近的失败 ── */}
          {usage.recentFailures.length > 0 && (
            <>
              <h3 className="t-footnote mt-4 mb-1.5 px-1 font-medium text-[var(--ink-secondary)]">
                最近的失败
              </h3>
              <div className="inset-group">
                {usage.recentFailures.map((f, i) => (
                  <div key={`${f.at}-${i}`} className="inset-row px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {f.status === null ? (
                        <AlertTriangle
                          className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]"
                          strokeWidth={2}
                          aria-hidden
                        />
                      ) : (
                        <Timer
                          className="h-3.5 w-3.5 shrink-0 text-[var(--danger)]"
                          strokeWidth={2}
                          aria-hidden
                        />
                      )}
                      <span className="t-footnote min-w-0 flex-1 truncate font-mono">
                        {f.endpoint}
                      </span>
                      <span className="t-caption2 shrink-0 tabular-nums text-[var(--ink-tertiary)]">
                        {f.status ?? "没连上"} · {relativeTime(f.at)}
                      </span>
                    </div>
                    {f.error && (
                      <p className="t-caption2 mt-1 line-clamp-2 break-all text-[var(--ink-quaternary)]">
                        {f.error}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Section>
  );
}
