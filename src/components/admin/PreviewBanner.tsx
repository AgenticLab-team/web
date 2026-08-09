import { currentPreview } from "@/lib/auth/session";
import { exitPreviewAction } from "@/lib/rbac/preview-actions";
import { getPermission } from "@/lib/rbac/permissions";
import { resolveDisplayName } from "@/lib/users/display-name";

/**
 * 预览态的常驻横幅。
 *
 * ─────────────────────────────────────────
 * 它不可关闭，这是故意的
 * ─────────────────────────────────────────
 *
 * 这个横幅唯一的作用是回答一个问题：**「我现在看到的是谁的视角？」**
 * 而这个问题只在人忘了自己在预览时才要紧 —— 也正是那时候，
 * 一个可以关掉的提示已经被关掉了。
 *
 * 所以：固定在顶部、红色、每一页都在、没有关闭按钮，
 * 而且给页面留出等高的空档 —— 悬浮着盖住内容的横幅，
 * 人会本能地想办法让它消失。
 *
 * ─────────────────────────────────────────
 * 「少了哪些权限」必须说出来
 * ─────────────────────────────────────────
 *
 * 预览的权限是「他的 ∩ 我的」。如果他有几项我没有，
 * 那我看到的视角就是**不完整**的 —— 而我很可能正拿它下结论。
 * 不说出来的话，这个功能就成了「故障伪装成业务结果」的又一例：
 * 页面看着好好的，结论是错的。
 */
export async function PreviewBanner() {
  const preview = await currentPreview();
  if (!preview) return null;

  const name = resolveDisplayName(
    [preview.subject.siteNickname, preview.subject.wxNickname],
    { wxId: preview.subject.wxId, fallback: "这个人" },
  );

  return (
    <>
      {/* 等高占位：横幅是 fixed 的，不留空档会盖住第一屏内容 */}
      <div className="h-[var(--preview-banner-h,3.25rem)]" aria-hidden />

      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 top-0 z-[100] border-b border-[#7f1d1d] bg-[#b91c1c] text-white shadow-lg"
        style={{ ["--preview-banner-h" as string]: "3.25rem" }}
      >
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
          <span
            className="inline-flex h-5 shrink-0 items-center rounded-sm bg-white/20 px-1.5 text-[11px] font-semibold tracking-wide"
            aria-hidden
          >
            预览
          </span>

          <p className="t-subhead min-w-0 flex-1 leading-snug">
            你正在以 <strong className="font-semibold">{name}</strong> 的身份浏览 ——
            <span className="opacity-90"> 只读，任何操作都不会真的执行。</span>
          </p>

          {preview.withheld.length > 0 && (
            <details className="min-w-0 basis-full text-[12px] leading-relaxed text-white/85 sm:basis-auto">
              <summary className="cursor-pointer underline decoration-white/40 underline-offset-2">
                他有 {preview.withheld.length} 项权限你没有，这个视角不完整
              </summary>
              <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                {preview.withheld.map((key) => (
                  <li key={key}>{getPermission(key)?.label ?? key}</li>
                ))}
              </ul>
            </details>
          )}

          <span className="t-caption shrink-0 tabular-nums text-white/75">剩 {preview.minutesLeft} 分钟</span>

          <form action={exitPreviewAction} className="shrink-0">
            <button
              type="submit"
              className="rounded-md bg-white px-2.5 py-1 text-[13px] font-medium text-[#b91c1c] transition-opacity hover:opacity-85 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              退出预览
            </button>
          </form>
        </div>
      </div>
    </>
  );
}
