import { requireAdmin } from "@/lib/admin/guard";
import { exportDomains, listDomains } from "@/lib/mail/admin-queries";

export const dynamic = "force-dynamic";

/**
 * 导出域名清单。
 *
 * ═════════════════════════════════════════
 * 一定要能回答「这个域名是谁的」
 * ═════════════════════════════════════════
 *
 * `DONE.md` 里记着上一次的教训：域名活动那个「导出」只有裸域名、
 * 只能复制到剪贴板 —— 站长拿到之后**答不上来它是谁的**，
 * 于是那份导出实际上没用。
 *
 * 所以这里一次给全：归属、到期、类别、DNS 三项、箱子数。
 * 落成文件而不是塞进剪贴板：一百行的东西是要存下来对着看的。
 */
export async function GET() {
  await requireAdmin("mail.domain.read");

  const csv = exportDomains(listDomains());

  return new Response(csv, {
    headers: {
      // 带 BOM：不带的话 Excel 打开中文域名那几行是乱码，而没人会来报这个
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="mail-domains.csv"',
    },
  });
}
