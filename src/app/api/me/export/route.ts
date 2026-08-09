import { audit, auditContextFrom } from "@/lib/audit";
import { currentPreview, getRealUser } from "@/lib/auth/session";
import {
  beginExport,
  checkExportRate,
  failExport,
  finishExport,
  selfExportZip,
} from "@/lib/export/self-export";
import { exportFilename } from "@/lib/export/self-export-rules";
import { toReadableStream } from "@/lib/export/zip";
import { contentDisposition } from "@/lib/activities/export-rules";
import { clientIp } from "@/lib/request";
import { todayKey } from "@/lib/time";

/**
 * 下载「我自己的全部数据」（zip）。
 *
 * ═════════════════════════════════════════
 * 主体是谁：从会话里取，不从请求里取
 * ═════════════════════════════════════════
 *
 * 这条路由**没有任何指定用户的参数**，将来也不该有。
 * 唯一的可调项是「要不要带上下文」。
 *
 * 两处容易破功的地方，都在这里堵死：
 *
 * ① 用 `getRealUser()` 而不是 `getCurrentUser()`。
 *    后者在**预览态**下返回的是被预览的那个人 —— 管理员开着
 *    「以某某身份浏览」点一下导出，就把别人的全部聊天记录
 *    打包带走了，而 dataExports 里记的还是被预览者的名字。
 *
 * ② 预览态下直接 404。光换成 getRealUser 还不够：那样管理员
 *    会拿到**自己的**数据，功能上没错，但他此刻的身份显示是别人，
 *    界面会说不清这份文件是谁的。不给，比给一份说不清的好。
 *
 * ═════════════════════════════════════════
 * 为什么是一条 GET 路由而不是 Server Action
 * ═════════════════════════════════════════
 *
 * Server Action 回不了字节流。硬做的话要把整个 zip 变成
 * base64 塞进返回值 —— 那份东西在被下载之前就已经完整地
 * 在服务器内存里存在过一次，而且还胀了三分之一。
 * 这条路由从头到尾是流式的：内存里最多只有一个 deflate 缓冲区。
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const preview = await currentPreview();
  const user = await getRealUser();
  // 没登录、或正以别人的身份浏览 —— 一律当这条路由不存在
  if (!user || preview) return new Response("Not Found", { status: 404 });

  const rate = checkExportRate(user.id);
  if (!rate.allowed) {
    return new Response(rate.message, {
      status: 429,
      headers: {
        "Retry-After": String(rate.retryAfterSeconds),
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  // 默认带上下文（站长要的就是这个）；显式传 context=0 才只导自己的话
  const withContext = new URL(request.url).searchParams.get("context") !== "0";

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const recordId = beginExport(user.id, { ip, userAgent, withContext });

  /*
   * 审计。
   *
   * dataExports 那张表是给**用户自己**看的历史，也是限流的依据；
   * 审计日志是给管理员看的「站里发生过什么」。两边都记不是重复 ——
   * 一个人一周导了十次这件事，只有在审计流水里才会被顺手看见。
   * 记条数与范围，不记内容。
   */
  audit(auditContextFrom(request, user.id), {
    action: "me.data_export",
    targetType: "user",
    targetId: user.id,
    after: { record: recordId, withContext },
  });

  const run = selfExportZip(user, { withContext });

  /**
   * 一边发一边数字节，发完把这一行结掉。
   *
   * 三条出口都要落到表里，否则 status 会永远停在 started：
   * 正常发完 / 中途抛错 / **用户取消下载**（生成器被 return，
   * 既不走 catch 也不走成功分支，只有 finally 兜得住）。
   */
  async function* metered(): AsyncGenerator<Uint8Array> {
    let bytes = 0;
    let settled = false;
    try {
      for await (const chunk of run.stream) {
        bytes += chunk.length;
        yield chunk;
      }
      finishExport(recordId, run.counts, bytes);
      settled = true;
    } catch (err) {
      settled = true;
      failExport(recordId, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (!settled) failExport(recordId, "下载中断");
    }
  }

  return new Response(toReadableStream(metered()), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(exportFilename(todayKey())),
      // 这份东西里有这个人的全部聊天记录，任何一层都不许留副本
      "Cache-Control": "no-store, private",
      // 中间代理攒够整份再转发的话，用户会对着一个不动的进度条等几分钟
      "X-Accel-Buffering": "no",
    },
  });
}
