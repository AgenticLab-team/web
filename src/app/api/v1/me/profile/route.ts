import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { runAsApiCaller } from "@/lib/api-tokens/as-caller";
import { readJson } from "@/lib/api-tokens/route-helpers";
import { updateMyBio, updateMySkills } from "@/lib/members/actions";

export const dynamic = "force-dynamic";

/**
 * 改简介和技能标签。
 *
 * ─────────────────────────────────────────
 * 两块各改各的，**没填的那块不动**
 * ─────────────────────────────────────────
 *
 * 一次全量覆盖（没传 skills 就当成空数组）是这一类接口最常见的坏法：
 * 一个只想改简介的脚本会**顺手把技能标签清空**，而它返回 200，
 * 人要到几天后打开主页才发现。
 *
 * 所以判据是「这个字段在不在请求体里」，不是「它有没有值」——
 * 传 `[]` 是明确的「清空」，不传是「别动」。
 */
export async function POST(request: Request) {
  const auth = await authenticate(request, ["me:write"]);
  if (!auth.ok) return auth.response;

  const parsed = await readJson<{ bio?: unknown; skills?: unknown }>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  return runAsApiCaller(auth.caller, async () => {
    const errors: string[] = [];

    if ("bio" in body) {
      const r = await updateMyBio(typeof body.bio === "string" ? body.bio : "");
      if (!r.ok) errors.push(r.error ?? "简介没改成");
    }

    if ("skills" in body) {
      const raw = body.skills;
      const skills = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : [];
      const r = await updateMySkills(skills);
      if (!r.ok) errors.push(r.error ?? "技能标签没改成");
    }

    if (errors.length > 0) {
      return NextResponse.json(
        { error: { code: "rejected", message: errors.join("；") } },
        { status: 400 },
      );
    }
    return NextResponse.json({ ok: true });
  });
}
