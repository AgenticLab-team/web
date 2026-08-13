"use client";

import { BellRing, Fingerprint, FolderGit2, MonitorSmartphone, Share } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { NudgeCard } from "@/components/home/NudgeCard";
import { pickNudge, type NudgeKind } from "@/lib/nudges/rules";

/**
 * 首页上那一个提示位。
 *
 * ═════════════════════════════════════════
 * 一次只出一个
 * ═════════════════════════════════════════
 *
 * 三件事（加 Passkey、装到桌面/主屏、开推送）想说，但三张卡片摞在
 * 首页上，头一屏就全是「你还没做这个」—— 而人打开首页是来看
 * 社区发生了什么的。
 *
 * 挑哪一个由 `lib/nudges/rules.ts` 决定（纯函数，单独测）。
 * 这里只负责**把这台设备的真实情况探出来**，然后渲染那一个。
 *
 * ═════════════════════════════════════════
 * 能力探测只能在 useEffect 里做
 * ═════════════════════════════════════════
 *
 * `navigator` / `matchMedia` / `localStorage` 在服务端都没有。
 * 在渲染里判会 hydration 报错，而且首帧那个答案一定是错的。
 * 所以首帧什么都不渲染，水合之后再决定 —— 这一位本来就不该抢
 * 第一眼的注意力，晚半拍出现反而正好。
 */

/** 每种提示单独的「不再提示」，按设备记 —— 订阅和安装都是按设备的 */
const OFF_KEY = "home-nudge-off";
/** 上一次在这块区域表态的时间，按设备记 */
const LAST_KEY = "home-nudge-last";

