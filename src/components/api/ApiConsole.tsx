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
}

export function ApiConsole({ endpoints }: { endpoints: Endpoint[] }) {
  const [token, setToken] = useState("");
  const [chosen, setChosen] = useState(endpoints[0]?.path ?? "");
  const [pathArg, setPathArg] = useState("");
  const [body, setBody] = useState('{"text":"从在线测试发的"}');
  const [result, setResult] = useState<{ status: number; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const endpoint = endpoints.find((e) => e.path === chosen);
  const needsArg = chosen.includes("{conv_id}");
  const isWrite = endpoint?.method === "POST";

  const url = needsArg
    ? chosen.replace("{conv_id}", encodeURIComponent(pathArg.trim()))
    : chosen;

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
          setChosen(e.target.value);
          setResult(null);
        }}
        className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 outline-none"
      >
        {endpoints.map((e) => (
          <option key={e.path} value={e.path}>
            {e.method} {e.path}
          </option>
        ))}
      </select>

      {needsArg && (
        <>
          <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">
            群的 conv_id（上面「你能发到哪几个群」里可以复制）
          </label>
          <input
            value={pathArg}
            onChange={(e) => setPathArg(e.target.value)}
            placeholder="20000000003@chatroom"
            className="t-body mt-1 w-full rounded-[var(--radius-control)] bg-[var(--surface-sunken)] px-3 py-2 font-mono outline-none"
          />
        </>
      )}

      {isWrite && (
        <>
          <label className="t-caption2 mt-3 block text-[var(--ink-quaternary)]">请求体</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
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
        disabled={busy || token.trim().length === 0}
        onClick={run}
        className="t-footnote mt-3 inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-pill)] px-3.5 font-medium text-[var(--accent)] transition active:opacity-60 disabled:opacity-45"
        style={{ background: "color-mix(in srgb, var(--accent) 12%, transparent)" }}
      >
        <Play className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
        {busy ? "请求中…" : isWrite ? "真的发出去" : "发起请求"}
      </button>

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
