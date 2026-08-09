import { CircleAlert, Lock, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";

import { ModuleToggle } from "@/components/admin/ModuleToggle";
import { relativeTime } from "@/components/forum/PostList";
import { PageHeader } from "@/components/shell/PageHeader";
import { Callout, Card, PageNote, Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { moduleHealth } from "@/lib/modules/health";
import { STATUS_LABELS, dependentsOf, moduleByKey, statusTone } from "@/lib/modules/registry";

export const metadata: Metadata = { title: "模块与健康度" };
export const dynamic = "force-dynamic";

/**
 * 模块与健康度。
 *
 * ─────────────────────────────────────────
 * 两个反复出现过的错误，这一页专门在防
 * ─────────────────────────────────────────
 *
 * **① 开关不接线。** 这个项目里出现过两次 ——
 * `notification_prefs` 建好了表没人读，「立即同步」排了队没人消费。
 * 所以每个模块都声明它在哪几个文件里被判定，
 * 而 `tests/modules.test.ts` 读源码核对那几个文件真的读了它。
 *
 * **② 「开着但不工作」被显示成「运行中」。**
 * 一个开关开着、依赖却被关掉的模块，如果显示成绿色，
 * 管理员会以为它在跑。这一页把这种状态单列成一个颜色和一句话。
 *
 * 另外每个模块都给出**最近一次真的干了活的时间** ——
 * 「运行中」这三个字本身不说明任何事情：一个开着但两天没动静的模块，
 * 和一个正常的模块，在开关上长得一模一样。
 */
export default async function AdminModulesPage() {
  const admin = await requireAdmin("module.read");
  const modules = moduleHealth();
  const canToggle = admin.has("module.toggle");

  const off = modules.filter((m) => m.status === "off");
  const blocked = modules.filter((m) => m.status === "blocked");
  const warned = modules.filter((m) => m.warning);

  return (
    <>
      <PageHeader
        title="模块与健康度"
        subtitle={
          blocked.length > 0
            ? `${blocked.length} 个模块开着但没在工作`
            : off.length > 0
              ? `${off.length} 个模块已关闭`
              : `${modules.length} 个模块全部运行中`
        }
      />

      {/* 「开着但不工作」排最前面 —— 它是这一页上最容易骗人的状态 */}
      {blocked.length > 0 && (
        <Callout
          tone="warning"
          icon={<TriangleAlert className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
          title={`${blocked.map((m) => m.name).join("、")}的开关是开着的，但实际上没有在工作`}
        >
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            它们依赖的
            {[...new Set(blocked.flatMap((m) => m.blockedBy))]
              .map((k) => moduleByKey(k)?.name ?? k)
              .join("、")}
            被关掉了。<strong>「开着但不工作」比「关着」更容易骗人</strong> ——
            开关上看不出区别。
          </p>
        </Callout>
      )}

      {warned.length > 0 && blocked.length === 0 && (
        <Callout
          icon={<CircleAlert className="h-4 w-4 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />}
          title={`${warned.length} 个模块有话要说`}
        >
          <ul className="mt-1.5 space-y-1">
            {warned.map((m) => (
              <li key={m.key} className="t-caption leading-relaxed text-[var(--ink-secondary)]">
                <span className="text-[var(--ink)]">{m.name}</span>：{m.warning}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      <Section>
        <div className="space-y-2">
          {modules.map((m) => {
            const tone = statusTone(m.status);
            const color =
              tone === "success"
                ? "var(--success)"
                : tone === "warning"
                  ? "var(--warning)"
                  : "var(--ink-quaternary)";
            const spec = moduleByKey(m.key)!;

            return (
              <Card as="article" key={m.key} style={{ borderLeft: `3px solid ${color}` }}>
                <div className="flex flex-wrap items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="t-body flex flex-wrap items-center gap-1.5 font-medium">
                      {m.name}
                      <span className="t-caption2" style={{ color }}>
                        {STATUS_LABELS[m.status]}
                      </span>
                      {m.status === "locked" && (
                        <Lock
                          className="h-3 w-3 text-[var(--ink-quaternary)]"
                          strokeWidth={2.2}
                          aria-hidden
                        />
                      )}
                    </p>

                    <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
                      {m.summary}
                    </p>

                    {/* 「运行中」本身不说明任何事 —— 给出最近一次真的干活的时间 */}
                    <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                      {m.fact}
                      {m.lastActiveAt
                        ? ` · 最近一次动静 ${relativeTime(m.lastActiveAt)}`
                        : " · 还没有过任何动静"}
                    </p>

                    {m.reason && m.status !== "on" && (
                      <p
                        className="t-caption mt-1.5 leading-relaxed"
                        style={{ color: m.status === "blocked" ? "var(--warning)" : "var(--ink-secondary)" }}
                      >
                        {m.reason}
                      </p>
                    )}

                    {m.warning && m.status === "on" && (
                      <p className="t-caption mt-1.5 leading-relaxed" style={{ color: "var(--warning)" }}>
                        {m.warning}
                      </p>
                    )}

                    {spec.dependsOn && spec.dependsOn.length > 0 && (
                      <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
                        依赖 {spec.dependsOn.map((k) => moduleByKey(k)?.name ?? k).join("、")}
                      </p>
                    )}
                  </div>

                  {canToggle ? (
                    <ModuleToggle
                      moduleKey={m.key}
                      name={m.name}
                      enabled={m.enabled}
                      whenOff={m.whenOff}
                      affects={dependentsOf(m.key).map((d) => d.name)}
                      locked={m.status === "locked"}
                      lockReason={m.status === "locked" ? m.reason : undefined}
                    />
                  ) : (
                    <span className="t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                      只读
                    </span>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </Section>

      <PageNote>
        关掉一个模块只停<strong>写入侧</strong>，不藏已有数据 ——
        关掉资源库之后新消息不再抽链接，但已经收录的照常可见。
        「关一个模块」是先别再长了，不是把过去删掉；后者要走裁剪或删除，
        那是另一件事，而且不可逆。每次开关都会记进
        <strong>系统设置变更历史</strong>与审计日志，可以回滚。
      </PageNote>
    </>
  );
}
