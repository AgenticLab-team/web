import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-tokens/auth";
import { getSettingJson } from "@/lib/settings/store";
import { validateManifest } from "@/lib/tui/release-rules";

export const dynamic = "force-dynamic";

/**
 * 终端客户端的最新版本与下载地址。
 *
 * ═════════════════════════════════════════
 * 这一条**不要令牌**
 * ═════════════════════════════════════════
 *
 * 一个还没登录的人要先能把客户端装上 —— 而装的第一步就是问这里。
 * 要令牌的话，`curl | bash` 那条路根本走不通。
 *
 * 它泄露的只有「最新版是几」和几个下载地址，
 * 而那些本来就要在安装脚本里明文写出来。
 *
 * ─────────────────────────────────────────
 * 清单存在设置里，而不是写死在代码里
 * ─────────────────────────────────────────
 *
 * 写死的话，发一个新版本要改代码、跑一遍部署 ——
 * 而部署本身会重启服务。发客户端不该需要重启网站。
 *
 * 校验在读的时候做（`validateManifest`）：配错了就当**没有发布**，
 * 而不是把一份坏清单发给所有终端。一个下载不下来的更新，
 * 比一个「暂时没有更新」难查得多。
 */
export async function GET() {
  const raw = getSettingJson<unknown>("tui.release", null);
  const checked = validateManifest(raw);

  if (!checked.ok) {
    /*
     * 没配 / 配错了都回 404。
     *
     * 客户端那侧对这两种的处理一模一样（静静地不更新），
     * 而分开报会让一个普通用户看到一句他无能为力的
     * 「发布清单格式错误」。真正要看到这句话的是站长，
     * 而他看的是健康检查，不是这条接口。
     */
    return apiError(404, "not_found", "还没有发布过终端客户端");
  }

  return NextResponse.json(checked.manifest, {
    headers: {
      /*
       * 允许边缘缓存一分钟。
       *
       * 这条接口会被每一个终端在每次启动时调一次，而答案对所有人相同。
       * 一分钟够短，短到发完新版之后不用等；也够长，
       * 长到一次群里的「大家更新一下」不会打穿源站。
       */
      "Cache-Control": "public, max-age=60",
    },
  });
}
