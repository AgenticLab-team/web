"use client";

import { Download, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * 「下载我的全部数据」的按钮与状态。
 *
 * ─────────────────────────────────────────
 * 为什么用 fetch 而不是一个 <a download>
 * ─────────────────────────────────────────
 *
 * `<a download>` 点下去之后这个页面就再也不知道发生了什么：
 * 生成要跑几十秒，浏览器在那期间不给任何提示，
 * 而失败（限流、超时）只会变成一个下载栏里的红字。
 * 站长要的是「不要点一下没反应」，所以状态得由这个组件自己拿着。
 *
 * 代价是响应体会先在**浏览器**内存里攒成一个 Blob。
 * 这个取舍是清醒做的：吃不消的那一侧是服务器（3.7G，还跑着别的），
 * 而服务端那条路是从头到尾流式的；浏览器攒几十兆没有任何问题。
 */
export function DataExportPanel({ willTruncate }: { willTruncate: boolean }) {
  const [withContext, setWithContext] = useState(true);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function download() {
    setState("working");
    setMessage(null);

    try {
      const response = await fetch(`/api/me/export${withContext ? "" : "?context=0"}`, {
        credentials: "same-origin",
      });

      if (!response.ok) {
        /*
         * 限流的那句话是服务端写的，原样显示。
         * 换成「导出失败，请重试」的话，用户会立刻再点一次 ——
         * 而他要做的恰恰是等一会儿。
         */
        const text = await response.text();
        setState("error");
        setMessage(text.trim() || `导出失败（${response.status}）`);
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // 文件名以服务端的 Content-Disposition 为准，这里只是兜底
      link.download = "我的数据.zip";
      link.click();
      // 不撤销的话这份几十兆的副本会一直挂在页面上直到刷新
      URL.revokeObjectURL(url);

      setState("done");
      setMessage(`已下载 ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
    } catch {
      setState("error");
      setMessage("网络中断了，稍后再试一次");
    }
  }

  const working = state === "working";

  return (
    <div>
      <div className="inset-group">
        <div className="inset-row flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="t-body">包含上下文</p>
            <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-tertiary)]">
              附上你每段发言前后的群内对话。里面会有别人说的话（已换成
              <span className="tabular"> p1 </span>
              这样的代号）。关掉就只导你自己发的。
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={withContext}
            aria-label="包含上下文"
            disabled={working}
            onClick={() => setWithContext(!withContext)}
            className="relative mt-0.5 h-[31px] w-[51px] shrink-0 rounded-full transition disabled:opacity-45"
            style={{
              background: withContext ? "var(--success)" : "var(--fill-strong, var(--fill))",
            }}
          >
            <span
              className="switch-knob absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-sm"
              style={{ transform: withContext ? "translateX(20px)" : "translateX(0)" }}
            />
          </button>
        </div>
      </div>

      <button
        type="button"
        disabled={working}
        onClick={download}
        className="t-subhead mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-[var(--accent)] px-4 font-medium text-[var(--accent-ink)] transition active:scale-[0.98] disabled:opacity-45"
      >
        {working ? (
          <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden />
        ) : (
          <Download className="h-4 w-4" strokeWidth={2} aria-hidden />
        )}
        {working ? "正在打包，别关这个页面…" : "下载我的数据（zip）"}
      </button>

      {/* 生成要跑一会儿，一个不动的按钮会让人以为点漏了 */}
      <p
        role="status"
        aria-live="polite"
        className="t-caption mt-2 px-1 leading-relaxed"
        style={{ color: state === "error" ? "var(--danger)" : "var(--ink-tertiary)" }}
      >
        {message ??
          (working
            ? "正在打包，消息多的话要几十秒"
            : willTruncate
              ? "你的消息很多，这次只会导出最近的那一批，具体数字写在包里的 manifest.json"
              : "每半小时可以导一次，一天最多三次")}
      </p>
    </div>
  );
}
