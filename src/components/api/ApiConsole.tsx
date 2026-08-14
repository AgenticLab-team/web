"use client";

import type { Endpoint as CatalogEndpoint } from "@/lib/api-tokens/catalog-types";

import { AlertTriangle, Play, Terminal } from "lucide-react";
import { useState } from "react";

import { ActionButton, CONTROL, CONTROL_MONO, Field } from "@/components/api/fields";

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
 *
 * ═════════════════════════════════════════
 * 桌面端左右分栏，手机端上下叠
 * ═════════════════════════════════════════
 *
 * 原来是一条从上到下的长表单：令牌、端点、参数、请求体、按钮、
 * 结果。于是**点完之后结果在屏幕外** —— 桌面上左右两侧空着一大片，
 * 人却要往下滚才能看见自己刚发的那一次返回了什么，
 * 而改一个参数再发一次又要滚回去。
 *
 * 左边是「要发什么」，右边是「发回来什么」，改一次看一次不用动。
 * 手机上没有第二栏可分，就还是上下叠 —— 但结果区**永远在**
 * （空的时候写着一句占位），位置固定，不会因为有没有结果而跳。
 */

/*
 * ─────────────────────────────────────────
 * 类型从目录里来，不在这儿再定义一份
 * ─────────────────────────────────────────
 *
 * 原来这里有一份自己的 `interface Endpoint`，只写了控制台用得上的
 * 那几个字段。它在目录还只有 GET/POST 两种方法时一直是对的 ——
 * 而目录加上 PATCH/DELETE 的那一天，这一份不会报错，
 * 它只会让那几条端点**从下拉框里消失**（类型不匹配被上游拦下），
 * 而没有任何地方说得出为什么。
 */
type Endpoint = Pick<CatalogEndpoint, "method" | "path" | "summary" | "scopes" | "sampleBody">;

/**
 * 路径里的占位符，比如 `/posts/{id}/replies` → `["id"]`。
 *
 * ─────────────────────────────────────────
 * 第一版只认得群 id 那一种
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
  conv_id: { label: "群 id", placeholder: "在右边「你在的群」里复制" },
  id: { label: "帖子 id", placeholder: "先调 GET /api/v1/posts 拿" },
};

/** 同一个路径上 GET 和 POST 是两条端点，所以 key 要带上方法 */
function keyOf(e: Endpoint | undefined): string {
  return e ? `${e.method} ${e.path}` : "";
}

/**
 * 状态码染什么色。
 *
 * 只写一个数字的话，2xx 和 4xx 在眼睛里是一样的 —— 而这一页
 * 存在的意义正是让人一眼看出「成了没有」。0 是我们自己编的，
 * 表示请求根本没发出去（断网、被拦截）。
 */
