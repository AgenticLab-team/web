"use client";

import { AlertTriangle } from "lucide-react";
import { useState, useTransition } from "react";

import { deleteMyAccount } from "@/lib/users/delete-actions";
import { CONFIRM_WORD, MUST_DISCLOSE } from "@/lib/users/deletion-plan";

/**
 * 注销账号。
 *
 * ─────────────────────────────────────────
 * 折叠着，但不藏起来
 * ─────────────────────────────────────────
 *
 * 默认收起：这一屏上别的都是日常设置，一个红色的不可撤销按钮
 * 常驻在那儿，会让每次进来改通知偏好的人都紧张一下。
 *
 * 但**不能藏进二级页面**。「你的数据你能拿走」是这个站信任基建的一部分，
 * 而一个找不到的注销入口，和没有注销一样 ——
 * 区别只是前者还显得像有。
 *
 * ─────────────────────────────────────────
 * 告知在确认之前，不是在旁边
 * ─────────────────────────────────────────
 *
 * 三条必须说清楚的（尤其「群聊记录删不掉」）排在输入框**上面**。
 * 放在旁边或下面的话，人会先打完确认词再读到 ——
 * 而那时他的注意力已经在按钮上了。
 *
 * 最要紧的一条是第一条：他很可能以为注销能删掉自己的微信发言。
 * 删不掉。**等他发现时已经没有账号可以登回来问了。**
 */
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const ready = confirm.trim() === CONFIRM_WORD;

  const submit = () =>
    start(async () => {
      setError(null);
      /*
       * 成功时服务端会 redirect，这个 Promise 不会正常返回 ——
       * 所以只有失败才走得到下面这行。
       */
      const result = await deleteMyAccount({ confirm, reason });
      if (result && !result.ok) setError(result.error);
    });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap-target t-caption text-[var(--ink-tertiary)] underline underline-offset-2 transition-colors hover:text-[var(--danger)]"
      >
        注销账号
      </button>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--danger)] bg-[var(--surface)] p-4">
      <div className="mb-3 flex items-center gap-1.5" style={{ color: "var(--danger)" }}>
        <AlertTriangle size={15} strokeWidth={2.2} aria-hidden />
        <p className="t-subhead font-medium">注销账号</p>
      </div>

      {/*
        告知排在最前面。三条都摊开，不折叠 ——
        一个需要点开才看得到的免责说明，等于没有说。
      */}
      <ul className="mb-4 space-y-2.5">
        {MUST_DISCLOSE.map((item) => (
          <li key={item.key}>
            <p className="t-subhead">{item.text}</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
              {item.detail}
            </p>
          </li>
        ))}
      </ul>

      <label className="t-caption block text-[var(--ink-secondary)]">
        想说点什么吗？（可不填，只有管理员看得到）
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          maxLength={200}
          className="t-caption mt-1 w-full resize-none rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink)] outline-none"
          placeholder="比如：不常用了 / 隐私顾虑 / 换号了"
        />
      </label>

      <label className="t-caption mt-3 block text-[var(--ink-secondary)]">
        确认请输入 <span className="font-medium text-[var(--ink)]">{CONFIRM_WORD}</span>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-3 py-2 text-[var(--ink)] outline-none"
          placeholder={CONFIRM_WORD}
          autoComplete="off"
        />
      </label>

      {error && (
        <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={submit}
          /*
           * 打对确认词之前一直是禁用的 —— 一个不可撤销的操作，
           * 不该只隔着一次点击。
           */
          disabled={!ready || pending}
          className="t-subhead min-h-11 flex-1 rounded-[var(--radius-control)] font-medium text-white transition active:scale-[0.97] disabled:opacity-35"
          style={{ background: "var(--danger)" }}
        >
          {pending ? "正在注销…" : "确认注销"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setConfirm("");
            setError(null);
          }}
          disabled={pending}
          className="t-subhead min-h-11 rounded-[var(--radius-control)] bg-[var(--fill)] px-5 text-[var(--ink)] transition active:scale-[0.97]"
        >
          取消
        </button>
      </div>
    </div>
  );
}
