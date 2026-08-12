import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminRow } from "@/components/admin/ui";
import { LedgerTable } from "@/components/admin/LedgerTable";
import { PageHeader } from "@/components/shell/PageHeader";
import { BackLink, PageNote, Pill, PillRow, Section, StatTile } from "@/components/ui/primitives";
import { and, desc, eq } from "drizzle-orm";

import { RecountPanel } from "@/components/admin/RecountPanel";
import { requireAdmin } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { adminTasks } from "@/lib/db/schema";
import { listAllLedger, ledgerSummary, riskQueue } from "@/lib/points/admin";
import { RISK_LABEL, emptyRiskMessage } from "@/lib/points/admin-rules";
import { relativeTime } from "@/components/forum/PostList";

export const metadata: Metadata = { title: "积分流水" };
export const dynamic = "force-dynamic";

/**
 * 全站积分流水 + 风控队列。
 *
 * ─────────────────────────────────────────
 * 在这一页之前，流水只能一个人一个人地看
 * ─────────────────────────────────────────
 *
 * `listLedger(userId)` 给的是当事人自己的账单，用户详情页上也有一份。
 * 而「这周分是怎么发出去的」「有没有人在刷」这两个问题，
 * 管理员唯一的办法是自己写 SQL。
 *
 * 对账同理：`auditBalance` 只有单人版，「所有人都对得上吗」
 * 要遍历全站才答得出来，于是从来没人答过。
 *
 * ─────────────────────────────────────────
 * 风控看的是「不该发生」，不是「谁分多」
 * ─────────────────────────────────────────
 *
 * 分多是好事。把排行榜前几名当成风险，只会让人学会忽略这个队列 ——
 * 而一个被忽略的告警队列，比没有这个队列更糟：它让人以为有人在看。
 */
export default async function AdminLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; only?: string }>;
}) {
  await requireAdmin("points.read");

  const { q, only } = await searchParams;
  const manualOnly = only === "manual";
  const revertedOnly = only === "reverted";

  const rows = listAllLedger({ q, manualOnly, revertedOnly, limit: 80 });
  const summary = ledgerSummary(30);
  const risks = riskQueue();

  /*
   * 还挂着的那个重算任务 —— 出过预览但没执行也没取消。
   * 不显示的话，人会以为上次点的预览丢了，然后再点一次。
   */
  const pendingRecount =
    db
      .select({ id: adminTasks.id, preview: adminTasks.preview })
      .from(adminTasks)
      .where(and(eq(adminTasks.kind, "points.recount"), eq(adminTasks.status, "awaiting_confirm")))
      .orderBy(desc(adminTasks.createdAt))
      .get() ?? null;

  const href = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged = { q, only, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const query = params.toString();
    return query ? `/admin/points/ledger?${query}` : "/admin/points/ledger";
  };

  return (
    <>
      <BackLink href="/admin/points">积分经济</BackLink>

      <PageHeader title="积分流水" subtitle={`近 30 天 ${summary.entries} 条`} />

      <Section>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <StatTile label="发出去" value={summary.granted} hint="近 30 天" accent />
          <StatTile label="花掉 / 扣掉" value={summary.spent} />
          <StatTile label="人工调整" value={summary.manual} hint="绕过规则的那些" />
          <StatTile label="冲正" value={summary.reverted} />
        </div>
      </Section>

      {/*
        * 风控排在流水前面。
        *
        * 一个管理员打开这一页，多半是因为「感觉哪里不对」——
        * 那时候他要的是「有没有不对的」，不是一页按时间排的账。
        */}
      <Section title="风控队列">
        {risks.length === 0 ? (
          <div className="inset-group flex items-start gap-2.5 px-4 py-4">
            <ShieldCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]"
              strokeWidth={2.2}
              aria-hidden
            />
            <p className="t-callout text-[var(--ink-secondary)]">{emptyRiskMessage()}</p>
          </div>
        ) : (
          <div className="inset-group">
            {risks.map((risk, i) => (
              <AdminRow key={`${risk.kind}:${risk.userId}:${i}`} align="start" className="flex-col">
                <div className="flex items-start gap-2.5">
                  <AlertTriangle
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: risk.severity >= 90 ? "var(--danger)" : "var(--warning)" }}
                    strokeWidth={2.2}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="t-subhead">
                      <span className="font-medium">{RISK_LABEL[risk.kind]}</span>
                      <span className="text-[var(--ink-tertiary)]"> · </span>
                      <Link href={`/admin/users/${risk.userId}`} className="hover:underline">
                        {risk.name}
                      </Link>
                    </p>
                    <p className="t-caption mt-0.5 text-[var(--ink-tertiary)]">{risk.detail}</p>
                  </div>
                  <span className="tabular t-caption2 shrink-0 text-[var(--ink-quaternary)]">
                    {relativeTime(risk.at)}
                  </span>
                </div>
              </AdminRow>
            ))}
          </div>
        )}
      </Section>

      {/*
        * 重算摆在风控队列**下面**：先看有没有问题，再谈修。
        * 反过来的话，一个只是来看账的人第一眼就是个会改所有人余额的按钮。
        */}
      <Section title="对账修复">
        <RecountPanel pending={pendingRecount} />
      </Section>

      <Section title="流水">
        <form action="/admin/points/ledger" className="mb-3">
          {only && <input type="hidden" name="only" value={only} />}
          <input
            name="q"
            defaultValue={q ?? ""}
            placeholder="按昵称或微信 ID 找人"
            className="t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3.5 py-2.5 outline-none transition focus:ring-2 focus:ring-[var(--accent)]"
          />
        </form>

        <PillRow wrap>
          <Pill href={href({ only: undefined })} active={!only}>
            全部
          </Pill>
          <Pill href={href({ only: "manual" })} active={manualOnly}>
            只看人工调整 {summary.manual}
          </Pill>
          <Pill href={href({ only: "reverted" })} active={revertedOnly}>
            只看冲正 {summary.reverted}
          </Pill>
        </PillRow>

        <LedgerTable rows={rows} />
      </Section>

      <PageNote>
        冲正会写一条反向流水，<b className="font-medium">原记录保持不动</b> ——
        账本只增不改，改掉的话「当时到底发生了什么」就再也查不出来了。
        <br />
        人工发放 / 扣除在用户详情页上（那里能看到这个人的完整情况），
        这一页只负责看全站和冲正。
      </PageNote>
    </>
  );
}
