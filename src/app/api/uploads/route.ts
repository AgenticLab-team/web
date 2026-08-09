import { getRealUser } from "@/lib/auth/session";
import { clientIp } from "@/lib/request";
import { checkQuota, recordUpload } from "@/lib/uploads/queries";
import { checkUpload, markdownFor } from "@/lib/uploads/rules";
import { uploadFile, usingGuestQuota } from "@/lib/uploads/client";

/**
 * 上传一个文件，拿一条直链回来。
 *
 * ─────────────────────────────────────────
 * 必须登录，而且必须是真身
 * ─────────────────────────────────────────
 *
 * 这个站只有群成员能登录，所以「要登录」等于「只有成员能传」——
 * 不然它就是一个挂在别人图床上的公共网盘，
 * 而封禁和账单落在站长头上。
 *
 * 用 `getRealUser()` 而不是 `getCurrentUser()`：后者在预览态下
 * 返回**被预览的那个人**，于是管理员预览时传的图会记在别人名下。
 * 这个坑这个项目已经踩到过两次（GitHub 绑定、数据导出），
 * 第三次就该是条件反射了。
 */
export async function POST(request: Request) {
  const user = await getRealUser();
  if (!user) return Response.json({ error: "先登录" }, { status: 401 });

  const quota = checkQuota(user.id);
  if (!quota.allowed) {
    /*
     * 429 带上 Retry-After，而且**说的是真实的剩余秒数**。
     * 笼统地说「稍后再试」的人会立刻再点一次，
     * 而他要做的恰恰是等。
     */
    return Response.json(
      { error: `传得太快了，${quota.retryAfterSeconds} 秒后再来` },
      { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds) } },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "请求不是 multipart 表单" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "没有拿到文件" }, { status: 400 });
  }

  /*
   * 在本地先判一遍类型和大小。
   *
   * 不是替上游把关 —— 是**在浪费掉一次上传之前**告诉人原因。
   * 等上游回 415 再说的话，手机上传一个 40MB 的视频要等半分钟
   * 才知道格式不行。顺带也挡住了 SVG：它是 image/*，
   * 但里面能写脚本，而一张能执行脚本的「图片」就是储存型 XSS。
   */
  const verdict = checkUpload({ mime: file.type, size: file.size });
  if (!verdict.ok) return Response.json({ error: verdict.error }, { status: 415 });

  const result = await uploadFile(file);
  if (!result.ok) {
    return Response.json(
      { error: result.error, retryable: result.retryable ?? false },
      { status: 502 },
    );
  }

  /*
   * 记一行。文件不在我们这儿，但**「谁传的」只有我们记得** ——
   * 那条链接会出现在帖子里、被转发出去，而链接本身不带身份信息。
   */
  recordUpload({
    userId: user.id,
    url: result.url,
    kind: verdict.kind,
    mime: file.type,
    bytes: file.size,
    filename: file.name,
    ip: clientIp(request),
  });

  return Response.json({
    url: result.url,
    kind: verdict.kind,
    markdown: markdownFor(verdict.kind, result.url, file.name),
    remark: result.remark,
    // 让界面知道还剩几次，而不是等撞上限了才说
    remaining: quota.remaining - 1,
    guestQuota: usingGuestQuota(),
  });
}
