import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { SURFACES } from "@/lib/tui/surface";
import { ADMIN_SECTION_META } from "@/lib/admin/api-section-rules";
import { SCOPES } from "@/lib/api-tokens/rules";

/**
 * 把 TS 那边的几张表倒进 Go。
 *
 * ═════════════════════════════════════════
 * 为什么是生成，不是在 Go 那边再写一遍
 * ═════════════════════════════════════════
 *
 * 「终端里有网页上的每一样东西」这句话靠的是 `lib/tui/surface.ts`
 * 那张表。如果 Go 那侧也维护一份自己的清单，就有了两份 ——
 * 而两份必然分叉，分叉之后**守卫守的是 TS 那一份，
 * 而用户用的是 Go 那一份**。
 *
 * 所以 Go 那侧不许有第二份数据，只有一份从这里生成的。
 * `tests/tui-parity.test.ts` 会核对生成物是不是最新的：
 * 改了表没重新生成就是红的。
 *
 * ─────────────────────────────────────────
 * 生成的是 `.go` 而不是 `.json`
 * ─────────────────────────────────────────
 *
 * JSON 要在运行时读文件（或者 embed 再解析），而这两件事都会
 * 在**用户的机器上**失败：文件缺了、JSON 坏了。
 * 生成 Go 源码之后，那些失败提前到编译期 ——
 * 一个装到一半的二进制根本不存在。
 *
 * 跑：`npm run tui:gen`
 */

const OUT = join(process.cwd(), "tui/internal/surface/surface.gen.go");

const q = (s: string) => JSON.stringify(s);
const list = (xs: readonly string[]) =>
  xs.length === 0 ? "nil" : `[]string{${xs.map(q).join(", ")}}`;

const header = `// 由 \`npm run tui:gen\` 生成，别手改。
//
// 真源是 src/lib/tui/surface.ts —— 改那里，然后重新生成。
// 手改这个文件的话，改动会在下一次生成时被覆盖，
// 而在那之前它会让 tests/tui-parity.test.ts 报一个看不懂的差异。

package surface
`;

const surfaceStructs = SURFACES.map(
  (s) => `\t{
\t\tKey:            ${q(s.key)},
\t\tLabel:          ${q(s.label)},
\t\tBoard:          ${q(s.board)},
\t\tWeb:            ${q(s.web ?? "")},
\t\tScreen:         ${q(s.tui ?? "")},
\t\tWhy:            ${q(s.why ?? "")},
\t\tAPI:            ${list(s.api)},
\t\tScopes:         ${list(s.scopes)},
\t\tOptionalScopes: ${list(s.optionalScopes ?? [])},
\t\tAdminSection:   ${q(s.adminSection ?? "")},
\t},`,
).join("\n");

const scopeStructs = SCOPES.map(
  (s) => `\t{Key: ${q(s.key)}, Label: ${q(s.label)}, Detail: ${q(s.detail)}, Danger: ${s.danger}},`,
).join("\n");

const adminStructs = ADMIN_SECTION_META.map(
  (s) => `\t{Key: ${q(s.key)}, Label: ${q(s.label)}, Description: ${q(s.description)}},`,
).join("\n");

const body = `${header}
// Surfaces 是站里每一个「面」。顺序就是终端最左那一竖里的显示顺序 ——
// 排序是产品决定，所以它跟着真源走，不在 Go 这边重排。
var Surfaces = []Surface{
${surfaceStructs}
}

// Scopes 是令牌权限的人话说明。登录时的同意提示、以及
// 「你这把令牌看不了这个」那句话都读它。
var Scopes = []Scope{
${scopeStructs}
}

// AdminSections 是后台分区的**名字**。
//
// 注意：终端里真正列出哪几个分区**不看这张表**，看
// \`GET /api/v1/admin/sections\`（那条是按人算过的）。
// 这张表只用来在离线时把 section key 翻译成人话。
var AdminSections = []AdminSection{
${adminStructs}
}
`;

writeFileSync(OUT, body, "utf8");
console.log(`写好了 ${OUT}：${SURFACES.length} 个面、${SCOPES.length} 个 scope、${ADMIN_SECTION_META.length} 个后台分区`);