function statusTone(status: number): { color: string; label: string } {
  if (status === 0) return { color: "var(--danger)", label: "没发出去" };
  if (status >= 200 && status < 300) return { color: "var(--success)", label: "成功" };
  if (status >= 400 && status < 500) return { color: "var(--warning)", label: "请求有问题" };
  return { color: "var(--danger)", label: "服务端出错" };
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
  const noToken = token.trim().length === 0;

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

  const tone = result ? statusTone(result.status) : null;

  return (
    <div className="inset-group scroll-mt-16 p-4" id="console">
      <h3 className="t-headline">在线试一下</h3>
      <p className="t-footnote mt-1 leading-relaxed text-[var(--ink-secondary)]">
        和你在自己机器上 curl 走的是同一条路：同一个鉴权、同一套限流、同一份留痕。
      </p>

      {/* 桌面端 5:4 分栏 —— 左边填，右边看，改一次看一次不用滚 */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] lg:gap-5">
        {/* ── 左：要发什么 ─────────────────────────── */}
        <div className="min-w-0 space-y-4">
          <Field label="令牌" hint="粘进来就行，这一页不会把它存到任何地方">
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
              className={CONTROL_MONO}
            />
          </Field>

          <Field label="调哪一条">
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
              className={CONTROL}
            >
              {endpoints.map((e) => (
                <option key={keyOf(e)} value={keyOf(e)}>
                  {e.method} {e.path} —— {e.summary}
                </option>
              ))}
            </select>
          </Field>

          {/* 路径里有几个占位符就给几个框 —— 见 placeholdersOf */}
          {needed.map((name) => (
            <Field key={name} label={ARG_HINT[name]?.label ?? name}>
              <input
                value={args[name] ?? ""}
                onChange={(e) => setArgs((prev) => ({ ...prev, [name]: e.target.value }))}
                placeholder={ARG_HINT[name]?.placeholder ?? name}
                className={CONTROL_MONO}
              />
            </Field>
          ))}

          {isWrite && (
            <Field label="请求体" hint="已经填好一份能直接按下去的例子">
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
                className={`${CONTROL_MONO} resize-y leading-relaxed`}
              />
            </Field>
          )}

          {/*
            * ── 这不是沙箱 ─────────────────────────
            *
            * 点下去，一千六百人的群里就真的多一条消息 ——
            * 说在前面，而不是让他从群友的反应里发现。
            *
            * 左侧一条实心色带 + 图标，不是一块淡红底：
            * 淡底那版和页面上另外几处提示长得一样重，
            * 而这一条和它们不是一回事 —— 它说的是「不可撤销」。
            */}
          {isWrite && (
            <div
              className="flex items-start gap-2.5 rounded-[var(--radius-control)] p-3"
              style={{
                background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                boxShadow: "inset 3px 0 0 var(--danger)",
              }}
            >
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0"
                strokeWidth={2.4}
                style={{ color: "var(--danger)" }}
                aria-hidden
              />
              <p
                className="t-footnote leading-relaxed"
                style={{ color: "var(--danger)" }}
              >
                这不是沙箱。点下去群里<strong>真的</strong>会多一条消息，撤不回来，
                而且带着你的代发署名。
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              busy={busy}
              disabled={noToken || missing.length > 0}
              onClick={run}
              icon={<Play className="h-4 w-4" strokeWidth={2.4} aria-hidden />}
            >
              {busy ? "请求中…" : isWrite ? "真的发出去" : "发起请求"}
            </ActionButton>

            {/*
              * 按钮为什么是灰的，就写在旁边。
              *
              * 原来只有「缺参数」那一种有提示，而**没填令牌**那一种
              * 什么都不说 —— 于是最常见的那次卡住是无声的。
              */}
            {noToken ? (
              <span className="t-caption text-[var(--ink-tertiary)]">先在上面粘一把令牌</span>
            ) : (
              missing.length > 0 && (
                <span className="t-caption text-[var(--ink-tertiary)]">
                  还要填：{missing.map((m) => ARG_HINT[m]?.label ?? m).join("、")}
                </span>
              )
            )}
          </div>
        </div>

        {/* ── 右：发回来什么 ───────────────────────── */}
        <div className="min-w-0">
          <p className="t-footnote font-medium text-[var(--ink-secondary)]">响应</p>
          <div
            className="mt-1.5 overflow-hidden rounded-[var(--radius-control)] bg-[var(--surface-sunken)]"
            /*
             * 结果区是异步出现的，读屏必须听得到 ——
             * 不然点完按钮之后他那边是彻底安静的。
             */
            aria-live="polite"
            aria-busy={busy}
          >
            {result && tone ? (
              <>
                <p
                  className="t-footnote flex items-center gap-2 px-3 py-2 font-medium"
                  style={{
                    background: `color-mix(in srgb, ${tone.color} 12%, transparent)`,
                    color: tone.color,
                  }}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: tone.color }}
                    aria-hidden
                  />
                  <span className="tabular">
                    {result.status === 0 ? "——" : `HTTP ${result.status}`}
                  </span>
                  <span className="font-normal opacity-80">{tone.label}</span>
                </p>
                <pre className="t-caption2 max-h-96 overflow-auto p-3 leading-relaxed text-[var(--ink-secondary)]">
                  {result.text}
                </pre>
              </>
            ) : (
              /*
               * 空态也占着这块地方，不是「有结果才出现」——
               * 后者会让按钮下面的一切在点下去的瞬间往下跳一大截。
               */
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
                <Terminal
                  className="h-5 w-5 text-[var(--ink-quaternary)]"
                  strokeWidth={1.8}
                  aria-hidden
                />
                <p className="t-caption text-[var(--ink-tertiary)]">
                  {busy ? "请求中…" : "结果会出现在这里，包括失败的那些"}
                </p>
              </div>
            )}
          </div>

          {endpoint && (
            <p className="t-caption mt-2 leading-relaxed text-[var(--ink-tertiary)]">
              {endpoint.summary}
              {endpoint.scopes.length > 0 && (
                <>
                  {" · 需要 "}
                  <code>{endpoint.scopes.join("、")}</code>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
