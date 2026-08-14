import "server-only";

import { NextResponse } from "next/server";

import { apiError } from "./auth";

/**
 * 七十来条路由里重复的那几件事。
 *
 * ═════════════════════════════════════════
 * 抽出来的判据：**抄错了会安静地出事**
 * ═════════════════════════════════════════
 *
 * 不是「这几行出现了很多次」—— 那是重复，重复本身不值得抽。
 * 抽的是那些抄错之后不报错的：
 *
 *   · 分页上限忘了封顶 → 一个 `?limit=100000` 就能把一台
 *     小服务器的内存吃掉，而它长得和正常请求一模一样
 *   · JSON 解析没包 try → 一个畸形请求体变成 500，
 *     而 500 会被客户端库当成「服务端故障」自动重试
 *   · 分页参数各写各的（`page` / `offset` / `cursor` 三派）→
 *     终端那侧要为每一条端点记一遍它用哪派
 *
 * 三条都不会在开发机上暴露。
 */

/** 请求体。解析失败给 400 而不是让它变成 500 */
export async function readJson<T = Record<string, unknown>>(
  request: Request,
): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  try {
    const body = (await request.json()) as T;
    if (body === null || typeof body !== "object") {
      return { ok: false, response: apiError(400, "bad_json", "请求体要是一个 JSON 对象") };
    }
    return { ok: true, body };
  } catch {
    return { ok: false, response: apiError(400, "bad_json", "请求体不是合法的 JSON") };
  }
}

export interface Paging {
  limit: number;
  offset: number;
  /** 游标翻页用。按时间倒序的那些列表用它，不用 offset */
  before: number | null;
  query: string;
}

/**
 * 统一的分页参数。
 *
 * ─────────────────────────────────────────
 * 上限**必须**封顶，而且封在这一处
 * ─────────────────────────────────────────
 *
 * 逐条路由各写一遍 `Math.min(..., 50)` 的话，总有一条会漏 ——
 * 而漏掉的那一条不会报错：它会正常返回，只是返回了四万条。
 *
 * `max` 可以调高（消息回看那种一屏要几百条），但没有「不封顶」这个选项。
 */
export function paging(request: Request, max = 50): Paging {
  const url = new URL(request.url);
  const num = (key: string, fallback: number) => {
    const raw = Number(url.searchParams.get(key));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  };
  const before = Number(url.searchParams.get("before"));
  return {
    limit: Math.min(num("limit", 20), max),
    /*
     * offset 不封顶，但也不能是负数 —— 负 offset 在 SQLite 里
     * 不报错，它会被当成 0，于是「翻到第 -1 页」看起来像是回到了第一页。
     */
    offset: Math.max(0, Math.floor(num("offset", 0)) || 0),
    before: Number.isFinite(before) && before > 0 ? before : null,
    query: (url.searchParams.get("q") ?? "").trim(),
  };
}

/** 查询参数里的一个字符串。空串当没传 */
export function param(request: Request, key: string): string | null {
  const value = new URL(request.url).searchParams.get(key)?.trim();
  return value ? value : null;
}

/**
 * 一次写操作的结果 → HTTP。
 *
 * ═════════════════════════════════════════
 * 「规则不允许」和「服务端出错」必须是两个状态码
 * ═════════════════════════════════════════
 *
 * 站里的写操作统一返回 `{ ok, error }`，其中 `error` 是**给人看的
 * 一句话**（「等级不够」「这个版块要标签」「发得太频繁了」）。
 *
 * 把它们一律映射成 500 的话，客户端库会自动重试 —— 而重试一个
 * 「等级不够」永远不会成功，只会把同一条错误刷进日志几十次，
 * 真正的服务端故障反而被埋掉了。
 *
 * 所以：规则拒绝 = 400（别重试，去改请求），只有真异常才是 5xx。
 */
export function fromResult<T extends { ok: boolean; error?: string | null }>(
  result: T,
  extra?: Record<string, unknown>,
): NextResponse {
  if (!result.ok) return apiError(400, "rejected", result.error ?? "没成功");
  return NextResponse.json({ ok: true, ...extra });
}

/**
 * 布尔开关类请求体里的 `on`。
 *
 * ─────────────────────────────────────────
 * 缺省是 `true`，不是 `false`
 * ─────────────────────────────────────────
 *
 * 这一族接口（收藏、关注、投票、报名）的语义是「打开这个」，
 * 而人写脚本时最常见的是 `POST .../bookmark` 不带任何请求体。
 *
 * 缺省成 `false` 的话，那次调用会**静默地取消收藏** ——
 * 返回 200，什么也没发生，而他以为收藏成功了。
 */
export function toggleFlag(body: { on?: unknown }): boolean {
  return body.on !== false;
}
