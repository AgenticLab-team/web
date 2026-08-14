import "server-only";

import { env } from "@/lib/env";
import { getSettingJson } from "@/lib/settings/store";

import { renderInstallScript } from "./install-rules";
import { validateManifest, type ReleaseManifest } from "./release-rules";

/**
 * `curl -Ls agenticlab.sh | bash` 那段脚本 —— 读设置、拼出来。
 *
 * ═════════════════════════════════════════
 * 真正拼字符串的那一段在 `install-rules.ts`，是**纯的**
 * ═════════════════════════════════════════
 *
 * 拆开的理由是这个仓库的老规矩（`ARCHITECTURE.md` 第一节）：
 * 纯规则放 `*-rules.ts`，不许 import `server-only` / 数据库 ——
 * 这样它们能被直接测，而不需要一个数据库。
 *
 * 这一条在这里格外要紧：那段脚本是**生成**的，会被一千多人
 * 管道进 bash，而一个语法错误的后果是 bash 把它能解析的那半段跑完。
 * 那份测试（`tests/tui-install.test.ts`）拿一份假清单渲染它，
 * 然后交给真的 `bash -n` —— 而它要能在没有 `.env.local` 的机器上跑。
 *
 * ─────────────────────────────────────────
 * 为什么脚本是生成的，不是仓库里的一个静态文件
 * ─────────────────────────────────────────
 *
 * 版本号和 sha256 每次发布都变。写成静态文件的话，发一个新版
 * 要改两个地方（发布清单 + 那个文件），而漏改的那一次不会报错 ——
 * 它会让所有新安装的人卡在校验失败上。
 *
 * 现在两者读同一份 `tui.release`，不可能对不上。
 */
export function installScript(): string {
  return renderInstallScript(currentManifest(), env.site.url);
}

/** 现在发布的是哪一版。配错了当成没发布 —— 理由见 `/api/v1/release` */
function currentManifest(): ReleaseManifest | null {
  const checked = validateManifest(getSettingJson<unknown>("tui.release", null));
  return checked.ok ? checked.manifest : null;
}
