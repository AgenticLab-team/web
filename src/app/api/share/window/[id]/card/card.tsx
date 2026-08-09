import { attribution, clampContent, type ShareMessage } from "@/lib/share/rules";

/**
 * 群聊分享图的画面。
 *
 * ─────────────────────────────────────────
 * 为什么单独一个文件
 * ─────────────────────────────────────────
 *
 * route.tsx 要先过会话与群权限，测试进不去那一层，于是**画面本身
 * 从来没被真的画过一次**。而这张图恰恰就是在渲染那一步炸的：
 * 见下面「前面还有 N 条」那一段。把画面拆出来，测试就能拿真数据
 * 走一遍 ImageResponse，出不出得来图当场就知道。
 *
 * 这里只画，不查库 —— 尤其**不碰 groups**：
 * 「这条消息来自哪个群」比消息本身敏感得多，图上永远不出现群名。
 */
export function WindowCard({ shown, omitted }: { shown: ShareMessage[]; omitted: number }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#0b0b0d",
        padding: "48px 52px",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", flex: 1, gap: 18 }}>
        {omitted > 0 && (
          /*
           * 这一行**必须是一个完整字符串 + 显式 display**。
           *
           * 画图用的是 satori：`<div>` 只要有一个以上的子节点、
           * 又没写 display，它就直接抛错，整个响应 500。
           * 而 `…前面还有 {omitted} 条` 在 JSX 里正好是三个子节点
           * （两段文字 + 一个表达式）—— 于是**超过 12 条的对话
           * 一转发就是 500，12 条以内的照常出图**，
           * 症状看起来像「有时候能生成有时候不能」，很难往这里想。
           */
          <div style={{ display: "flex", color: "#6b6b73", fontSize: 22 }}>
            {`…前面还有 ${omitted} 条`}
          </div>
        )}
        {shown.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ color: "#8a8a94", fontSize: 22 }}>{m.senderName}</div>
            <div style={{ color: "#f2f2f5", fontSize: 30, lineHeight: 1.4 }}>
              {clampContent(m.content)}
            </div>
          </div>
        ))}
      </div>

      {/* 出处：让拿到图的人知道这是成员社区的内部内容，不是公开发布的东西 */}
      <div
        style={{
          display: "flex",
          borderTop: "1px solid #26262c",
          paddingTop: 20,
          marginTop: 24,
          color: "#6b6b73",
          fontSize: 22,
        }}
      >
        {attribution({ memberOnly: true })}
      </div>
    </div>
  );
}
