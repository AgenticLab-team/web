"use client";

import { Check, Copy, ImageDown, Link2, Share2 } from "lucide-react";
import { useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { panelStyles, useAnchoredPanel } from "@/components/ui/anchored";

/**
 * 分享。
 *
 * ─────────────────────────────────────────
 * 微信内置浏览器里剪贴板不一定能用
 * ─────────────────────────────────────────
 *
 * `navigator.clipboard` 需要安全上下文 + 用户手势，而微信的 webview
 * 在某些版本上直接不给。**失败时不能静默** —— 人以为复制上了，
 * 粘出来是空的，那比一开始就说「复制不了」糟得多。
 *
 * 所以三层：
 *   1. `navigator.share`（手机上最顺 —— 直接调起系统分享，可以选微信）
 *   2. `navigator.clipboard`
 *   3. 都不行就**把文本摊开**，让人自己长按全选
 *
 * 第三层是真正的兜底，不是装饰。没有它的话，在最需要分享的那个环境里
 * （微信）这个功能可能完全不工作。
 *
 * ─────────────────────────────────────────
 * 手机端电脑端是同一套
 * ─────────────────────────────────────────
 *
 * 不做「手机版分享」和「桌面版分享」两套 —— 能力检测走 API 是否存在，
 * 而不是猜屏幕宽度。桌面 Chrome 也有 navigator.share，
 * 而某些安卓浏览器没有。按屏幕宽度猜的话两边都会猜错。
 */
export function ShareSheet({
  url,
  text,
  imageUrl,
  label = "分享",
}: {
  /** 完整链接 —— 权限收口在链接后面，所以文案可以随便转 */
  url: string;
  /** 分享文案（含链接） */
  text: string;
  /** 分享图；没有就不显示那一项 */
  imageUrl?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"url" | "text" | null>(null);
  /** 剪贴板不可用时摊开原文让人自己选 */
  const [fallback, setFallback] = useState<string | null>(null);
  /*
   * 能不能调起系统分享。
   *
   * 服务端渲染时没有 navigator —— 直接读会让整棵树在水合时对不上，
   * 而水合失败的表现是「点了没反应」，最难查的一类。
   * useSyncExternalStore 就是为这种「服务端和客户端答案不同」准备的:
   * 服务端一律当成没有，到了浏览器再报真实值。
   */
  const canSystemShare = useSyncExternalStore(
    () => () => {},
    () => typeof navigator !== "undefined" && typeof navigator.share === "function",
    () => false,
  );
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /*
   * 和帖子的更多菜单用同一套定位。
   *
   * 那个菜单被回复挡住过 —— 成因是祖先的 transform 造出了层叠上下文，
   * 而 absolute 定位的面板出不去。这里如果原地 absolute，
   * 迟早在某个页面上撞到同一件事。
   */
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const anchored = useAnchoredPanel(open, anchorRef, panelRef, "end");

  const copy = async (value: string, which: "url" | "text") => {
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setFallback(null);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // 不装作成功 —— 摊开让人自己长按全选
      setFallback(value);
      setTimeout(() => areaRef.current?.select(), 0);
    }
  };

  const systemShare = async () => {
    try {
      await navigator.share({ text, url });
    } catch {
      // 用户取消也会抛，这里不当成错误 —— 弹个「复制失败」会很莫名其妙
    }
  };

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        className="tap-target flex items-center gap-1 rounded-full px-2 py-1.5 text-[var(--ink-tertiary)] transition active:opacity-50"
      >
        <Share2 className="h-4 w-4" strokeWidth={2} aria-hidden />
        <span className="t-caption">{label}</span>
      </button>

      {open &&
        anchored.mounted &&
        createPortal(
          <>
            {anchored.narrow && (
              <div
                className="animate-fade fixed inset-0 z-[90] bg-black/25"
                onPointerDown={() => setOpen(false)}
                aria-hidden
              />
            )}
            <div ref={panelRef} role="menu" {...panelStyles({ narrow: anchored.narrow, position: anchored.position })}>
          {canSystemShare && (
            <button
              type="button"
              role="menuitem"
              onClick={systemShare}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition active:opacity-60"
            >
              <Share2 className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
              <span className="t-subhead">发送到…</span>
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onClick={() => copy(url, "url")}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition active:opacity-60"
          >
            {copied === "url" ? (
              <Check className="h-4 w-4 shrink-0 text-[var(--success)]" strokeWidth={2.4} aria-hidden />
            ) : (
              <Link2 className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
            )}
            <span className="t-subhead">{copied === "url" ? "链接已复制" : "复制链接"}</span>
          </button>

          <button
            type="button"
            role="menuitem"
            onClick={() => copy(text, "text")}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition active:opacity-60"
          >
            {copied === "text" ? (
              <Check className="h-4 w-4 shrink-0 text-[var(--success)]" strokeWidth={2.4} aria-hidden />
            ) : (
              <Copy className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
            )}
            <span className="t-subhead">{copied === "text" ? "文案已复制" : "复制分享文案"}</span>
          </button>

          {imageUrl && (
            <a
              href={imageUrl}
              target="_blank"
              rel="noopener noreferrer"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 py-2.5 text-left transition active:opacity-60"
            >
              <ImageDown className="h-4 w-4 shrink-0 text-[var(--ink-tertiary)]" strokeWidth={2} aria-hidden />
              <span className="t-subhead">生成分享图</span>
            </a>
          )}

          {fallback && (
            <div className="border-t border-[var(--hairline)] p-2">
              {/*
                * 剪贴板不可用时的兜底。
                *
                * 微信 webview 上这不是罕见情况 —— 而「以为复制上了，
                * 粘出来是空的」比一开始就说复制不了糟得多。
                */}
              <p className="t-caption2 mb-1 text-[var(--ink-tertiary)]">
                这个浏览器不让自动复制 —— 长按全选下面的文字
              </p>
              <textarea
                ref={areaRef}
                readOnly
                value={fallback}
                rows={4}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full rounded-[var(--radius-control)] bg-[var(--fill)] px-2 py-1.5 text-[13px] leading-relaxed outline-none"
              />
            </div>
          )}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
