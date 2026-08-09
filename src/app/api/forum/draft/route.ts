import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { MAX_DRAFT_CHARS } from "@/lib/forum/draft-rules";
import { saveDraft } from "@/lib/forum/drafts";

/**
 * 存一次草稿。
 *
 * ─────────────────────────────────────────
 * 为什么是接口而不是 server action
 * ─────────────────────────────────────────
 *
 * 这个站大部分人在**微信内置浏览器**里打开，页面随时被系统回收。
 * 最需要保住那一次保存的时刻，恰恰是页面正在被杀掉的时刻 ——
 * 而那时候 server action 那条链路（RSC 请求 + 等响应）已经来不及了。
 *
 * `navigator.sendBeacon` 是浏览器专门为这一刻准备的：
 * 它把请求交给浏览器进程，页面死掉也照发。而它只会发
 * **普通 POST**，发不了 server action。
 *
 * 所以定时保存和「页面要没了」那一次走同一条路 ——
 * 两条路的话，最要紧的那条平时跑不到，坏了也没人知道。
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  // 没登录就静默成功：草稿这条路上的 401 没有任何人看得见，
  // 而 beacon 本来就拿不到响应
  if (!user) return NextResponse.json({ ok: false }, { status: 401 });

  const body = await request.json().catch(() => null);

  const target = body?.target === "reply" ? "reply" : "post";
  const scope = typeof body?.scope === "string" ? body.scope : "";
  const content = typeof body?.content === "string" ? body.content : "";
  const title = typeof body?.title === "string" ? body.title : null;
  const boardId = typeof body?.boardId === "string" ? body.boardId : null;
  const base = Number.isFinite(body?.base) ? Number(body.base) : 0;

  if (!scope) return NextResponse.json({ ok: false, error: "缺少草稿标识" }, { status: 400 });
  if (content.length > MAX_DRAFT_CHARS) {
    return NextResponse.json({ ok: false, error: "草稿太长了" }, { status: 413 });
  }

  const result = saveDraft({ userId: user.id, target, scope, boardId, title, content, base });

  if (!result.ok) {
    /*
     * 冲突用 409，并且**把服务器那份带回去**。
     *
     * 只说一句「冲突了」的话，客户端为了给人看那一份还得再请求一次 ——
     * 而这一刻页面可能正在被回收，那次请求发不出去。
     */
    return NextResponse.json({ ok: false, error: result.reason, server: result.server }, { status: 409 });
  }

  return NextResponse.json(result);
}
