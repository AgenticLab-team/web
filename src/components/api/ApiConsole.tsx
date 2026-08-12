"use client";

import { Play } from "lucide-react";
import { useState } from "react";

/**
 * 在线试一下。
 *
 * ═════════════════════════════════════════
 * 它必须走**真正那条路**
 * ═════════════════════════════════════════
 *
 * 从浏览器直接 `fetch` 到 `/api/v1/...`，带上用户粘进来的令牌 ——
 * 和他在自己机器上 curl 走的是同一条路：同一个鉴权、同一套限流、
 * 同一份留痕。
 *
 * 做成「服务端替他调一次」会舒服很多（不用他粘令牌），
 * 但那就变成了**另一条路**：绕过了 Authorization 头、
 * 绕过了令牌校验，于是这个控制台能跑通、他的脚本跑不通，
 * 而他会以为是自己写错了。
 *
 * ═════════════════════════════════════════
 * 发消息那一栏要说清楚它是真的会发出去
 * ═════════════════════════════════════════
 *
 * 这不是沙箱。点下去，一千六百人的群里就真的多一条消息。
 */

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  summary: string;
  scopes: string[];
  sampleBody?: Record<string, unknown>;
}

/**
 * 路径里的占位符，比如 `/posts/{id}/replies` → `["id"]`。
 *
 * ─────────────────────────────────────────
 * 第一版只认得 `{conv_id}` 一种
 * ─────────────────────────────────────────
 *
 * 于是 `/posts/{id}/replies` 这条在控制台里发出去的 URL 里
 * **原样带着 `{id}` 这五个字符** —— 服务端拿到的 id 就叫「{id}」，
 * 回一句 404，而人看不出哪里错了：他填了令牌、选了端点、写了请求体，
 * 三样都对。站长的原话是「post 没法填写参数」。
 *
 * 现在从路径里数出来，有几个占位符就给几个输入框 ——
 * 以后新加端点也不用再改这里。
 */
