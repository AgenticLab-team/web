"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Avatar } from "@/components/Avatar";
import { convertMessagesToPost } from "@/lib/forum/convert";
import type { PickableMessage } from "@/lib/forum/convert-source";
import { messageAnchor } from "@/lib/messages/archive-rules";

/**
 * 消息挑选器。
 *
 * 交互按聊天记录的习惯做：轻点整行即选中，而不是去点一个小方框 ——
 * 手机上小方框太难命中。支持**按住右侧的圆点拖过一片**批量选，
 * 群聊的有效片段往往是连续的十几条。
 *
 * ─────────────────────────────────────────
 * 「手机上没法滑着选」是三个 bug 叠在一起
 * ─────────────────────────────────────────
 *
 * 站长说「不能快速滑动去引用消息」。拆开看是三件事，
 * 每一件单独都足以让这个功能在手机上不存在：
 *
 * 1. **拖选在触摸屏上从来没生效过**。区间靠 `onPointerEnter` 认，
 *    而触摸指针在 pointerdown 那一刻就被**隐式捕获**到起始元素上了 ——
 *    后面所有 pointer 事件都只发给它，兄弟元素的 enter 永远不触发。
 *    在鼠标上测是好的，所以这个洞可以一直活着。
 *    改成在容器上听 `pointermove` + `elementFromPoint` 反查行，
 *    捕获与否都不影响。
 *
 * 2. **手指一碰就选中了**。选中挂在 `onPointerDown` 上，
 *    而手机上「碰一下」通常是想滚页面 —— 于是往下滑几屏，
 *    顺手选中了三条不相干的消息。改挂 `onClick`：
 *    浏览器判定成滚动手势时不会派发 click。
 *
 * 3. **没有任何东西暗示可以拖**。右侧圆点写的是
 *    `opacity-0 group-hover:opacity-100`，而**父元素上根本没有 `group`**，
 *    所以它在任何设备上都是全透明的。现在未选中时是个空心圈，一直可见。
 *
 * 拖动只在那条 36px 宽的圆点栏里触发（`touch-action: none`），
 * 正文区照常滚动 —— 否则整行禁用触摸滚动，列表就滑不动了。
 */
export function MessagePicker({
  convId,
  groupName,
  messages,
  focusId = null,
}: {
  convId: string;
  groupName: string;
  messages: PickableMessage[];
  /**
   * 带着某一条进来时预先选中它。
   *
   * 「在回看里看到一句话 → 想留下来」是最短的那条路：
   * 点一下引用图标就落到这里，那条已经选好、已经滚到眼前，
   * 只差起个标题。要人自己再从几百条里找一遍，就等于没做。
   */
  focusId?: string | null;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() =>
    focusId ? new Set([focusId]) : new Set(),
  );
  const [dragging, setDragging] = useState<null | boolean>(null);
  const [title, setTitle] = useState("");
  const [intro, setIntro] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const toggle = (id: string, force?: boolean) => {
    setSelected((current) => {
      const shouldSelect = force ?? !current.has(id);
      if (shouldSelect === current.has(id)) return current;
      const next = new Set(current);
      if (shouldSelect) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  /**
   * 拖过的每一行都跟着起始那一下的方向走。
   *
   * 用 `elementFromPoint` 反查落在哪一行，而不是指望事件冒泡到那一行 ——
   * 触摸指针被捕获在圆点上，事件根本不会经过别的行（见上面第 1 条）。
   */
  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === null) return;
    const row = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>("[data-msg-id]");
    const id = row?.dataset.msgId;
    if (id) toggle(id, dragging);
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
      <p className="t-caption2 px-1 text-[var(--ink-tertiary)]">
        轻点一行选中；按住右侧的圆点上下拖，可以一次选连续的一片。
      </p>

      <div
        className="inset-group select-none"
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(null)}
        onPointerCancel={() => setDragging(null)}
      >
        {messages.map((message) => {
          const active = selected.has(message.id);
          return (
            <div
              key={message.id}
              data-msg-id={message.id}
              id={messageAnchor(message.id)}
              /* scroll-mt 躲开吸顶的翻天条，否则锚过去正好被压在它下面 */
              className={`inset-row flex scroll-mt-28 items-stretch transition-colors ${
                active ? "bg-[var(--accent-soft)]" : ""
              } ${message.id === focusId ? "msg-focus" : ""}`}
            >
              <button
                type="button"
                onClick={() => toggle(message.id)}
                aria-pressed={active}
                className="flex min-w-0 flex-1 gap-3 px-4 py-2.5 text-left"
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
                        // 日期边界按东八区切，时间也得按东八区显示，否则两者对不上
                        timeZone: "Asia/Shanghai",
                      })}
                    </span>
                  </span>
                  <span className="t-subhead mt-0.5 block whitespace-pre-wrap break-words leading-relaxed">
                    {message.type === "text" || message.type === "quote"
                      ? message.content
                      : `[${message.type}]`}
                  </span>
                </span>
              </button>

              {/*
                * 拖选的把手。只有这一栏禁用触摸滚动 ——
                * 整行禁用的话列表就滑不动了，那是比不能拖选更大的问题。
                */}
              <span
                aria-hidden
                onPointerDown={(e) => {
                  const next = !active;
                  setDragging(next);
                  toggle(message.id, next);
                  /*
                   * 主动**保持**捕获（触摸是隐式的，鼠标要显式要一次）。
                   *
                   * 捕获住之后所有 pointer 事件都发给这个把手，再冒泡到容器 ——
                   * 于是无论手指滑出列表多远，pointerup 都一定回得来，
                   * 不会留下一个「以为还在拖」的状态。
                   * 行的反查交给 elementFromPoint，不依赖事件目标。
                   */
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                style={{ touchAction: "none" }}
                className="flex w-9 shrink-0 cursor-grab items-center justify-center"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full transition ${
                    active
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : "border border-[var(--separator)] bg-[var(--fill)]"
                  }`}
                >
                  {active && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
                </span>
              </span>
            </div>
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
