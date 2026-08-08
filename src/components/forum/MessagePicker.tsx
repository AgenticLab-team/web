"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Avatar } from "@/components/Avatar";
import { convertMessagesToPost } from "@/lib/forum/convert";
import type { PickableMessage } from "@/lib/forum/convert-source";

/**
 * 消息挑选器。
 *
 * 交互按聊天记录的习惯做：轻点整行即选中，而不是去点一个小方框 ——
 * 手机上小方框太难命中。支持**按住拖过一片**批量选，
 * 群聊的有效片段往往是连续的十几条。
 */
export function MessagePicker({
  convId,
  groupName,
  messages,
}: {
  convId: string;
  groupName: string;
  messages: PickableMessage[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState<null | boolean>(null);
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string, force?: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const shouldSelect = force ?? !next.has(id);
      if (shouldSelect) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /** 选中区间：点第一条再按住拖到最后一条 */
  const onPointerEnter = (id: string) => {
    if (dragging === null) return;
    toggle(id, dragging);
  };

  const authors = useMemo(() => {
    const set = new Set<string>();
    for (const m of messages) if (selected.has(m.id)) set.add(m.senderWxId);
    return set.size;
  }, [messages, selected]);

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await convertMessagesToPost({
        convId,
        messageIds: [...selected],
        title,
        intro,
      });
      if (!result.ok) setError(result.error ?? "转换失败");
      else router.push(`/forum/p/${result.postId}`);
    });
  };

  return (
    <div className="space-y-4">
      <div
        className="inset-group select-none"
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => setDragging(null)}
      >
        {messages.map((message) => {
          const active = selected.has(message.id);
          return (
            <button
              key={message.id}
              type="button"
              onPointerDown={() => {
                const next = !active;
                setDragging(next);
                toggle(message.id, next);
              }}
              onPointerEnter={() => onPointerEnter(message.id)}
              aria-pressed={active}
              className={`inset-row flex w-full gap-3 px-4 py-2.5 text-left transition-colors ${
                active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--fill)]"
              }`}
            >
              <span className="mt-0.5 shrink-0">
                <Avatar
                  wxId={message.senderWxId}
                  name={message.senderName}
                  src={message.avatarUrl}
                  size={28}
                />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="t-caption font-medium text-[var(--ink-secondary)]">
                    {message.senderName}
                  </span>
                  <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                    {new Date(message.ts).toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </span>
                </span>
                <span className="t-subhead mt-0.5 block whitespace-pre-wrap break-words leading-relaxed">
                  {message.type === "text" || message.type === "quote"
                    ? message.content
                    : `[${message.type}]`}
                </span>
              </span>

              <span
                className={`mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-all ${
                  active
                    ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                    : "bg-[var(--fill-strong)] opacity-0 group-hover:opacity-100"
                }`}
                aria-hidden
              >
                {active && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>

      {/* 选中后才出现表单，没选之前不占地方 */}
      {selected.size > 0 && (
        <div className="animate-rise sticky bottom-[calc(var(--tabbar-height)+env(safe-area-inset-bottom,0px)+0.75rem)] space-y-3 rounded-[var(--radius-card)] bg-[var(--surface-raised)] p-4 shadow-[var(--shadow-raised)] lg:bottom-4">
          <p className="t-footnote text-[var(--ink-secondary)]">
            已选 <strong className="tabular">{selected.size}</strong> 条 · 涉及{" "}
            <strong className="tabular">{authors}</strong> 位发言人
          </p>

          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="给这段讨论起个标题"
            maxLength={120}
            className="t-body w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2.5 outline-none placeholder:text-[var(--ink-quaternary)]"
          />

          <textarea
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            placeholder="补充说明（可选）——为什么这段值得留下来"
            rows={2}
            className="t-subhead w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]"
          />

          {error && (
            <p className="t-footnote text-[var(--danger)]" role="alert">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending || title.trim().length < 2}
              onClick={submit}
              className="t-body flex-1 rounded-[var(--radius-control)] bg-[var(--accent)] px-5 py-2.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-40"
            >
              {pending ? "整理中…" : "整理成帖子"}
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="t-body rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2.5"
            >
              清空
            </button>
          </div>

          <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
            转出来的帖子只有「{groupName}」的成员看得到。
            被引用的每个人都会收到通知。
          </p>
        </div>
      )}
    </div>
  );
}
