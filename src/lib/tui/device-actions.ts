"use server";

import { audit } from "@/lib/audit";
import { normalizeScopes, type ScopeKey } from "@/lib/api-tokens/rules";
import { getRealUser } from "@/lib/auth/session";
import { approveDevice, denyDevice, lookupByUserCode } from "@/lib/tui/device";

/**
 * 确认页上那两个按钮。
 *
 * ═════════════════════════════════════════
 * 取当前用户一律用 `getRealUser()`
 * ═════════════════════════════════════════
 *
 * 不是 `getCurrentUser()` —— 后者在预览态下返回**被预览的那个人**。
 * 这里发出去的是一把能替人行事的令牌，用错的后果是
 * **管理员在预览某个成员时点了同意，令牌发给了那个成员**，
 * 而他自己的终端永远等不到。
 *
 * 这个坑在这个仓库里已经踩到过三次（GitHub 绑定、数据导出、图床上传），
 * `ARCHITECTURE.md` 第四节说第四次就该是条件反射了。
 */

export interface LinkActionResult {
  ok: boolean;
  error?: string;
}

/**
 * 同意。
 *
 * `code` 而不是 `id` 作为入参：`id` 是库里的主键，页面上没有理由
 * 把它交给客户端 —— 交出去之后，一个知道 id 的人（比如从日志里
 * 看到的）就能替别人批准。而 `code` 本来就在他手上。
 */
export async function approveDeviceAction(input: {
  code: string;
  scopes: string[];
}): Promise<LinkActionResult> {
  const user = await getRealUser();
  if (!user) return { ok: false, error: "请先登录" };

  const found = lookupByUserCode(input.code);
  if (!found.ok) return { ok: false, error: explain(found.reason) };

  const granted = normalizeScopes(input.scopes) as ScopeKey[];
  const done = approveDevice(found.device.id, user.id, granted);
  if (!done) return { ok: false, error: "这条登录请求已经不在等待中了" };

  /*
   * 同意和拒绝都留审计。
   *
   * 「谁在什么时候把自己的身份借给了哪台设备」是事后唯一要问的问题，
   * 而它在别的地方一个字都查不到 —— `api_tokens` 里只有令牌本身，
   * 答不出「当时那台设备自称是什么」。
   */
  audit(
    { actorId: user.id },
    {
      action: "tui.device.approve",
      targetType: "device_code",
      targetId: found.device.id,
      targetLabel: found.device.deviceLabel,
      after: {
        source: found.device.source,
        ip: found.device.requestIp,
        scopes: granted,
        asked: found.device.scopes,
      },
    },
  );

  return { ok: true };
}

export async function denyDeviceAction(input: { code: string }): Promise<LinkActionResult> {
  const user = await getRealUser();
  if (!user) return { ok: false, error: "请先登录" };

  const found = lookupByUserCode(input.code);
  if (!found.ok) return { ok: false, error: explain(found.reason) };

  denyDevice(found.device.id, user.id);

  audit(
    { actorId: user.id },
    {
      action: "tui.device.deny",
      targetType: "device_code",
      targetId: found.device.id,
      targetLabel: found.device.deviceLabel,
      after: { source: found.device.source, ip: found.device.requestIp },
    },
  );

  return { ok: true };
}

/**
 * 三种失败各说各的。
 *
 * 合成一句「无效的验证码」的话，一个慢了半分钟的人会以为自己敲错了，
 * 然后把同一串码再敲一遍 —— 而他真正要做的是回终端里重新生成一串。
 */
function explain(reason: "not_found" | "expired" | "used"): string {
  if (reason === "expired") return "这串码过期了。回终端里按一下重新生成";
  if (reason === "used") return "这串码已经处理过了";
  return "没有这串码。核对一下终端上显示的那几位";
}
