import { NextResponse } from "next/server";

import { apiError, authenticate } from "@/lib/api-tokens/auth";
import { checkExportRate, exportPreview, myRecentExports } from "@/lib/export/self-export";

export const dynamic = "force-dynamic";

/**
 * 导出我的数据。
 *
 * ═════════════════════════════════════════
 * 先说清楚这份东西里有**别人说的话**，再给下载
 * ═════════════════════════════════════════
 *
 * 网页那一页的顺序是刻意的：先警告、再给按钮。反过来的话
 * 绝大多数人会先点，下完才发现里面有别人的发言 ——
 * 那时候文件已经在他硬盘上了。
 *
 * 在终端里这条更容易被跳过：一个脚本调 `POST` 根本不会读任何文案。
 * 所以警告不是文案，是**返回体里的一个字段**：`GET` 先给出
 * 这次会导出什么、里面包含谁，`POST` 要带上 `acknowledged: true`
 * 才真的开始 —— 一个不读文档的脚本调不动它。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  return NextResponse.json({
    preview: exportPreview(user),
    history: myRecentExports(user.id),
    warning:
      "群聊是很多人一起说的，只留你那几条谁也读不懂。所以导出会附上你每段发言前后的对话 —— " +
      "范围限定在你现在仍然在的群，别人的微信 ID 和昵称一律换成代号，但正文原样保留。" +
      "这份东西怎么用，责任在你。",
  });
}

export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;

  let acknowledged = false;
  try {
    const body = (await request.json()) as { acknowledged?: unknown } | null;
    acknowledged = body?.acknowledged === true;
  } catch {
    /* 没有请求体就是没确认，下面那一句会说清楚 */
  }

  if (!acknowledged) {
    return apiError(
      400,
      "not_acknowledged",
      "这份导出里会包含别人在群里说的话（见 GET 的 warning）。确认之后传 {\"acknowledged\": true}",
    );
  }

  /*
   * 限流走 `checkExportRate`，不自己数。
   *
   * 导出是这个站最重的一个操作（要扫全部消息、压 zip）。
   * 网页那边已经有一套频率判定，这里另写一份的话，
   * 两份里迟早有一份更松 —— 而更松的那份会被人找到。
   */
  const rate = checkExportRate(user.id);
  if (!rate.allowed) {
    return apiError(429, "rate_limited", rate.message, {
      "Retry-After": String(rate.retryAfterSeconds),
    });
  }

  /*
   * ─────────────────────────────────────────
   * 终端拿到的是一个**网页地址**，不是文件流
   * ─────────────────────────────────────────
   *
   * 打包要跑一会儿，而一个几十兆的 zip 从 HTTP 响应里
   * 直接流给终端，中间断一次就要全部重来，且没有断点续传。
   *
   * 更要紧的是：这份文件里有别人的话。让它经过一次**浏览器里的
   * 下载**，意味着它落地时人是清醒的 —— 而不是躺在某个脚本的
   * 临时目录里被忘掉。
   */
  return NextResponse.json({
    ok: true,
    download_via: "/me/export",
    note: "打包在浏览器里完成。终端里打不开网页的话，把这个地址发到手机上",
  });
}
