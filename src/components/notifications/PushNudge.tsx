"use client";

import { BellRing, Share, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * 「这台设备还没开推送」的提示。
 *
 * ─────────────────────────────────────────
 * 推送开关藏在设置页的第三屏
 * ─────────────────────────────────────────
 *
 * `PushManager` 做得很完整，而它只出现在「我的 → 通知设置」里 ——
 * 一个人得先想到有这个功能、再找到那一页，才会看到它。
 * 于是这个功能对绝大多数人等于不存在。
 *
 * ─────────────────────────────────────────
 * 三条硬规矩
 * ─────────────────────────────────────────
 *
 * **一、用不了的地方一个字都不提。**
 * 这个站主力环境是微信内置浏览器，那里 Web Push 根本没有。
 * 在那里劝人「开启推送」，点下去什么都不会发生 ——
 * 那比没有这个提示糟糕得多。
 *
 * **二、关掉就是永久关掉。**
 * 订阅是**按设备**的，所以「关掉」也记在这台设备上（localStorage）。
 * 一个关不掉的提示会把整块区域变成人眼自动跳过的地方，
 * 连带旁边真正重要的东西一起。
 *
 * **三、不主动弹权限框。**
 * 渲染时就调 `Notification.requestPermission()` 的话，
 * 浏览器会把它记成一次「未经请求的打扰」，之后**再也不给弹**——
 * 一次性把这台设备的推送永久废掉。所以只有点了按钮才弹。
 */

type State =
  | { kind: "hidden" }
  /** 能开，但这台设备还没开 */
  | { kind: "offer" }
  /** iOS Safari：得先加到主屏才有推送这回事 */
  | { kind: "ios-install" };

const DISMISS_KEY = "push-nudge-dismissed";

export function PushNudge({ configured }: { configured: boolean }) {
  const [state, setState] = useState<State>({ kind: "hidden" });

  useEffect(() => {
    /*
     * 全部判定放在 effect 里。
     *
     * 服务端没有 navigator，也不知道这台设备订没订过 ——
     * 在渲染里判会 hydration 报错，而且首帧那个答案一定是错的。
     */
    let cancelled = false;

    (async () => {
      if (!configured) return;
      if (localStorage.getItem(DISMISS_KEY) === "1") return;

      const standalone =
        window.matchMedia?.("(display-mode: standalone)").matches ||
        // iOS Safari 用的是这个非标准属性
        (navigator as { standalone?: boolean }).standalone === true;

      const hasPush = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

      if (!hasPush) {
        /*
         * iOS 上没有这几个 API，有两种原因，要分开：
         *
         * · 在 Safari 里直接打开 —— 加到主屏之后就有了，值得说一句
         * · 在微信里打开 —— 加到主屏也没有，说了等于骗人
         */
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
        const wechat = /MicroMessenger/i.test(navigator.userAgent);
        if (ios && !wechat && !standalone && !cancelled) setState({ kind: "ios-install" });
        return;
      }

      if (Notification.permission === "denied") return;

      // 已经订过就不提 —— 「订阅在不在」问浏览器，不问我们自己的库：
      // 用户可能在系统设置里把它撤了，而那一步不会通知服务端
      const registration = await navigator.serviceWorker.getRegistration();
      const existing = await registration?.pushManager.getSubscription();
      if (!existing && !cancelled) setState({ kind: "offer" });
    })().catch(() => {
      // 探测失败就当没有这回事 —— 提示是锦上添花，不值得为它报错
    });

    return () => {
      cancelled = true;
    };
  }, [configured]);

  if (state.kind === "hidden") return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setState({ kind: "hidden" });
  };

  return (
    <div className="mb-4 flex items-start gap-3 rounded-[var(--radius-card)] bg-[var(--accent-soft)] p-3.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-ink)]">
        {state.kind === "ios-install" ? (
          <Share className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        ) : (
          <BellRing className="h-4 w-4" strokeWidth={2.2} aria-hidden />
        )}
      </span>

      <div className="min-w-0 flex-1">
        {state.kind === "ios-install" ? (
          <>
            <p className="t-subhead font-medium">在 iPhone 上收通知，要先加到主屏</p>
            <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
              这是 iOS 的限制：只有加到主屏幕的网站才收得到推送。
              点底部的分享按钮 → 「添加到主屏幕」，之后从主屏打开这个站，
              这里就会出现开启推送的按钮。
            </p>
          </>
        ) : (
          <>
            <p className="t-subhead font-medium">这台设备还没开推送</p>
            <p className="t-caption mt-1 leading-relaxed text-[var(--ink-secondary)]">
              开了之后，被 @、被回复时手机会响一下，不用一直回来看。
              推送是按设备记的 —— 换台电脑要再开一次。
            </p>
            <Link
              href="/me/notifications"
              className="t-caption mt-2 inline-flex min-h-9 items-center rounded-[var(--radius-control)] bg-[var(--accent)] px-3.5 font-medium text-[var(--accent-ink)] transition active:scale-[0.97]"
            >
              去开启
            </Link>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={dismiss}
        aria-label="不再提示"
        title="不再提示"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--ink-tertiary)] transition hover:bg-[var(--fill)] active:scale-90"
      >
        <X className="h-4 w-4" strokeWidth={2.2} aria-hidden />
      </button>
    </div>
  );
}
