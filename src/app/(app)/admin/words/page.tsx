import type { Metadata } from "next";
import { desc } from "drizzle-orm";

import { WordList } from "@/components/admin/WordList";
import { WordTester } from "@/components/admin/WordTester";
import { PageHeader } from "@/components/shell/PageHeader";
import { Section } from "@/components/ui/primitives";
import { requireAdmin } from "@/lib/admin/guard";
import { db } from "@/lib/db";
import { sensitiveWords } from "@/lib/db/schema";

export const metadata: Metadata = { title: "敏感词" };
export const dynamic = "force-dynamic";

/**
 * 敏感词库。
 *
 * 页面开头先讲清楚这套东西的代价，而不是直接甩一个输入框。
 * 加词是**低门槛高破坏力**的操作：一个太短或太常见的词，
 * 几分钟内就能让论坛变成不可用 —— 而且是**静默**的，
 * 没人会来报告「我发不出去帖子」，他们只会不再发帖。
 */
export default async function AdminWordsPage() {
  await requireAdmin("moderation.words");

  const words = db.select().from(sensitiveWords).orderBy(desc(sensitiveWords.hitCount)).all();

  const blocking = words.filter((w) => w.enabled && w.kind === "block").length;
  const suspicious = words.filter((w) => w.enabled && w.hitCount > 50);

  return (
    <>
      <PageHeader
        title="敏感词"
        subtitle={words.length === 0 ? "词库是空的" : `${words.length} 条 · ${blocking} 条拦截`}
      />

      <div className="mb-4 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
        <p className="t-subhead leading-relaxed">
          子串匹配<strong>必然误伤</strong> —— 一个两字的词能在无数正常表达里出现。
        </p>
        <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
          所以默认档位是「送审」而不是「拦截」：送审只是多一道人工确认，
          拦截则是对方的内容直接没了，而他往往不知道为什么，也没处说理。
          真的要拦，先用下面的预览器拿几段真实聊天记录试一遍。
        </p>
      </div>

      {suspicious.length > 0 && (
        <div
          className="mb-4 rounded-[var(--radius-card)] p-4 hairline"
          style={{ background: "color-mix(in srgb, var(--warning) 9%, var(--surface))" }}
        >
          <p className="t-subhead font-medium" style={{ color: "var(--warning)" }}>
            {suspicious.length} 条规则命中次数异常高
          </p>
          <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
            {suspicious.map((w) => `${w.word}（${w.hitCount} 次）`).join("、")}。
            命中特别多**大概率是误伤**，不是这条规则很有用 ——
            真正的违规内容不会天天出现几十次。建议拿这个词去预览器里试试。
          </p>
        </div>
      )}

      <Section title="预览">
        <WordTester />
      </Section>

      <Section title="词库">
        <WordList
          words={words.map((w) => ({
            id: w.id,
            word: w.word,
            kind: w.kind,
            replacement: w.replacement,
            enabled: w.enabled,
            hitCount: w.hitCount,
          }))}
        />
      </Section>

      <p className="t-caption px-1 pb-4 leading-relaxed text-[var(--ink-tertiary)]">
        匹配前会先归一化：去掉空白与标点、全角转半角、统一小写 ——
        否则加个空格或换成全角就绕过去了。
        发帖、编辑、回复三条路都会过这道闸；只查发帖的话，
        先发一篇干净的再编辑把词加进去就绕过了。
      </p>
    </>
  );
}
