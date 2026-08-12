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

/**
 * 每一步都要有超时。
 *
 * ═════════════════════════════════════════
 * 「一直显示设置中」是这个组件真正的病
 * ═════════════════════════════════════════
 *
 * 站长报的是「同意之后一直卡在设置中」——**电脑和手机都是**。
 * 查下去发现这条路上每一个 await 都可能永远不返回，而没有一个有超时：
 *
 *   · `navigator.serviceWorker.ready` —— 这是最典型的一个。
 *     它只在有一个**已激活**的 SW 时才 resolve；注册卡在 installing、
 *     或者上一版 SW 变成 redundant，它就**永远挂着，不 reject**。
 *   · `pushManager.subscribe()` —— 推送服务不可达时会长时间无响应
 *     （国内网络下 FCM 尤其容易）
 *   · 服务端 action —— 网络断了就一直等
 *
 * 而挂住的表现是按钮永远写着「处理中…」：没有报错、没有兜底、
 * **也没有任何东西能让人说出是哪一步挂的**。
 *
 * 所以每一步单独计时，超时后说清是哪一步。
 */
const STEP_TIMEOUT_MS = {
  /* SW 激活：正常是毫秒级，10 秒还没好就是卡住了 */
  ready: 10_000,
  /* 要打推送服务，给宽一点 */
  subscribe: 20_000,
  /* 我们自己的服务端 */
  save: 15_000,
} as const;

class StepTimeout extends Error {
  constructor(readonly step: string) {
    super(`${step}：等太久没有响应`);
    this.name = "StepTimeout";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, step: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeout(step)), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * 把异常变成一句**能照着查**的话。
 *
 * 原来这里是 `catch { setError("订阅失败，可以稍后再试") }` ——
 * 异常对象被整个丢掉了。于是线上出问题时，用户说不出发生了什么，
 * 我们也查不出来：**唯一的信息就是那句我们自己写死的话**。
 */
function describeError(e: unknown): string {
  if (e instanceof StepTimeout) {
    return `卡在「${e.step}」这一步，超时了。换个网络或稍后再试；站内提醒不受影响`;
  }
  if (e instanceof Error) {
    // NotAllowedError / InvalidStateError / AbortError 这些名字是能搜的
    return `${e.name}：${e.message}`;
  }
  return String(e);
}

/**
 * 拿到一个**已经激活**的 Service Worker 注册。
 *
 * 不用 `navigator.serviceWorker.ready`：那个 promise 在 SW 始终没能激活时
 * **永远挂着且不 reject** —— 站长看到的「一直显示设置中」就是它。
 *
 * 这里改成自己盯 `statechange`：
 *   · 已经 active 了 → 直接用
 *   · 还在 installing / waiting → 等它变成 activated
 *   · 变成 redundant → **立刻报错**（说明安装失败了，等下去没有意义）
 *
 * 最后那一条是 `ready` 永远给不了的：它对 redundant 的反应也是继续等。
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  // register 是幂等的：已经注册过就返回现有那个
  const registration = await navigator.serviceWorker.register("/sw.js", {
    updateViaCache: "none",
  });
  if (registration.active) return registration;

  const worker = registration.installing ?? registration.waiting;
  if (!worker) {
    // 既没有 active 也没有在装 —— 这个状态本身就不对，别默默等下去
    throw new Error("Service Worker 没有注册成功");
  }

  await new Promise<void>((resolve, reject) => {
    const onChange = () => {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onChange);
        resolve();
      } else if (worker.state === "redundant") {
        worker.removeEventListener("statechange", onChange);
        reject(new Error("Service Worker 安装失败（redundant）"));
      }
    };
    worker.addEventListener("statechange", onChange);
    // 监听器挂上之前就可能已经到位了，补判一次
    onChange();
  });

  return registration;
}

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
        /*
         * 这里只注册、不等激活：首屏不该被 SW 的安装过程挡住。
         * 「有没有订阅」用注册对象直接问，拿不到就当没订阅。
         */
        const registration = await navigator.serviceWorker.register("/sw.js", {
          // 不吃 HTTP 缓存 —— 改了 sw.js 却被缓存住的表现是「有人收得到有人收不到」
          updateViaCache: "none",
        });
        const sub = await registration.pushManager.getSubscription();
        if (!cancelled) setSupport({ state: "ready", subscribed: Boolean(sub) });
      } catch (e) {
        if (!cancelled) {
          setSupport({
            state: "unsupported",
            // 带上真实原因：「初始化失败」四个字查不出任何东西
            reason: `推送组件初始化失败（${describeError(e)}），请留意站内提醒。`,
          });
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
      const registration = await withTimeout(
        activeRegistration(),
        STEP_TIMEOUT_MS.ready,
        "等待推送组件就绪",
      );

      /*
       * 已经有订阅时**先退掉再订**。
       *
       * 站点换过 VAPID 公钥的话，旧订阅的 applicationServerKey 和新的对不上，
       * 这时 `subscribe()` 会抛 InvalidStateError —— 而那条报错在旧代码里
       * 被 `catch {}` 吃掉了，界面上只剩「处理中…」。
       * 退掉重订是唯一能自愈的走法。
       */
      const existing = await registration.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();

      const sub = await withTimeout(
        registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
        }),
        STEP_TIMEOUT_MS.subscribe,
        "向推送服务申请订阅",
      );
      const result = await withTimeout(
        subscribePush(JSON.parse(JSON.stringify(sub))),
        STEP_TIMEOUT_MS.save,
        "把订阅存到服务器",
      );
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
    } catch (e) {
      // 把真实原因说出来 —— 吞掉异常等于让线上问题永远查不出来
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    setBusy(true);
    setError(null);
    try {
      const registration = await withTimeout(
        activeRegistration(),
        STEP_TIMEOUT_MS.ready,
        "等待推送组件就绪",
      );
      const sub = await registration.pushManager.getSubscription();
      if (sub) {
        await withTimeout(unsubscribePush(sub.endpoint), STEP_TIMEOUT_MS.save, "告诉服务器退订");
        await sub.unsubscribe();
      }
      setSupport({ state: "ready", subscribed: false });
      router.refresh();
    } catch (e) {
      setError(describeError(e));
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
