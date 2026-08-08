import { NextResponse } from "next/server";

import { latestHealth, runHealthChecks } from "@/lib/health";

export const dynamic = "force-dynamic";

/** 运维探活。不含任何敏感信息，可以给外部监控直接打 */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.has("probe");
  const reports = fresh ? await runHealthChecks() : latestHealth();

  const worst = reports.some((r) => r.status === "down")
    ? "down"
    : reports.some((r) => r.status === "degraded")
      ? "degraded"
      : "ok";

  return NextResponse.json(
    { status: worst, components: reports },
    { status: worst === "down" ? 503 : 200 },
  );
}
