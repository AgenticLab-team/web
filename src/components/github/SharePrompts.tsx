"use client";

import { GitPullRequest, Package } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { dismissGithubPromptAction } from "@/lib/github/actions";
import { composeHref, type PromptKind } from "@/lib/github/prompt-rules";

/**
 * 「你有个新项目 / 新 PR，要不要发个帖」。
 *
 * ═════════════════════════════════════════
 * 这块东西存在的意义是把一件**已经发生的事**变成一次分享
 * ═════════════════════════════════════════
 *
 * 所以它不能是一个红点。红点的意思是「你有事没做」，
 * 而这里没有任何事是他必须做的 —— 他的项目已经建好了，
 * PR 已经合了，这个站只是问一句要不要说给群里听。
 *
 * 落到具体设计上是四条：
 *
 *   ① **没有角标、没有小红点**。它就是「我的」页上的一张卡片，
 *      不出现在导航、不出现在通知里。
 *   ② 「不用了」和「去分享」**一样显眼**。把拒绝藏起来是让人
 *      学会无视整块区域最快的办法。
 *   ③ 点「去分享」进的是一张**填好了的**发帖表单 ——
 *      标题、链接、简介都在里面，不改也能发。
 *      如果点过去是一张白纸，那这条提示做的事就只是打断你然后把活儿丢给你。
 *   ④ 点了「不用了」这一条**永远不会再回来**（见 lib/github/prompts.ts：
 *      记录留在库里、状态变 dismissed，检测时按 subject_key 跳过）。
 */

export interface PromptItem {
  id: string;
  kind: PromptKind;
  title: string;
  url: string;
  summary: string | null;
  repoFullName: string | null;
}

export function SharePrompts({ items }: { items: PromptItem[] }) {
  const [hidden, setHidden] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  const visible = items.filter((i) => !hidden.includes(i.id));
  if (visible.length === 0) return null;

  function dismiss(id: string) {
    // 先收起来再发请求 —— 「不用了」这个动作等一秒才有反应会显得很粘
    setHidden((prev) => [...prev, id]);
    startTransition(async () => {
      const result = await dismissGithubPromptAction(id);
      if (!result.ok) setHidden((prev) => prev.filter((x) => x !== id));
    });
  }

  return (
    <div className="inset-group">
      {visible.map((item) => (
        <div key={item.id} className="inset-row px-4 py-3.5">
          <p className="t-subhead flex items-start gap-2">
            {item.kind === "pr" ? (
              <GitPullRequest
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-tertiary)]"
                strokeWidth={2}
                aria-hidden
              />
            ) : (
              <Package
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ink-tertiary)]"
                strokeWidth={2}
                aria-hidden
              />
            )}
            <span className="min-w-0 flex-1 break-words font-medium">{item.title}</span>
          </p>
          {item.summary && (
            <p className="t-caption mt-1 line-clamp-2 break-words leading-relaxed text-[var(--ink-secondary)]">
              {item.summary}
            </p>
          )}
          <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-tertiary)]">
            {item.kind === "pr"
              ? "这个 PR 合并了，要不要跟群里说一声"
              : "这个项目是新的，要不要发个帖介绍一下"}
          </p>

          <div className="mt-2.5 flex items-center gap-2">
            <Link
              href={composeHref(item.id)}
              className="t-footnote inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3 font-medium text-[var(--accent)] transition active:opacity-60"
              style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
            >
              去分享（已填好）
            </Link>
            {/* 「不用了」和「去分享」并排、同样大小 —— 藏起来的拒绝入口等于没有 */}
            <button
              type="button"
              disabled={pending}
              onClick={() => dismiss(item.id)}
              className="t-footnote inline-flex min-h-11 items-center px-3 text-[var(--ink-secondary)] transition active:opacity-60 disabled:opacity-45"
            >
              不用了
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
