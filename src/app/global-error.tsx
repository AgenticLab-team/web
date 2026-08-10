"use client";

/**
 * 根布局自己出错时的兜底。
 *
 * ─────────────────────────────────────────
 * 它和 error.tsx 不是一回事
 * ─────────────────────────────────────────
 *
 * `error.tsx` 挂在根布局**里面** —— 布局本身炸了的话它跟着一起炸，
 * 于是又回到 Next 自带的那一屏。
 *
 * 这一层替换的是整个 `<html>`，所以必须自带 html / body 标签，
 * 也**用不上任何全局样式**（globals.css 是根布局引进来的，
 * 而根布局此刻正是坏掉的那个）。
 *
 * 所以这里的样式全部内联。丑一点没关系 —— 它一年也未必出现一次，
 * 出现的时候唯一的要求是「能看懂、点得动」。
 *
 * 中文和主题色也一并内联：这一屏是很多人对故障的唯一印象，
 * 让它至少还是这个站的样子。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem 1.5rem",
          background: "#f5f5f3",
          color: "#1a1a1a",
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        }}
      >
        <main style={{ maxWidth: "26rem", width: "100%" }}>
          <p style={{ fontSize: "0.9375rem", color: "#b3261e", margin: 0 }}>整站出错</p>
          <h1 style={{ fontSize: "1.75rem", lineHeight: 1.21, margin: "0.25rem 0 0" }}>
            站点没能加载
          </h1>
          <p style={{ fontSize: "1.0625rem", lineHeight: 1.47, color: "#5a5a5a" }}>
            这是站里的问题，不是你操作的问题。稍后再试，或者把下面的编号发给管理员。
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              minHeight: "2.75rem",
              padding: "0 1.25rem",
              marginTop: "1.5rem",
              border: 0,
              borderRadius: "0.625rem",
              background: "#1a1a1a",
              color: "#fff",
              fontSize: "0.9375rem",
              fontWeight: 500,
            }}
          >
            重新加载
          </button>

          {error.digest && (
            <p style={{ fontSize: "0.75rem", color: "#8a8a8a", marginTop: "2rem" }}>
              出错编号 <code>{error.digest}</code>
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
