import { NextResponse } from "next/server";

import { authenticate } from "@/lib/api-tokens/auth";
import { equippedTitle, titlesOf } from "@/lib/titles/queries";

export const dynamic = "force-dynamic";

/** 我有哪些称号、现在挂着哪个 */
export async function GET(request: Request) {
  const auth = await authenticate(request, ["me:read"]);
  if (!auth.ok) return auth.response;

  const { user } = auth.caller;
  return NextResponse.json({
    owned: titlesOf(user.id),
    equipped: equippedTitle(user.id),
  });
}
