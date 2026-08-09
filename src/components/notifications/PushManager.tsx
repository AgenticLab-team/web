"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { subscribePush, unsubscribePush } from "@/lib/notifications/push-actions";

/**
 * 推送订阅入口。
 *
 * 这个组件大部分代码在处理「不能用」的各种情形 —— 因为本站主力访问
 * 环境是微信内置浏览器，而那里 Web Push 基本不可用（iOS 微信完全没有）。
 * 铁律是**每一种不能用都要说出来**：
 * 静默失败的订阅按钮会让人以为自己订上了，从此安心地漏掉所有消息 ——
 * 那比从来没有这个功能糟糕得多。
 *
 * 状态判定都在 useEffect 里做：SSR 阶段没有 navigator，
 * 首帧渲染成「检测中」，水合后立刻收敛到真实状态。
 */

type Support =
  | { state: "checking" }
  | { state: "unsupported"; reason: string }
  | { state: "unconfigured" }
  | { state: "denied" }
  | { state: "ready"; subscribed: boolean };

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = window.atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export function PushManager({ vapidPublicKey }: { vapidPublicKey: string | null }) {
  const [support, setSupport] = useState<Support>({ state: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        // 最常见的一档：微信内置浏览器 / 未加到主屏的 iOS Safari
        setSupport({
          state: "unsupported",
          reason:
            "这个浏览器收不到推送（微信内置浏览器、没有安装到主屏幕的 iOS 都不支持）。" +
            "不用担心漏消息：打开网站就能即时收到站内提醒。",
        });
        return;
      }
      if (!vapidPublicKey) {
        setSupport({ state: "unconfigured" });
        return;
      }
      if (Notification.permission === "denied") {
        setSupport({ state: "denied" });
        return;
      }
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", {
          // 不吃 HTTP 缓存 —— 改了 sw.js 却被缓存住的表现是「有人收得到有人收不到」
          updateViaCache: "none",
        });
        const sub = await registration.pushManager.getSubscription();
        if (!cancelled) setSupport({ state: "ready", subscribed: Boolean(sub) });
      } catch {
        if (!cancelled) {
          setSupport({ state: "unsupported", reason: "推送组件初始化失败，请留意站内提醒。" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey]);

  async function subscribe() {
    if (!vapidPublicKey) return;
    setBusy(true);
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setSupport({ state: "denied" });
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });
      const result = await subscribePush(JSON.parse(JSON.stringify(sub)));
      if (!result.ok) {
        /*
         * 服务端没收下就把浏览器侧的订阅也退掉 ——
         * 留着会出现最坏的状态：浏览器认为已订阅、服务端根本不知道，
         * 界面显示「已开启」而实际一条都不会来。
         */
        await sub.unsubscribe();
        setError(result.error ?? "订阅失败");
        return;
      }
      setSupport({ state: "ready", subscribed: true });
      // 每类的「推送到设备」开关由服务端按订阅状态渲染 —— 刷新让它们出现
      router.refresh();
    } catch {
      setError("订阅失败，可以稍后再试；站内提醒不受影响");
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setSupport({ state: "ready", subscribed: false });
      router.refresh();
    } catch {
      setError("退订失败，可以稍后再试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-6">
      <h2 className="t-footnote px-1 font-medium uppercase tracking-wide text-[var(--ink-tertiary)]">
        设备推送
      </h2>
      <p className="t-caption mb-2 px-1 text-[var(--ink-quaternary)]">
        不打开网站也能在锁屏上收到提醒
      </p>

      <div className="inset-group">
        <div className="inset-row px-4 py-3">
          {support.state === "checking" && (
            <p className="t-caption text-[var(--ink-tertiary)]">正在检测这个浏览器支不支持…</p>
          )}

          {support.state === "unsupported" && (
            <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">{support.reason}</p>
          )}

          {support.state === "unconfigured" && (
            <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
              站点还没配置推送服务，目前只有站内提醒。这里如实告诉你，
              免得你以为自己订上了。
            </p>
          )}

          {support.state === "denied" && (
            <p className="t-caption leading-relaxed text-[var(--ink-tertiary)]">
              通知权限被浏览器拒绝了 —— 需要在系统或浏览器设置里解除后再来开启。
            </p>
          )}

          {support.state === "ready" && (
            <div className="flex items-center justify-between gap-3">
              <p className="t-body">
                {support.subscribed ? "这台设备正在接收推送" : "这台设备还没订阅推送"}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={support.subscribed ? unsubscribe : subscribe}
                className="t-subhead shrink-0 rounded-[var(--radius-control)] px-3.5 py-1.5 transition active:opacity-70 disabled:opacity-45"
                style={{
                  background: support.subscribed ? "var(--fill)" : "var(--accent)",
                  color: support.subscribed ? "var(--ink)" : "var(--accent-ink)",
                }}
              >
                {busy ? "处理中…" : support.subscribed ? "关闭推送" : "开启推送"}
              </button>
            </div>
          )}

          {error && (
            <p className="t-caption mt-2" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>
      </div>

      {support.state === "ready" && support.subscribed && (
        <p className="t-caption mt-2 px-1 leading-relaxed text-[var(--ink-quaternary)]">
          推送哪些类型，用上面每一类下面的「推送到设备」开关控制。
        </p>
      )}
    </section>
  );
}
