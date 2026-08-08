"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface StartResponse {
  code: string;
  expiresAt: number;
  fallbackAfterSeconds: number;
  groupPrefix: string;
}

type Phase =
  | { kind: "loading" }
  | { kind: "waiting"; data: StartResponse }
  | { kind: "not_member"; wxId: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

const BOT_NAME = "群猫娘";

export function BindFlow({ next }: { next?: string } = {}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [remaining, setRemaining] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [showFallback, setShowFallback] = useState(false);
  const [upstreamDown, setUpstreamDown] = useState(false);
  const [copied, setCopied] = useState<"code" | "group" | null>(null);
  // 渲染期间不能调 Date.now()：那是不纯的，同一次渲染重跑会得到不同结果。
  // 真正的起始时间在下面的 effect 里落
  const startedAt = useRef(0);

  const copy = useCallback(async (text: string, which: "code" | "group") => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Safari 在非安全上下文会拒绝 clipboard API，退回选中文本
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(which);
    setTimeout(() => setCopied(null), 1600);
  }, []);

  /*
   * 只负责取码，不碰 state —— 这样首次加载的 effect 里就没有同步 setState，
   * 也就不会触发级联渲染。重试按钮那条路才需要先把界面重置回 loading。
   */
  const requestCode = useCallback(async (): Promise<Phase> => {
    try {
      const res = await fetch("/api/auth/bind/start", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { kind: "error", message: body.error ?? "无法开始绑定" };
      }
      return { kind: "waiting", data: await res.json() };
    } catch {
      return { kind: "error", message: "网络异常，请重试" };
    }
  }, []);

  const start = useCallback(() => {
    setPhase({ kind: "loading" });
    setShowFallback(false);
    setElapsed(0);
    startedAt.current = Date.now();
    void requestCode().then(setPhase);
  }, [requestCode]);

  useEffect(() => {
    let cancelled = false;
    startedAt.current = Date.now();
    void requestCode().then((next) => {
      if (!cancelled) setPhase(next);
    });
    return () => {
      cancelled = true;
    };
  }, [requestCode]);

  // 倒计时，以及「遇到问题」入口的出现时机
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((phase.data.expiresAt - Date.now()) / 1000));
      setRemaining(left);
      const since = Math.floor((Date.now() - startedAt.current) / 1000);
      setElapsed(since);
      if (since >= phase.data.fallbackAfterSeconds) setShowFallback(true);
      if (left === 0) setPhase({ kind: "expired" });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase]);

  // 轮询绑定结果
  useEffect(() => {
    if (phase.kind !== "waiting") return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/auth/bind/status");
        if (cancelled) return;
        const body = await res.json();
        if (body.state === "upstream_down") {
          setUpstreamDown(true);
          return;
        }
        setUpstreamDown(false);
        if (body.state === "bound") {
          router.replace(body.next ?? next ?? "/");
        } else if (body.state === "not_member") {
          setPhase({ kind: "not_member", wxId: body.wxId });
        } else if (body.state === "expired") {
          setPhase({ kind: "expired" });
        }
      } catch {
        /* 网络抖动不打断流程，下一轮继续 */
      }
    };

    const id = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, router, next]);

  if (phase.kind === "loading") {
    return (
      <div className="h-64 animate-pulse rounded-[var(--radius-card)] bg-[var(--color-fill)]" />
    );
  }

  if (phase.kind === "error" || phase.kind === "expired") {
    const expired = phase.kind === "expired";
    return (
      <div className="animate-rise space-y-6 text-center">
        <p className="text-[17px] text-[var(--color-ink-secondary)]">
          {expired ? "验证码已过期" : phase.message}
        </p>
        <button
          onClick={start}
          className="w-full rounded-[var(--radius-control)] bg-[var(--color-accent)] px-6 py-3.5 text-[17px] font-medium text-[var(--color-accent-ink)] transition active:scale-[0.98]"
        >
          重新获取
        </button>
      </div>
    );
  }

  if (phase.kind === "not_member") {
    return (
      <div className="animate-rise space-y-5 text-center">
        <div className="text-[44px]">🚪</div>
        <h2 className="text-[22px] font-semibold tracking-tight">你还不是社群成员</h2>
        <p className="text-[15px] leading-relaxed text-[var(--color-ink-secondary)]">
          我们认出了你的微信，但你还不在任何一个已接入的群里。
          <br />
          现阶段只有群成员可以登录。
        </p>
        <button
          onClick={start}
          className="w-full rounded-[var(--radius-control)] bg-[var(--color-fill)] px-6 py-3.5 text-[17px] font-medium transition active:scale-[0.98]"
        >
          换个账号试试
        </button>
      </div>
    );
  }

  const { code, groupPrefix } = phase.data;
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, "0");

  return (
    <div className="animate-rise space-y-7">
      <div className="space-y-3 text-center">
        <p className="text-[13px] font-medium uppercase tracking-[0.08em] text-[var(--color-ink-tertiary)]">
          你的验证码
        </p>
        <button
          type="button"
          onClick={() => void copy(code, "code")}
          aria-label={`复制验证码 ${code.split("").join(" ")}`}
          className="tabular mx-auto flex justify-center gap-2.5 rounded-[var(--radius-card)] p-1 transition active:scale-[0.97]"
        >
          {code.split("").map((digit, i) => (
            <span
              key={i}
              className="flex h-14 w-11 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-surface)] text-[28px] font-semibold shadow-[var(--shadow-hairline)]"
            >
              {digit}
            </span>
          ))}
        </button>
        <p className="tabular text-[13px] text-[var(--color-ink-tertiary)]">
          {copied === "code" ? (
            <span className="text-[var(--color-success)]">已复制</span>
          ) : (
            <>
              轻点复制 · {minutes}:{seconds} 后失效
            </>
          )}
        </p>
      </div>

      {/*
        主通道：群里发。
        加好友已经触发微信风控，那条路实际走不通，所以不再引导。
        整句话直接做成一个可点复制的按钮 —— 让人自己照着抄「登录」两个字，
        总有人会漏掉前缀，然后卡在这里不知道为什么没反应。
      */}
      <div className="space-y-3">
        <p className="text-[15px] leading-relaxed">
          在<strong>任意一个有 {BOT_NAME} 的群</strong>里发送这句话：
        </p>
        <button
          type="button"
          onClick={() => void copy(`${groupPrefix} ${code}`, "group")}
          className="tabular flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface)] px-4 py-4 text-[19px] font-medium shadow-[var(--shadow-hairline)] transition active:scale-[0.98]"
        >
          <span>
            {groupPrefix} {code}
          </span>
          <span className="text-[13px] font-normal text-[var(--color-ink-tertiary)]">
            {copied === "group" ? "已复制" : "轻点复制整句"}
          </span>
        </button>
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-secondary)]">
          必须带上「{groupPrefix}」两个字，只发数字不算。
          <br />
          <strong>不要替别人发送验证码</strong> —— 那会把对方的登录会话绑定到你的身份上。
        </p>
      </div>

      <StatusLine upstreamDown={upstreamDown} elapsed={elapsed} />

      {/* 备用通道同样等 15 秒再出现：主通道通常几秒就成了，一上来给两个选择只会让人犹豫 */}
      {showFallback && (
        <details className="animate-rise">
          <summary className="cursor-pointer list-none text-center text-[15px] text-[var(--color-accent)] transition active:opacity-60">
            群里发不了？
          </summary>
          <div className="mt-4 space-y-3 rounded-[var(--radius-card)] bg-[var(--color-accent-soft)] p-4">
            <p className="text-[15px] leading-relaxed">
              如果你已经是 {BOT_NAME} 的好友，可以<strong>直接私聊</strong>发送这 6 位数字：
            </p>
            <button
              type="button"
              onClick={() => void copy(code, "code")}
              className="tabular flex w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface)] px-4 py-3 text-[19px] font-medium shadow-[var(--shadow-hairline)] transition active:scale-[0.98]"
            >
              <span>{code}</span>
              <span className="text-[13px] font-normal text-[var(--color-ink-tertiary)]">
                {copied === "code" ? "已复制" : "轻点复制"}
              </span>
            </button>
            <p className="text-[13px] leading-relaxed text-[var(--color-ink-secondary)]">
              私聊不需要带「{groupPrefix}」。
              <br />
              还不是好友的话请走群里那条 —— 机器人目前不方便频繁通过好友申请。
            </p>
          </div>
        </details>
      )}
    </div>
  );
}

function StatusLine({ upstreamDown, elapsed }: { upstreamDown: boolean; elapsed: number }) {
  if (upstreamDown) {
    return (
      <p className="text-center text-[13px] text-[var(--color-warning)]">
        与机器人的连接暂时中断，正在重试…
      </p>
    );
  }
  return (
    <p className="flex items-center justify-center gap-2 text-[13px] text-[var(--color-ink-secondary)]">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-accent)] opacity-60" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-accent)]" />
      </span>
      正在等待验证{elapsed > 30 ? "（可能需要几秒）" : ""}
    </p>
  );
}