function placeholdersOf(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

/** 占位符叫什么名字，就给一句人话的提示 */
const ARG_HINT: Record<string, { label: string; placeholder: string }> = {
  conv_id: { label: "群的 conv_id", placeholder: "先调 GET /api/v1/groups 拿" },
  id: { label: "帖子 id", placeholder: "先调 GET /api/v1/posts 拿" },
};

/** 同一个路径上 GET 和 POST 是两条端点，所以 key 要带上方法 */
function keyOf(e: Endpoint | undefined): string {
  return e ? `${e.method} ${e.path}` : "";
}

export function ApiConsole({ endpoints }: { endpoints: Endpoint[] }) {
  const [token, setToken] = useState("");
  /*
   * 用 `方法 空格 路径` 当 key，不是光用路径。
   *
   * 同一个路径上 GET 和 POST 是两条不同的端点（读群公告 / 改群公告），
   * 光按路径找会永远选中头一条 —— 于是选「改群公告」实际发出去的是 GET。
   */
  const [chosen, setChosen] = useState(keyOf(endpoints[0]));
  const [args, setArgs] = useState<Record<string, string>>({});
  // 首屏也要有例子 —— 空框和「填错了」在人眼里是同一件事
  const [body, setBody] = useState(
    endpoints[0]?.sampleBody ? JSON.stringify(endpoints[0].sampleBody, null, 2) : "",
  );
  const [result, setResult] = useState<{ status: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const endpoint = endpoints.find((e) => keyOf(e) === chosen);
  const needed = endpoint ? placeholdersOf(endpoint.path) : [];
  const isWrite = endpoint?.method === "POST";

  /* 有占位符没填就别让他发 —— 发出去只会拿到一句看不懂的 404 */
  const missing = needed.filter((name) => !(args[name] ?? "").trim());

  const url = needed.reduce(
    (acc, name) => acc.replace(`{${name}}`, encodeURIComponent((args[name] ?? "").trim())),
    endpoint?.path ?? "",
  );

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(url, {
        method: endpoint?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token.trim()}`,
          ...(isWrite ? { "Content-Type": "application/json" } : {}),
        },
        body: isWrite ? body : undefined,
      });
      const text = await response.text();
      /*
       * 能格式化就格式化。返回体大多是 JSON，而一行糊在一起的 JSON
       * 在手机上基本没法读 —— 这一页存在的意义就是让人看清楚返回了什么。
       */
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* 不是 JSON 就原样显示 */
      }
      setResult({ status: response.status, text: pretty });
    } catch (e) {
      setResult({ status: 0, text: `请求没发出去：${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inset-group px-3.5 py-3">
      <p className="t-subhead font-medium">在线试一下</p>
      <p className="t-caption mt-0.5 leading-relaxed text-[var(--ink-secondary)]">
        走的是和你 curl 完全相同的那条路 —— 同一个鉴权、同一套限流、同一份留痕。
      </p>

      <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
        令牌（粘进来，不会存到任何地方）
      </label>
      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="al_…"
        /*
         * type=password：这一页很可能是在别人旁边打开的，
         * 而令牌等于一把钥匙。
         */
        type="password"
        autoComplete="off"
        className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 font-mono outline-none"
      />

      <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">端点</label>
      <select
        value={chosen}
        onChange={(e) => {
          const next = endpoints.find((x) => keyOf(x) === e.target.value);
          setChosen(e.target.value);
          setResult(null);
          /*
           * 换端点时把请求体换成**这一条自己的**例子。
           *
           * 原来所有 POST 共用一个 `{"text":"…"}` —— 选「发帖」时那个
           * 请求体是错的（要 board / title / content），点下去拿到 400，
           * 而人多半会以为是令牌的问题。
           */
          setBody(next?.sampleBody ? JSON.stringify(next.sampleBody, null, 2) : "");
        }}
        className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
      >
        {endpoints.map((e) => (
          <option key={keyOf(e)} value={keyOf(e)}>
            {e.method} {e.path}
          </option>
        ))}
      </select>
      {endpoint && (
        <p className="t-caption2 mt-1 text-[var(--ink-tertiary)]">{endpoint.summary}</p>
      )}

      {/* 路径里有几个占位符就给几个框 —— 见 placeholdersOf */}
      {needed.map((name) => (
        <div key={name}>
          <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
            {ARG_HINT[name]?.label ?? name}
          </label>
          <input
            value={args[name] ?? ""}
            onChange={(e) => setArgs((prev) => ({ ...prev, [name]: e.target.value }))}
            placeholder={ARG_HINT[name]?.placeholder ?? `{${name}}`}
            className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 font-mono outline-none"
          />
        </div>
      ))}

      {isWrite && (
        <>
          <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">请求体</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 font-mono outline-none"
          />
          {/*
            * 这不是沙箱。点下去群里就真的多一条消息 ——
            * 说在前面，而不是让他从群友的反应里发现。
            */}
          <p
            className="t-caption2 mt-2 rounded-[var(--radius-control)] px-2.5 py-2 leading-relaxed"
            style={{
              background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
          >
            这不是沙箱：点下去，群里<strong>真的</strong>会多一条消息，而且会带上你的代发署名。
          </p>
        </>
      )}

      <button
        type="button"
        disabled={busy || token.trim().length === 0 || missing.length > 0}
        onClick={run}
        className="t-footnote mt-3 inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
        style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
      >
        <Play className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        {busy ? "请求中…" : isWrite ? "真的发出去" : "发起请求"}
      </button>

      {/* 缺参数时说清楚缺哪个，而不是让按钮无声地灰着 */}
      {missing.length > 0 && token.trim().length > 0 && (
        <p className="t-caption2 mt-1.5 text-[var(--ink-tertiary)]">
          还要填：{missing.map((m) => ARG_HINT[m]?.label ?? m).join("、")}
        </p>
      )}

      {result && (
        <div className="mt-3">
          <p className="t-caption2 text-[var(--ink-quaternary)]">
            HTTP {result.status === 0 ? "（没发出去）" : result.status}
          </p>
          <pre className="t-caption2 mt-1 max-h-72 overflow-auto rounded-[var(--radius-control)] bg-[var(--surface-sunken)] p-2.5 text-[var(--ink-secondary)]">
            {result.text}
          </pre>
        </div>
      )}
    </div>
  );
}