function readOff(): NudgeKind[] {
  try {
    const raw = localStorage.getItem(OFF_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function HomeNudge({
  passkeyEligible,
  githubEligible = false,
  pushConfigured,
}: {
  /** 服务端算好的：这个账号该不该提示加 Passkey */
  passkeyEligible: boolean;
  /** 服务端算好的：站点配了 GitHub OAuth 且这个人还没绑 */
  githubEligible?: boolean;
  /** 站点配了推送吗 —— 没配就别提，那会是一个做不到的按钮 */
  pushConfigured: boolean;
}) {
  const router = useRouter();
  /*
   * 一个 state 装完整个结论，而不是 kind / iosInstall 两个各自 set。
   *
   * 分成两个的话，effect 里要同步 setState 两次（eslint 的
   * `set-state-in-effect` 正是在拦这个），而且中间会有一帧
   * 「kind 已经变了、iosInstall 还是旧的」—— 那一帧渲染出来的是
   * 一张文案对不上图标的卡片。
   */
  const [view, setView] = useState<{ kind: NudgeKind; iosInstall: boolean } | null>(null);

  /*
   * 安装事件放 ref 不放 state：它只是「能不能装」的一个凭据，
   * 本身不参与渲染。放 state 会让 effect 因为它变化再跑一轮，
   * 而那一轮又可能再 setState —— 绕出一个没必要的环。
   */
  const installRef = useRef<{ prompt: () => void } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;

    /*
     * `beforeinstallprompt` 只在**能装**的时候触发（Chrome / Edge 系）。
     * 它可能比这次探测晚到，所以到达时 bump 一下 tick 重算一遍。
     */
    const onPrompt = (e: Event) => {
      e.preventDefault();
      installRef.current = {
        prompt: () => void (e as unknown as { prompt: () => void }).prompt(),
      };
      setTick((n) => n + 1);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);

    const standalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // iOS Safari 用的是这个非标准属性
      (navigator as { standalone?: boolean }).standalone === true;

    const hasPushApi =
      "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    /*
     * 微信内置浏览器里加到主屏也收不到推送 —— 这时候提示安装是骗人。
     * 这条口径和推送设置页那边保持一致。
     */
    const wechat = /MicroMessenger/i.test(navigator.userAgent);
    const needsIosInstall = ios && !wechat && !standalone && !hasPushApi;
    const denied = hasPushApi && Notification.permission === "denied";

    let lastActionAt: number | null = null;
    try {
      const raw = localStorage.getItem(LAST_KEY);
      lastActionAt = raw ? Number(raw) : null;
    } catch {
      lastActionAt = null;
    }

    void (async () => {
      let subscribed = false;
      if (hasPushApi) {
        try {
          const reg = await navigator.serviceWorker.getRegistration();
          subscribed = Boolean(await reg?.pushManager.getSubscription());
        } catch {
          subscribed = false;
        }
      }
      if (cancelled) return;

      const kind = pickNudge({
        passkeyEligible,
      githubEligible,
        canInstall: needsIosInstall || installRef.current !== null,
        installed: standalone,
        canPush: pushConfigured && hasPushApi && !denied,
        pushSubscribed: subscribed,
        iosNeedsInstall: needsIosInstall,
        dismissed: readOff(),
        lastActionAt,
        now: Date.now(),
      });

      setView(kind ? { kind, iosInstall: needsIosInstall } : null);
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeinstallprompt", onPrompt);
    };
  }, [passkeyEligible, githubEligible, pushConfigured, tick]);

  /** 表过态：记下时间（整块安静几天），并收起当前这张 */
  const act = useCallback((off?: NudgeKind) => {
    try {
      localStorage.setItem(LAST_KEY, String(Date.now()));
      if (off) {
        localStorage.setItem(OFF_KEY, JSON.stringify([...new Set([...readOff(), off])]));
      }
    } catch {
      /* 隐私模式下 localStorage 会抛 —— 收起来就够了，不必让它崩 */
    }
    setView(null);
  }, []);

  const kind = view?.kind ?? null;
  const iosInstall = view?.iosInstall ?? false;

  if (kind === null) return null;

  if (kind === "github") {
    return (
      <NudgeCard
        icon={<FolderGit2 className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
        title="把你的 GitHub 接上来"
        body={
          <>
            接上之后，你的公开项目会出现在个人主页和<strong>项目目录</strong>里，
            群里的人能看见你在做什么。
            <br />
            {/*
              * 把「申请了什么权限」写在按钮上面，不写在授权之后。
              *
              * 这是整张卡片最要紧的一句：它会把人送去 github.com 点「授权」，
              * 而绝大多数人在那一页上是不看的。scope 为空这件事
              * 要在他离开这个站之前就知道 —— 事后再说等于没说。
              */}
            申请的权限是<strong>空的</strong> —— 只读公开信息，
            碰不到私有仓库，也发不了任何东西。
          </>
        }
        actions={[
          {
            label: "去连接",
            primary: true,
            // 带上 return：授权完回到首页，而不是把人扔在设置页
            href: "/api/auth/github/start?return=/",
            // 记一下「表过态了」，导航由那个 href 负责
            onClick: () => act(),
          },
          { label: "以后再说", onClick: () => act() },
          { label: "不用了", onClick: () => act("github") },
        ]}
      />
    );
  }

  if (kind === "passkey") {
    return (
      <NudgeCard
        icon={<Fingerprint className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
        title="给这个账号加一把 Passkey"
        body={
          <>
            下次用指纹或面容一步进来，不必再回微信取验证码。
            <br />
            换手机、清缓存之后，它也还是能把你放进来。
          </>
        }
        actions={[
          {
            label: "去设置",
            primary: true,
            onClick: () => {
              act();
              router.push("/me/security");
            },
          },
          { label: "以后再说", onClick: () => act() },
          { label: "不用了", onClick: () => act("passkey") },
        ]}
      />
    );
  }

  if (kind === "install") {
    return (
      <NudgeCard
        icon={
          iosInstall ? (
            <Share className="h-4 w-4" strokeWidth={2.2} aria-hidden />
          ) : (
            <MonitorSmartphone className="h-4 w-4" strokeWidth={2.2} aria-hidden />
          )
        }
        title={iosInstall ? "在 iPhone 上收通知，要先加到主屏" : "把这个站装到桌面"}
        body={
          iosInstall ? (
            <>
              这是 iOS 的限制：只有加到主屏幕的网站才收得到推送。
              点底部的分享按钮 →「添加到主屏幕」，之后从主屏打开这个站，
              就能开推送了。
            </>
          ) : (
            <>装完像个独立应用：有自己的窗口和图标，不用在一堆标签页里找它。</>
          )
        }
        actions={
          iosInstall
            ? [
                { label: "知道了", primary: true, onClick: () => act() },
                { label: "不用了", onClick: () => act("install") },
              ]
            : [
                {
                  label: "装上",
                  primary: true,
                  onClick: () => {
                    installRef.current?.prompt();
                    act();
                  },
                },
                { label: "以后再说", onClick: () => act() },
                { label: "不用了", onClick: () => act("install") },
              ]
        }
      />
    );
  }

  return (
    <NudgeCard
      icon={<BellRing className="h-4 w-4" strokeWidth={2.2} aria-hidden />}
      title="这台设备还没开推送"
      body={
        <>
          开了之后，被 @、被回复时手机会响一下，不用一直回来看。
          <br />
          推送是按设备记的 —— 换台电脑要再开一次。
        </>
      }
      actions={[
        {
          label: "去开启",
          primary: true,
          onClick: () => {
            act();
            router.push("/me/notifications");
          },
        },
        { label: "以后再说", onClick: () => act() },
        { label: "不用了", onClick: () => act("push") },
      ]}
    />
  );
}
