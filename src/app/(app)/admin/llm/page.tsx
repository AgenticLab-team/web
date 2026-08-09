import { Sparkles } from "lucide-react";
import type { Metadata } from "next";

import { EnrichRunner } from "@/components/admin/EnrichRunner";
import { PageHeader } from "@/components/shell/PageHeader";
import { Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { enrichProgress } from "@/lib/links/enrich";
import { probeChat, probeEmbedding, type LlmProbe } from "@/lib/llm/health";

export const metadata: Metadata = { title: "模型接入" };
export const dynamic = "force-dynamic";

/**
 * 模型接入。
 *
 * ─────────────────────────────────────────
 * 这一页存在的理由是「配了」不等于「能用」
 * ─────────────────────────────────────────
 *
 * 环境变量填齐只说明有人填过。真正会出问题的几种 ——
 * key 过期、额度用光、base URL 少写 `/v1`、模型名拼错、
 * 自建端点的机器关了 —— 在一张只显示配置的页面上
 * **长得和正常一模一样**。
 *
 * 所以这一页每次打开都真的发一次最小请求过去。
 */
function ProbeRow({ label, probe, hint }: { label: string; probe: LlmProbe; hint: string }) {
  const tone = !probe.configured
    ? "text-[var(--ink-tertiary)]"
    : probe.ok
      ? "text-[var(--success)]"
      : "text-[var(--danger)]";

  return (
    <div className="inset-row px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="t-subhead font-medium">{label}</span>
        <span className={`t-caption ${tone}`}>
          {!probe.configured ? "未配置" : probe.ok ? "可用" : "不可用"}
        </span>
        {probe.latencyMs !== undefined && (
          <span className="t-caption ml-auto tabular-nums text-[var(--ink-quaternary)]">
            {probe.latencyMs} ms
          </span>
        )}
      </div>
      <p className={`t-caption mt-0.5 leading-relaxed ${probe.ok ? "text-[var(--ink-secondary)]" : tone}`}>
        {probe.detail}
      </p>
      <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">{hint}</p>
    </div>
  );
}

export default async function AdminLlmPage() {
  await requireAdmin("system.settings");

  // 两个探测各自要几秒，并行跑
  const [chat, embedding] = await Promise.all([probeChat(), probeEmbedding()]);
  const progress = enrichProgress();

  return (
    <>
      <PageHeader
        title="模型接入"
        subtitle="对话与嵌入分两套配置，这一页每次打开都真的调一次"
      />

      <Section title="现在通不通">
        <div className="inset-group">
          <ProbeRow
            label="对话模型"
            probe={chat}
            hint="LLM_BASE_URL · LLM_API_KEY · LLM_MODEL — 用于资源库整理、摘要"
          />
          <ProbeRow
            label="嵌入模型"
            probe={embedding}
            hint="EMBEDDING_BASE_URL · EMBEDDING_API_KEY · EMBEDDING_MODEL — 用于语义检索"
          />
        </div>
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          两套分开配是因为它们经常不是同一家 —— 实测 DeepSeek 只有对话、没有嵌入接口。
          嵌入的探测会发两句<strong>毫不相干</strong>的话过去比对：
          一个对任何输入都返回同一个向量的端点，只发一句是验不出来的，
          而它会让整个语义检索静默失效。
        </p>
        <p className="t-caption mt-1.5 px-1 leading-relaxed text-[var(--ink-tertiary)]">
          「可用」这两个字只保证：连得上、认这个 key、向量不是全零、
          对不同语义给出不同向量、维度和 <code className="font-mono">EMBEDDING_DIMENSIONS</code> 对得上。
          <strong>它不保证你用的是你以为的那个模型</strong> ——
          实测现在这个自建端点完全忽略 <code className="font-mono">model</code> 字段，
          填一个不存在的模型名照样返回正常向量。
        </p>
      </Section>

      <Section title="资源库整理">
        <div className="inset-group">
          <div className="inset-row px-4 py-3">
            <p className="t-subhead">
              {progress.total} 条链接 · 已整理{" "}
              <strong className="text-[var(--success)]">{progress.enriched}</strong> · 问过但说不清{" "}
              {progress.checkedButUnknown} · 还没问 {progress.untouched}
            </p>
            <p className="t-caption mt-1 leading-relaxed text-[var(--ink-tertiary)]">
              「说不清」不是失败 —— 那些链接分享时群里没说它是什么，
              而<strong>编一个通顺的简介比留空危险得多</strong>：
              读的人默认它是可靠的。这类条目不会被反复重问。
            </p>
          </div>
          <EnrichRunner disabled={!chat.ok} />
        </div>
      </Section>

      <p className="t-caption flex items-start gap-1.5 px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
        <span>
          密钥只存在服务器的 <code className="font-mono">.env.local</code> 里，不进仓库、不在这一页显示。
          换密钥改那个文件后重启服务即可，这一页会立刻反映出来。
        </span>
      </p>
    </>
  );
}
