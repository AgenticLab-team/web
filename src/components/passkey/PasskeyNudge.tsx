"use client";

import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/Toast";
import {
  declinePasskeyNudgeAction,
  snoozePasskeyNudgeAction,
  undoDeclinePasskeyNudgeAction,
} from "@/lib/auth/passkey-nudge-actions";

import { registerSuccessFeedback } from "./feedback";
import { usePasskeyRegister, usePasskeySupport } from "./usePasskey";

/**
 * 「加个 Passkey 吧」。首页上的一张卡片。
 *
 * ═════════════════════════════════════════
 * 它是一张卡片，不是一个弹窗，也不是一个红点
 * ═════════════════════════════════════════
 *
 * 盖住整页的模态框只有一种用法说得通：**不处理就没法继续**。
 * 而这件事恰恰相反 —— 一个没绑 Passkey 的普通成员，用验证码
 * 照样进得来、站里什么都能做。拿模态框挡住他，是在为一件
 * 本来可选的事索取一次强制的注意力，而人对被强收的注意力
 * 的反应是找关闭按钮，不是读字。
 *
 * 具体到设计上是四条：
 *
 *   ① **没有角标、不进通知中心、不出现在导航上。** 它说的是
 *      「你可以做一件事」，不是「你有事没做」。
 *   ② 三个按钮**并排、一样大**。把「不用了」做成一行灰色小字，
 *      是让人学会无视整块区域最快的办法。
 *   ③ 点「现在就加」当场就把指纹弹窗调起来，不是把人丢到
 *      设置页去自己找按钮 —— 一条把活儿丢回给用户的提示
 *      做的事只是打断他。
 *   ④ 「不用了」之后**永远**不会再回来（状态在 users 表上，
 *      见 lib/auth/passkey-nudge.ts），「以后再说」隔两周再提一次。
 *
 * ─────────────────────────────────────────
 * 浏览器不支持就整块不出现
 * ─────────────────────────────────────────
 *
 * 探测是客户端的事（`usePasskeySupport` 要 navigator），服务端没法先知道。
 * 在一个根本弹不出指纹框的浏览器里劝人加 Passkey，用户点下去只会
 * 得到一句报错 —— 那比不提醒更糟：他会认为这个站是坏的。
 * `"unknown"` 期间也不显示，避免卡片闪一下又消失。
 */
export function PasskeyNudge({ title, body }: { title: string; body: string }) {
  const router = useRouter();
  const toast = useToast();
  const support = usePasskeySupport();
  /** 三个出口共用一个「收起来」——点完就走，不留一张已经处理完的卡片在那儿 */
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const { busy, error, register } = usePasskeyRegister(() => {
    setDone(true);
    toast.show(registerSuccessFeedback());
    // 刷新之后服务端那边 hasPasskey 已经是 true，这张卡片不会再渲染出来
    router.refresh();
  });

  if (done || support === "unknown" || support === "unsupported") return null;

  /*
   * 乐观地先收起来，失败再放回去。
   *
   * 「以后再说」和「不用了」都是「让它走开」的动作，等一秒才有反应
   * 会显得很粘 —— 而一个反应慢的关闭按钮，用户会连点好几下。
   * 失败时必须放回来并说出来：静默失败等于状态没存上，
   * 而下次它照样出现，那就成了「点不掉的东西」。
   */
  function resolve(
    run: () => Promise<{ ok: boolean; note?: string; error?: string }>,
    undo?: () => void,
  ) {
    setDone(true);
    startTransition(async () => {
      const result = await run();
      if (result.ok) {
        if (result.note) toast.show({ kind: "success", message: result.note, undo });
      } else {
        setDone(false);
        toast.show({ kind: "error", message: result.error ?? "没保存上，再试一次" });
      }
    });
  }

  /**
   * 「不用了」是永久的，所以它带一次撤销 —— 这个站的规矩是
   * 不弹确认框、直接执行并给撤销机会。撤销成功就把卡片放回来，
   * 否则用户点了撤销、什么都没发生，只能猜到底撤没撤掉。
   */
  function undoDecline() {
    startTransition(async () => {
      const result = await undoDeclinePasskeyNudgeAction();
      if (result.ok) {
        setDone(false);
        router.refresh();
      } else {
        toast.show({ kind: "error", message: result.error ?? "撤销失败，再试一次" });
      }
    });
  }

  return (
    <div className="inset-group animate-rise px-4 py-4">
      <p className="t-subhead flex items-start gap-2 font-medium">
        <Fingerprint
          className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]"
          strokeWidth={2}
          aria-hidden
        />
        <span className="min-w-0 flex-1">{title}</span>
      </p>

      <p className="t-caption mt-1.5 leading-relaxed text-[var(--ink-secondary)]">{body}</p>

      {/*
        * 按钮横向排、允许换行。
        *
        * 手机上三个按钮挤在 320px 宽的屏幕里会把文字压成两行，
        * flex-wrap 让它们自然掉到第二行，而不是各自变窄到点不准。
        * 每个都有 min-h-11（44px）—— 触摸目标不到这个尺寸的按钮，
        * 拇指按下去有一半概率落空。
        */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => void register()}
          className="t-footnote inline-flex min-h-11 items-center rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
          style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
        >
          {busy ? "等待验证…" : "现在就加"}
        </button>

        <button
          type="button"
          disabled={busy || pending}
          onClick={() => resolve(snoozePasskeyNudgeAction)}
          className="t-footnote inline-flex min-h-11 items-center px-3 text-[var(--ink-secondary)] transition active:opacity-60 disabled:opacity-45"
        >
          以后再说
        </button>

        {/* 和上面两个并排、同样大小 —— 藏起来的拒绝入口等于没有 */}
        <button
          type="button"
          disabled={busy || pending}
          onClick={() => resolve(declinePasskeyNudgeAction, undoDecline)}
          className="t-footnote inline-flex min-h-11 items-center px-3 text-[var(--ink-secondary)] transition active:opacity-60 disabled:opacity-45"
        >
          不用了
        </button>
      </div>

      {error && (
        <p className="t-caption2 mt-2 text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
