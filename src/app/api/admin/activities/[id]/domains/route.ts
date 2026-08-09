import { audit, auditContextFrom } from "@/lib/audit";
import { activityTitle, domainExportRows } from "@/lib/activities/export";
import {
  buildCsv,
  contentDisposition,
  exportFilename,
  isExportScope,
} from "@/lib/activities/export-rules";
import { getCurrentUser } from "@/lib/auth/session";
import { can } from "@/lib/rbac/can";
import { todayKey } from "@/lib/time";

/**
 * 下载域名申请清单（CSV）。
 *
 * ─────────────────────────────────────────
 * 为什么是一条路由而不是一个 Server Action
 * ─────────────────────────────────────────
 *
 * Server Action 回不了「一个带文件名的下载」。硬做的话就是
 * 把整份 CSV 当字符串塞进 props、在浏览器里拼 Blob ——
 * 那样这份清单在被下载**之前**就已经完整地进了页面 HTML，
 * 而且几千条申请会让后台页面白屏一下。
 * 一条 GET 路由是这件事本来的样子。
 *
 * ─────────────────────────────────────────
 * 没权限一律 404，不回 403
 * ─────────────────────────────────────────
 *
 * 403 等于告诉对方「这里确实有个导出接口，只是你不够格」。
 * 后台有哪些能力本身也是信息 —— 这条和 `guard.ts` 里
 * 「没权限跳走而不是显示空白页」是同一条规矩。
 */
export async function GET(
  request: Request,
  /*
   * 写成 `RouteContext<"/api/admin/...">` 会挂：那个全局辅助类型是从
   * **构建产物里生成的路由表**上取的，而一条刚写出来、还没构建过的
   * 路由不在那张表里 —— 于是 `tsc --noEmit` 报「不满足 AppRouteHandlerRoutes」，
   * 先有蛋后有鸡。部署流水线里 tsc 跑在构建之前，所以这个坑
   * 恰好会在最不该出事的时候出事。手写这个类型，和构建顺序无关。
   */
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user || !can(user, "activity.fulfill").allowed) {
    return new Response("Not Found", { status: 404 });
  }

  const { id } = await params;
  const scopeParam = new URL(request.url).searchParams.get("scope");
  const scope = isExportScope(scopeParam) ? scopeParam : "pending";

  const title = activityTitle(id);
  if (title === null) return new Response("Not Found", { status: 404 });

  const rows = domainExportRows(id, scope);

  /*
   * 导出要记审计。
   *
   * 这一份文件里有「谁申请了哪个域名」，导出即是把它复制到
   * 这套权限管不着的地方去。谁导的、导了多少条、导的哪一档，
   * 是事后唯一能回答「这份表是从哪来的」的记录。
   *
   * 记的是行数不是内容 —— 把整份名单再抄进审计表一遍，
   * 等于为了留痕又多造了一份同样敏感的副本。
   */
  audit(auditContextFrom(request, user.id), {
    action: "activity.fulfill",
    targetType: "activity",
    targetId: id,
    targetLabel: title,
    after: { export: "domains.csv", scope, rows: rows.length },
  });

  const filename = exportFilename(title, scope, todayKey());

  return new Response(buildCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": contentDisposition(filename),
      // 这份东西一分钟前和一分钟后可能不一样，别让任何一层缓存它
      "Cache-Control": "no-store",
    },
  });
}
