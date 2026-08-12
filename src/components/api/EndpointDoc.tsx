import type { Endpoint } from "@/lib/api-tokens/catalog";

/**
 * 一条端点的文档卡片。
 *
 * ─────────────────────────────────────────
 * 抽出来是因为它现在要出现在两个地方
 * ─────────────────────────────────────────
 *
 * 「你现在调得动的」和「还差权限的」长得一模一样，只多一行
 * 「缺哪个 scope」。抄两份的话，以后给文档加一个字段
 * （比如请求体示例）只会加在其中一份上，而另一份没人会想起来。
 */
export function EndpointDoc({
  endpoint,
  missing,
}: {
  endpoint: Endpoint;
  /** 缺哪几个 scope。空的话就是能调 */
  missing?: readonly string[];
}) {
  const blocked = (missing?.length ?? 0) > 0;

  return (
    <div className="inset-group px-3.5 py-3" style={{ opacity: blocked ? 0.62 : 1 }}>
      <p className="t-subhead font-medium">
        <span className="t-caption2 mr-1.5 rounded-[var(--radius-control)] bg-[var(--fill)] px-1.5 py-0.5 text-[var(--ink-secondary)]">
          {endpoint.method}
        </span>
        <code className="break-all">{endpoint.path}</code>
      </p>
      <p className="t-caption mt-1 text-[var(--ink-secondary)]">{endpoint.summary}</p>

      {blocked ? (
        /*
         * 说清楚**缺哪一个**，不是笼统一句「权限不够」。
         *
         * 笼统的话，人会去重新建一把令牌 —— 而新的那把
         * 同样不会勾上他缺的那一项，因为他不知道缺的是哪一项。
         */
        <p className="t-caption2 mt-1" style={{ color: "var(--warning)" }}>
          还差：{missing!.join("、")} —— 上面新建一把勾上这项就能调
        </p>
      ) : (
        endpoint.scopes.length > 0 && (
          <p className="t-caption2 mt-1 text-[var(--ink-quaternary)]">
            需要：{endpoint.scopes.join("、")}
          </p>
        )
      )}

      {endpoint.note && (
        <p className="t-caption2 mt-1 leading-relaxed text-[var(--ink-tertiary)]">
          {endpoint.note}
        </p>
      )}

      <pre className="t-caption2 mt-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-[var(--ink-secondary)]">
        {endpoint.example}
      </pre>
    </div>
  );
}
