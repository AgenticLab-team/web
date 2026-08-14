import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { fromResult, readJson } from "@/lib/api-tokens/route-helpers";
import { updateNotificationPrefs } from "@/lib/notifications/actions";
import { getPrefs } from "@/lib/notifications/store";
import { SECTION_LABELS, TYPE_META, isAlwaysOn } from "@/lib/notifications/prefs";

export const dynamic = "force-dynamic";

/**
 * 通知偏好：哪几类通知开着。
 *
 * ─────────────────────────────────────────
 * 「关不掉的那几类」要标出来，而不是悄悄忽略
 * ─────────────────────────────────────────
 *
 * 有几类通知是强制开的（封禁、申诉结果这一类 —— 关掉等于
 * 让一个人不知道自己被处理了）。
 *
 * 不标出来的话，终端会画一个能拨的开关，人拨完刷新发现它弹回去了，
 * 而没有任何地方解释为什么。带上 `always_on` 之后，
 * 那一行显示成不可拨 + 一句原因。
 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["notifications:write"]);
  if (!auth.ok) return auth.response;

  const prefs = getPrefs(auth.caller.user.id);
  return NextResponse.json({
    sections: SECTION_LABELS,
    types: TYPE_META.map((t) => ({
      key: t.type,
      label: t.label,
      /* 每一类都带一句「什么时候会收到」—— 「回复」这种词对用户不清楚 */
      hint: t.hint,
      section: t.section,
      always_on: isAlwaysOn(t.type),
      channels: prefs[t.type] ?? null,
    })),
  });
}

export async function POST(request: Request) {
  const auth = await authenticate(request, ["notifications:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson(request);
  if (!parsed.ok) return parsed.response;

  /*
   * 请求体原样交给动作函数。
   *
   * 它自己有一套 `sanitizeSubmission` —— 强制开的那几类会被
   * 挡在那里。在这里再判一遍就是第二份规则，
   * 而两份规则里总有一份会先忘记新加的类型。
   */
  return runAsApiCaller(auth.caller, async () =>
    fromResult(await updateNotificationPrefs(parsed.body)),
  );
}
