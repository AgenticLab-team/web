"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import { queueSend, saveDraft, submitForReview } from "@/lib/broadcast/actions";
import { DISPLAYS } from "@/lib/broadcast/announce-rules";
import { MAX_WECHAT_LENGTH } from "@/lib/broadcast/rules";

/**
 * 群发起草。
 *
 * 这是全站唯一**做错之后没法挽回**的界面，所以它刻意不像别的表单那样顺畅：
 *
 *   - 微信群发默认**不选任何群**，要一个个勾。「默认全选」会让人
 *     在没想清楚的情况下发给一千六百人。
 *   - 实时显示会发给几个群、约多少人，而不只是字数。
 *   - 提交复核时明说内容会被冻结 —— 之后再改要重新走一遍。
 *   - 一路没有「一键发送」。起草和发送是两个人、两个步骤。
 */

export interface GroupOption {
  convId: string;
  name: string;
  memberCount: number;
}

export function BroadcastComposer({
  groups,
  roles,
  canWechat,
}: {
  groups: GroupOption[];
  /** 可以定向到的身份组。留空就只能发全体 */
  roles: { id: string; name: string }[];
  canWechat: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();

  const [channel, setChannel] = useState<"site" | "wechat">("site");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [display, setDisplay] = useState<"banner" | "modal" | "inbox">("banner");
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [targetRole, setTargetRole] = useState<string | null>(null);

  const chosen = groups.filter((g) => targets.has(g.convId));
  const reach = chosen.reduce((sum, g) => sum + g.memberCount, 0);
  const tooLong = channel === "wechat" && content.trim().length > MAX_WECHAT_LENGTH;

  const submit = () => {
    startTransition(async () => {
      const saved = await saveDraft({
        channel,
        title,
        content,
        display: channel === "site" ? display : undefined,
        targetRoleId: channel === "site" ? targetRole : undefined,
        targetConvIds: channel === "wechat" ? [...targets] : undefined,
      });
      if (!saved.ok || !saved.id) {
        toast.show({ message: saved.error ?? "保存失败", kind: "error" });
        return;
      }

      const submitted = await submitForReview({ id: saved.id });
      if (!submitted.ok) {
        toast.show({ message: submitted.error ?? "提交失败", kind: "error" });
        return;
      }

      toast.show({ message: submitted.note ?? "已提交复核", kind: "success" });
      setTitle("");
      setContent("");
      setTargets(new Set());
      router.refresh();
    });
  };

  return (
    <div className="space-y-3 rounded-[var(--radius-card)] bg-[var(--surface)] p-4 hairline">
      <div className="flex gap-1.5">
        {(["site", "wechat"] as const).map((c) => (
          <button
            key={c}
            type="button"
            disabled={c === "wechat" && !canWechat}
            onClick={() => setChannel(c)}
            className={`t-footnote rounded-[var(--radius-pill)] px-3 py-1.5 font-medium transition-colors disabled:opacity-35 ${
              channel === c
                ? "bg-[var(--ink)] text-[var(--canvas)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            {c === "site" ? "站内公告" : "微信群发"}
          </button>
        ))}
      </div>

      {channel === "wechat" && (
        <p
          className="t-caption rounded-[var(--radius-control)] px-3 py-2 leading-relaxed"
          style={{
            background: "color-mix(in srgb, var(--danger) 8%, transparent)",
            color: "var(--danger)",
          }}
        >
          微信群发<strong>发出去就收不回</strong>（撤回窗口只有两分钟且不保证成功）。
          它需要另一个人复核，且每天最多三次、两次之间至少隔半小时 ——
          这些不是流程繁琐，是机器人已经因为高频操作被微信风控过一次。
        </p>
      )}

      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={channel === "site" ? "标题" : "标题（仅后台可见，不会发出去）"}
        className={inputClass}
      />

      <div>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          placeholder="正文"
          className={`${inputClass} resize-none`}
        />
        <p className="tabular t-caption2 mt-1 text-right text-[var(--ink-quaternary)]">
          {content.trim().length}
          {channel === "wechat" && (
            <span style={tooLong ? { color: "var(--danger)" } : undefined}>
              {" "}
              / {MAX_WECHAT_LENGTH}
            </span>
          )}
        </p>
      </div>

      {channel === "site" ? (
        <div className="space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {DISPLAYS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setDisplay(key)}
              className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 transition-colors ${
                display === key
                  ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                  : "bg-[var(--fill)] text-[var(--ink-secondary)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* 选中那一档意味着什么，就写在下面 —— 三个词本身分不出轻重，
            而「打断一次」用滥了下次就没人认真看 */}
        <p className="t-caption2 leading-relaxed text-[var(--ink-tertiary)]">
          {DISPLAYS.find((d) => d.key === display)?.detail}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="t-caption2 text-[var(--ink-quaternary)]">发给</span>
          <button
            type="button"
            onClick={() => setTargetRole(null)}
            className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 transition-colors ${
              targetRole === null
                ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                : "bg-[var(--fill)] text-[var(--ink-secondary)]"
            }`}
          >
            全体
          </button>
          {roles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setTargetRole(r.id)}
              className={`t-caption rounded-[var(--radius-pill)] px-2.5 py-1 transition-colors ${
                targetRole === r.id
                  ? "bg-[var(--accent)] font-medium text-[var(--accent-ink)]"
                  : "bg-[var(--fill)] text-[var(--ink-secondary)]"
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
        {/* 「版主请注意」这种话发给所有人，只会让所有人下次都跳过公告 */}
        {targetRole !== null && (
          <p className="t-caption2 text-[var(--ink-tertiary)]">
            只有这个身份组的人看得到
          </p>
        )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <p className="t-caption2 text-[var(--ink-quaternary)]">
            发给哪些群（默认一个都不选 —— 默认全选会让人在没想清楚的情况下发给所有人）
          </p>
          {groups.map((g) => (
            <label key={g.convId} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={targets.has(g.convId)}
                onChange={() =>
                  setTargets((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.convId)) next.delete(g.convId);
                    else next.add(g.convId);
                    return next;
                  })
                }
                className="h-4 w-4"
              />
              <span className="t-subhead min-w-0 flex-1 truncate">{g.name}</span>
              <span className="tabular t-caption2 text-[var(--ink-quaternary)]">
                {g.memberCount} 人
              </span>
            </label>
          ))}
        </div>
      )}

      {/* 说「会送到多少人眼前」，而不只是「几个群」—— 后者是数据，前者是后果 */}
      {channel === "wechat" && targets.size > 0 && (
        <p className="t-subhead">
          会发到 <span className="tabular font-medium">{targets.size}</span> 个群，
          约 <span className="tabular font-medium">{reach}</span> 人会在手机上收到提示音。
        </p>
      )}

      <button
        type="button"
        disabled={
          pending ||
          content.trim().length < 5 ||
          tooLong ||
          (channel === "wechat" && targets.size === 0)
        }
        onClick={submit}
        className="t-subhead w-full rounded-[var(--radius-control)] bg-[var(--accent)] px-4 py-2 font-medium text-[var(--accent-ink)] disabled:opacity-40"
      >
        提交复核
      </button>

      <p className="t-caption text-[var(--ink-tertiary)]">
        提交后<strong>内容会被冻结</strong>：复核的人看到什么，发出去的就是什么。
        之后再改要重新提交 —— 否则「先提一版温和的骗到批准，再改成别的」这条路是敞开的。
      </p>
    </div>
  );
}

/** 复核与发送。起草人自己看不到这两个按钮 */
export function BroadcastReview({
  id,
  isAuthor,
  status,
  contentDrifted,
}: {
  id: string;
  isAuthor: boolean;
  status: string;
  contentDrifted: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");

  const run = (fn: () => Promise<{ ok: boolean; error?: string; note?: string }>) => {
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        toast.show({ message: result.error ?? "操作失败", kind: "error" });
        return;
      }
      toast.show({ message: result.note ?? "已处理", kind: "success" });
      setNote("");
      router.refresh();
    });
  };

  if (contentDrifted) {
    return (
      <p className="t-caption rounded-[var(--radius-control)] px-3 py-2" style={{ background: "color-mix(in srgb, var(--danger) 10%, transparent)", color: "var(--danger)" }}>
        内容在提交复核后被改过了 —— 这条已经不能发，请重新提交复核。
      </p>
    );
  }

  if (status === "pending") {
    if (isAuthor) {
      return (
        <p className="t-caption rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink-tertiary)]">
          这是你起草的，要另一个人来复核 —— 自己批自己的话，这套流程只是多点了一次鼠标。
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="复核意见（必填）"
          className={`${inputClass} resize-none`}
        />
        <div className="flex gap-2">
          <ActionButton
            disabled={pending || !note.trim()}
            onClick={() =>
              run(async () => {
                const { approveBroadcast } = await import("@/lib/broadcast/actions");
                return approveBroadcast({ id, note });
              })
            }
          >
            通过复核
          </ActionButton>
          <ActionButton
            disabled={pending || !note.trim()}
            onClick={() =>
              run(async () => {
                const { rejectBroadcast } = await import("@/lib/broadcast/actions");
                return rejectBroadcast({ id, note });
              })
            }
          >
            驳回
          </ActionButton>
        </div>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="space-y-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => queueSend({ id }))}
          className="t-subhead w-full rounded-[var(--radius-control)] px-4 py-2 font-medium disabled:opacity-40"
          style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)" }}
        >
          确认发送
        </button>
        <p className="t-caption2 text-[var(--ink-tertiary)]">
          发送会逐个群进行并留出间隔，整体需要一两分钟。发出去之后只有两分钟的撤回窗口。
        </p>
      </div>
    );
  }

  return null;
}

function ActionButton({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  // 通过与驳回长得一样重 —— 把通过做成主色等于在界面上鼓励点它
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="t-subhead flex-1 rounded-[var(--radius-control)] bg-[var(--fill)] px-4 py-2 font-medium text-[var(--ink)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

const inputClass =
  "t-subhead w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 outline-none placeholder:text-[var(--ink-quaternary)]";
