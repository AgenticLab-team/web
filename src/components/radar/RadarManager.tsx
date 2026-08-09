"use client";

import { Check, Loader2, Pause, Play, Trash2, TriangleAlert } from "lucide-react";
import { useState, useTransition } from "react";

import { addKeyword, previewKeyword, removeKeyword, toggleKeyword } from "@/lib/radar/actions";
import {
  MAX_HITS_PER_DAY,
  MAX_KEYWORDS_PER_USER,
  type NoiseCheck,
} from "@/lib/radar/match";
import type { RadarSub } from "@/lib/radar/queries";

/**
 * 关键词订阅管理。
 *
 * 交互上最重要的一步是**订阅之前先说这个词会有多吵**。
 *
 * 一个订阅了「AI」的人一天收到两百条通知，他的应对不是回来精简关键词，
 * 是把整个通知关掉 —— 连带着那些他真正在意的一起没了。
 * 所以输入框失焦就去算一遍过去七天的命中数，太吵的把「订阅」换成
 * 「仍然订阅」并配上红色 —— 让他知道自己在选什么，而不是事后后悔。
 */
export function RadarManager({ initial }: { initial: RadarSub[] }) {
  const [subs, setSubs] = useState(initial);
  const [draft, setDraft] = useState("");
  const [noise, setNoise] = useState<NoiseCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [probing, setProbing] = useState(false);

  const full = subs.length >= MAX_KEYWORDS_PER_USER;

  function probe(value: string) {
    const keyword = value.trim();
    setNoise(null);
    setError(null);
    if (keyword.length < 2) return;

    setProbing(true);
    startTransition(async () => {
      const result = await previewKeyword(keyword);
      setProbing(false);
      if (result.ok) setNoise(result.noise ?? null);
      else setError(result.error ?? null);
    });
  }

  function submit(force = false) {
    const keyword = draft.trim();
    if (!keyword) return;

    setError(null);
    startTransition(async () => {
      const result = await addKeyword(keyword, force);
      if (!result.ok) {
        setError(result.error ?? "添加失败");
        setNoise(result.noise ?? null);
        return;
      }
      setDraft("");
      setNoise(null);
      setNote(result.note ?? null);
      // 服务端已经 revalidate，这里乐观加一行让手感跟上
      setSubs((prev) => [
        {
          id: `tmp-${keyword}`,
          keyword,
          enabled: true,
          totalHits: 0,
          hitsToday: 0,
          lastNotifiedAt: null,
          hits7dAtCreate: result.noise?.hits7d ?? 0,
          cappedToday: false,
          recent: [],
        },
        ...prev,
      ]);
    });
  }

  /** 暂停 / 恢复：先动界面，失败拨回去 */
  function flip(id: string) {
    setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
    setError(null);
    startTransition(async () => {
      const result = await toggleKeyword(id);
      if (result.ok) {
        setNote(result.note ?? null);
      } else {
        setSubs((prev) => prev.map((s) => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
        setError(result.error ?? "操作失败");
      }
    });
  }

  const noisy = noise?.verdict === "noisy";

  return (
    <div className="space-y-4">
      <div>
        <div className="flex gap-2">
          <input
            value={draft}
            disabled={full || pending}
            maxLength={24}
            placeholder={full ? `已经 ${MAX_KEYWORDS_PER_USER} 个了` : "想被提醒的词，比如「RAG」"}
            onChange={(e) => {
              setDraft(e.target.value);
              setNoise(null);
              setError(null);
            }}
            onBlur={(e) => probe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (noise) submit(noisy);
                else probe(draft);
              }
            }}
            className="t-body min-w-0 flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-3.5 py-2.5 outline-none transition focus:ring-2 focus:ring-[var(--accent)] disabled:opacity-45"
          />
          <button
            type="button"
            disabled={!draft.trim() || full || pending}
            onClick={() => submit(noisy)}
            className="t-subhead shrink-0 rounded-[var(--radius-control)] px-4 font-medium text-white transition active:opacity-70 disabled:opacity-35"
            style={{ background: noisy ? "var(--danger)" : "var(--accent)" }}
          >
            {probing ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.2} aria-hidden />
            ) : noisy ? (
              "仍然订阅"
            ) : (
              "订阅"
            )}
          </button>
        </div>

        {/* 订阅那一刻就说清楚会有多吵 —— 事后后悔的人不会回来精简关键词 */}
        {noise && (
          <p
            className="t-caption mt-2 flex items-start gap-1.5 px-1 leading-relaxed"
            style={{
              color:
                noise.verdict === "noisy"
                  ? "var(--danger)"
                  : noise.verdict === "busy"
                    ? "var(--warning)"
                    : "var(--ink-tertiary)",
            }}
          >
            {noise.verdict !== "ok" && (
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={2.2} aria-hidden />
            )}
            {noise.message}
          </p>
        )}
        {error && (
          <p className="t-caption mt-2 px-1" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {!noise && !error && (
          <p className="t-caption mt-2 px-1 text-[var(--ink-tertiary)]">
            输完会先算一遍这个词过去七天在你的群里响了多少次
          </p>
        )}
      </div>

      {subs.length === 0 ? (
        <p className="t-caption px-1 leading-relaxed text-[var(--ink-quaternary)]">
          还没有订阅任何词。订阅之后，群里有人提到它就会通知你 ——
          每个词每天最多提醒 {MAX_HITS_PER_DAY} 次。
        </p>
      ) : (
        <div className="space-y-2">
          {subs.map((sub) => (
            <article
              key={sub.id}
              className="rounded-[var(--radius-card)] bg-[var(--surface)] p-3.5 hairline"
              style={{ opacity: sub.enabled ? 1 : 0.55 }}
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="t-body flex flex-wrap items-center gap-1.5 font-medium">
                    {sub.keyword}
                    {!sub.enabled && (
                      <span className="t-caption2 text-[var(--ink-quaternary)]">已暂停</span>
                    )}
                    {sub.cappedToday && (
                      <span className="t-caption2" style={{ color: "var(--warning)" }}>
                        今天已达提醒上限
                      </span>
                    )}
                  </p>

                  <p className="t-caption2 mt-0.5 text-[var(--ink-quaternary)]">
                    累计命中 {sub.totalHits} 次
                    {sub.hitsToday > 0 && ` · 今天提醒 ${sub.hitsToday} 次`}
                    {sub.hits7dAtCreate > 0 && ` · 订阅时七天 ${sub.hits7dAtCreate} 次`}
                  </p>

                  {sub.recent.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {sub.recent.map((hit) => (
                        <li key={hit.id} className="t-caption2 truncate text-[var(--ink-tertiary)]">
                          <span className="text-[var(--ink-quaternary)]">{hit.senderName}：</span>
                          {hit.snippet}
                          {/* 被压掉的也列出来 —— 少通知是有意的，瞒着不说不是 */}
                          {!hit.notified && (
                            <span className="ml-1 text-[var(--ink-quaternary)]">（未通知）</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <button
                  type="button"
                  aria-label={sub.enabled ? "暂停" : "恢复"}
                  disabled={pending}
                  onClick={() => flip(sub.id)}
                  className="tap-target shrink-0 rounded-full p-1.5 text-[var(--ink-tertiary)] transition active:opacity-50"
                >
                  {sub.enabled ? (
                    <Pause className="h-4 w-4" strokeWidth={2} aria-hidden />
                  ) : (
                    <Play className="h-4 w-4" strokeWidth={2} aria-hidden />
                  )}
                </button>
                <button
                  type="button"
                  aria-label="删除"
                  disabled={pending}
                  onClick={() => {
                    startTransition(async () => {
                      const result = await removeKeyword(sub.id);
                      if (result.ok) {
                        setSubs((prev) => prev.filter((s) => s.id !== sub.id));
                        setNote(result.note ?? null);
                      } else setError(result.error ?? "删除失败");
                    });
                  }}
                  className="tap-target shrink-0 rounded-full p-1.5 text-[var(--ink-quaternary)] transition active:opacity-50"
                >
                  <Trash2 className="h-4 w-4" strokeWidth={2} aria-hidden />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {note && (
        <p className="t-caption flex items-center gap-1 px-1 text-[var(--ink-tertiary)]">
          <Check className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
          {note}
        </p>
      )}
    </div>
  );
}
