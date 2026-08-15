#!/usr/bin/env node
//
// 变异测试：往**安全关键**的代码里下刀，看测试拦不拦得住。
//
// ═════════════════════════════════════════
// 为什么要有这个
// ═════════════════════════════════════════
//
// 一条绿色的测试只证明「代码现在这样写、测试通过」——
// 它不证明「代码写错了、测试会红」。这两件事差得很远，
// 而这个仓库今晚已经撞见过好几次：
//
//   · 一条「尊重减少动效」的测试一直绿着，而 JS 里两句
//     `behavior: "smooth"` 从它旁边绕了过去
//   · 一条按文件名点名检查 `.switch-knob` 的测试，名单本身
//     就是「同一个开关被抄了七遍」的形状
//
// 唯一能证明「测试真的在守」的办法，是把代码改坏，看它红不红。
//
//   node scripts/mutate.mjs              # 跑全部刀口
//   node scripts/mutate.mjs 权限          # 只跑名字里带「权限」的那组
//
// ─────────────────────────────────────────
// 刀口怎么挑
// ─────────────────────────────────────────
//
// **删掉一整段**是最弱的一类 —— 它太明显，几乎一定被拦。
// 真正有价值的是**方向反过来**：`!== true` 改成 `=== false`、
// 判断顺序调个个儿、比错一个字段。那些才是真正会被人写出来的错。
// 所以下面每一组里两类都有，而且注明属于哪一类。
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

/*
 * 自己把测试文件列出来，不靠 shell 展开通配符。
 * `shell: true` 会带一条弃用警告，而且参数不转义。
 */
const TEST_FILES = readdirSync(ROOT + "tests")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `tests/${f}`);

/**
 * 刀口目录。
 *
 * 每一条：`{ 组, 名字, 文件, 找什么, 换成什么 }`。
 * `换成什么` 是空串就表示整段删掉。
 */
const CUTS = [
  /* ── 权限判定 ─────────────────────────── */
  {
    group: "权限",
    name: "封禁账号照样放行",
    file: "src/lib/rbac/can.ts",
    from: 'if (actor && (actor.status === "banned" || actor.status === "deleted")) {\n    return DENY("账号已被封禁");\n  }',
    to: "",
  },
  {
    group: "权限",
    name: "身份组的「明确禁止」失效",
    file: "src/lib/rbac/can.ts",
    from: 'for (const role of roleList) {\n    if (permsByRole.get(role.roleId)?.get(permission) === false) {\n      return DENY(`身份组「${role.roleKey}」明确禁止此操作`);\n    }\n  }',
    to: "",
  },
  {
    group: "权限",
    name: "不再校验 scope（跨群越权）",
    file: "src/lib/rbac/can.ts",
    from: "if (!scopeMatches(role, resource)) continue;",
    to: "",
  },
  {
    group: "权限",
    // ★ 阴的那一类：没删任何东西，只把判断方向换了
    name: "★「没配过的权限」当成放行（提权）",
    file: "src/lib/rbac/can.ts",
    from: "if (permsByRole.get(role.roleId)?.get(permission) !== true) continue;",
    to: "if (permsByRole.get(role.roleId)?.get(permission) === false) continue;",
  },
  {
    group: "权限",
    name: "★ 用户级「授权」压过「禁止」（顺序调换）",
    file: "src/lib/rbac/can.ts",
    from: "const denied = overrides.find((o) => !o.granted);\n    if (denied) return DENY(`被单独禁止：${denied.reason}`);\n\n    const allowedOverride = overrides.find((o) => o.granted);\n    if (allowedOverride) return ALLOW(`用户级授权：${allowedOverride.reason}`);",
    to: "const allowedOverride = overrides.find((o) => o.granted);\n    if (allowedOverride) return ALLOW(`用户级授权：${allowedOverride.reason}`);\n\n    const denied = overrides.find((o) => !o.granted);\n    if (denied) return DENY(`被单独禁止：${denied.reason}`);",
  },
  {
    group: "权限",
    name: "★ 过期的用户级授权照样算数",
    file: "src/lib/rbac/can.ts",
    from: "gt(permissionOverrides.expiresAt, Date.now()),",
    to: "gt(permissionOverrides.expiresAt, 0),",
  },
  {
    group: "权限",
    name: "兜底从拒绝改成放行",
    file: "src/lib/rbac/can.ts",
    from: 'return DENY(\n    actor ? "你的身份组没有此权限" : "请先登录",\n  );',
    to: 'return ALLOW("兜底");',
  },

  /* ── 帖子可见性 ───────────────────────── */
  {
    group: "可见性",
    name: "群聊内容对游客也可见",
    file: "src/lib/forum/visibility.ts",
    from: 'if (post.fromGroupChat && viewer.kind !== "member") {\n    return deny("群聊内容仅对社群成员开放");\n  }',
    to: "",
  },
  {
    group: "可见性",
    name: "★ 群聊判定只挡 guest（external 漏出去）",
    file: "src/lib/forum/visibility.ts",
    from: 'if (post.fromGroupChat && viewer.kind !== "member") {',
    to: 'if (post.fromGroupChat && viewer.kind === "guest") {',
  },
  {
    group: "可见性",
    name: "草稿对所有人可见",
    file: "src/lib/forum/visibility.ts",
    from: 'if (post.status === "draft" && !isAuthor && !viewer.canModerate) {\n    return deny("草稿只有作者可见");\n  }',
    to: "",
  },
  {
    group: "可见性",
    name: "已删除的内容对所有人可见",
    file: "src/lib/forum/visibility.ts",
    from: 'return viewer.canModerate ? { visible: true } : deny("内容已删除");',
    to: "return { visible: true };",
  },
  {
    group: "可见性",
    name: "仅群可见 → 不检查群号",
    file: "src/lib/forum/visibility.ts",
    from: 'return viewer.groupIds.includes(post.visibilityGroupId)\n        ? { visible: true }\n        : deny("仅该群成员可见");',
    to: "return { visible: true };",
  },
  {
    group: "可见性",
    name: "private 变成人人可见",
    file: "src/lib/forum/visibility.ts",
    from: 'case "private":\n      return deny("仅作者可见");',
    to: 'case "private":\n      return { visible: true };',
  },

  /* ── 积分（钱） ───────────────────────── */
  {
    group: "积分",
    name: "余额可以扣成负数",
    file: "src/lib/points/ledger.ts",
    from: 'if (balance < 0) return { ok: false, error: "积分不足" };',
    to: "",
  },
  {
    group: "积分",
    /*
     * ⚠️ 名字里别写「可以重复入账」—— 那是错的。
     * `idempotency_key` 上有唯一索引，删掉预检也不会重复扣分，
     * 插入会撞约束、catch 那条路照样返回 duplicate。
     * 这一刀真正砍掉的是**返回值**：重复那次拿不到 balance / ledgerId，
     * 而调用方要用它们。
     */
    name: "幂等预检失效（重复那次拿不回余额和流水号）",
    file: "src/lib/points/ledger.ts",
    from: "    if (seen) {\n      return { ok: true, duplicate: true, balance: seen.balanceAfter, ledgerId: seen.id };\n    }",
    to: "",
  },
  {
    group: "积分",
    // ★ 这一处今晚真的踩过：花掉的分让人掉级
    name: "★ 花掉的分也从累计里扣（会掉级）",
    file: "src/lib/points/ledger.ts",
    from: "        input.delta > 0 ? user.pointsTotal + input.delta : user.pointsTotal;",
    to: "        user.pointsTotal + input.delta;",
  },
  {
    group: "积分",
    name: "★ 等级按余额算，而不是按累计获得",
    file: "src/lib/points/ledger.ts",
    from: "          level: levelOf(pointsTotal, configuredLevels()).level,",
    to: "          level: levelOf(balance, configuredLevels()).level,",
  },
  {
    group: "积分",
    name: "流水里记的余额和实际写进去的不是同一个数",
    file: "src/lib/points/ledger.ts",
    from: "          balanceAfter: balance,",
    to: "          balanceAfter: balance + 1,",
  },

  /* ── 会话 ─────────────────────────────── */
  {
    group: "会话",
    name: "过期的会话照样能登录",
    file: "src/lib/auth/session.ts",
    from: "gt(sessions.expiresAt, Date.now()),",
    to: "",
  },
  {
    group: "会话",
    name: "被吊销的会话照样能登录",
    file: "src/lib/auth/session.ts",
    from: "        isNull(sessions.revokedAt),\n        gt(sessions.expiresAt, Date.now()),",
    to: "        gt(sessions.expiresAt, Date.now()),",
  },
  {
    group: "会话",
    name: "封禁的人手里的旧会话还能用",
    file: "src/lib/auth/session.ts",
    from: 'if (row.user.status === "banned" || row.user.status === "deleted") return null;',
    to: "",
  },
  {
    group: "会话",
    // ★ 令牌不再哈希 —— 库里存的是哈希，明文比对等于所有人都登不上，
    //   而「登不上」这种坏法测试往往是覆盖到的；真正要问的是它有没有覆盖
    name: "★ 令牌按明文比对",
    from: "eq(sessions.tokenHash, hashToken(token)),",
    to: "eq(sessions.tokenHash, token),",
    file: "src/lib/auth/session.ts",
  },

  /* ── 限流 ─────────────────────────────── */
  {
    group: "限流",
    // 站长明确要过：这个接口是全站唯一一个未鉴权就能写库的公网端点
    name: "要设备码不再限流",
    file: "src/lib/tui/device-ratelimit.ts",
    from: "  if (recent < max) return null;",
    to: "  return null;",
  },
  {
    group: "限流",
    name: "★ 拿不到 IP 就不限流（那句被特意删掉的话又回来了）",
    file: "src/lib/tui/device-ratelimit.ts",
    from: "  const max = getSettingInt(\"tui.device.max_starts_per_hour\", 60);",
    to: "  if (!ip) return null;\n  const max = getSettingInt(\"tui.device.max_starts_per_hour\", 60);",
  },
  {
    group: "限流",
    name: "★ 时间窗从一小时放宽到一天（等于放宽 24 倍）",
    file: "src/lib/tui/device-ratelimit.ts",
    from: "          gt(deviceCodes.createdAt, now - 3_600_000),",
    to: "          gt(deviceCodes.createdAt, now - 86_400_000),",
  },
  {
    group: "限流",
    name: "登录失败不再限流",
    file: "src/lib/auth/ratelimit.ts",
    from: "  if (failures < max) return null;",
    to: "  return null;",
  },
  {
    group: "限流",
    name: "★ 连成功的登录也算进失败配额",
    file: "src/lib/auth/ratelimit.ts",
    from: "          eq(loginAttempts.success, false),\n",
    to: "",
  },

  /* ── 隐私开关 ─────────────────────────── */
  {
    group: "隐私",
    // 这一条正是站长当初报的问题：他在设置里藏了自己，
    // 而另一个管理员视角照样能在榜单上看见他
    name: "管理员又能看见藏起来的人",
    file: "src/lib/privacy/queries.ts",
    from: "    .where(eq(userPrivacy.hideFromLeaderboard, true))\n    .all();",
    to: "    .where(eq(userPrivacy.hideFromLeaderboard, true))\n    .all();\n  if (bypassesPrivacy(viewer)) return [];",
  },
  {
    group: "隐私",
    name: "★ 豁免不再区分开关，一律放行",
    file: "src/lib/privacy/queries.ts",
    from: "return spec.adminBypass && bypassesPrivacy(viewer);",
    to: "return bypassesPrivacy(viewer);",
  },
  {
    group: "隐私",
    name: "★ 排除自己时比错字段（wxId → id）",
    file: "src/lib/privacy/queries.ts",
    from: "    .where(eq(userPrivacy.hideFromLeaderboard, true))\n    .all();\n\n  return rows\n    .map((r) => r.wxId)\n    .filter((wxId): wxId is string => wxId !== null && wxId !== viewer?.wxId);",
    to: "    .where(eq(userPrivacy.hideFromLeaderboard, true))\n    .all();\n\n  return rows\n    .map((r) => r.wxId)\n    .filter((wxId): wxId is string => wxId !== null);",
  },
  {
    group: "隐私",
    name: "★ 把「不上榜单」也改成管理员可豁免",
    file: "src/lib/privacy/rules.ts",
    from: "    /** **没有豁免**。没有一件审核工作需要知道藏起来的人排第几 —— 见顶上那段 */\n    adminBypass: false,",
    to: "    adminBypass: true,",
  },
];

const filter = process.argv[2];
const cuts = filter ? CUTS.filter((c) => c.group.includes(filter) || c.name.includes(filter)) : CUTS;
if (cuts.length === 0) {
  console.error(`没有匹配「${filter}」的刀口。组别：${[...new Set(CUTS.map((c) => c.group))].join("、")}`);
  process.exit(1);
}

/**
 * 跑一次服务端测试，返回失败条数。
 *
 * ⚠️ 命令要和 `package.json` 里的 `test:server` **一模一样**。
 *
 * 我第一版写的是 `--test tests/`（传目录）——
 * 那样一个测试都不会跑，而它自己会失败一条。
 * 于是每一刀都「红了 1 条」，看起来刀刀被拦，
 * 实际上**一刀都没验过**：那 1 条从头到尾是同一个错误。
 *
 * 下面那道「下刀之前必须是绿的」的守卫就是为这个写的，
 * 而它第一次运行就把我自己拦了下来。
 */
function failures() {
  try {
    const out = execFileSync(
      "npx",
      ["tsx", "--conditions=react-server", "--test", ...TEST_FILES],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    return Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? 0);
  } catch (err) {
    const out = (err.stdout ?? "") + (err.stderr ?? "");
    return Number(out.match(/^ℹ fail (\d+)$/m)?.[1] ?? -1);
  }
}

/*
 * 先确认**没下刀之前是绿的**。
 *
 * 不确认的话，一片「✅ 被拦下」可能只是因为本来就有测试在红 ——
 * 那种全绿的报告是假的，而它长得和真的一模一样。
 */
const before = failures();
if (before !== 0) {
  console.error(`下刀之前测试就有 ${before} 条在红 —— 先把它修好，否则这一轮的结果不算数`);
  process.exit(1);
}

let survived = 0;
let ambiguous = 0;
let group = null;
for (const cut of cuts) {
  if (cut.group !== group) {
    group = cut.group;
    console.log(`\n── ${group}`);
  }
  const path = ROOT + cut.file;
  const original = readFileSync(path, "utf8");
  /*
   * ⚠️ 刀口必须**在文件里只出现一次**。
   *
   * `String.replace` 只换第一处。出现两次的话，刀就砍到了别的地方 ——
   * 而结果会显示成「这一刀活了下来」，看起来像测试有洞。
   *
   * 踩过：`isNull(sessions.revokedAt),` 在 `session.ts` 里有两处，
   * 一处在会话上限的查询里、一处在 `resolveSession` 里。
   * 刀砍中了前者，于是「被吊销的会话照样能登录」一直报活着 ——
   * 而我照着它去补的那条测试其实早就守住了。
   * 差一点就得出「吊销功能没人测」这个错误结论。
   */
  const hits = original.split(cut.from).length - 1;
  if (hits === 0) {
    console.log(`  ⚠️  ${cut.name}：刀口没对上（代码改过了？这一条要跟着更新）`);
    continue;
  }
  if (hits > 1) {
    console.log(`  ⚠️  ${cut.name}：刀口在 ${cut.file} 里出现了 ${hits} 次 —— 写具体一点，否则砍的是别处`);
    ambiguous++;
    continue;
  }
  writeFileSync(path, original.replace(cut.from, cut.to));
  let n;
  try {
    n = failures();
  } finally {
    writeFileSync(path, original);   // 无论如何都还原
  }
  if (n > 0) {
    console.log(`  ✅ ${cut.name}（红了 ${n} 条）`);
  } else {
    survived++;
    console.log(`  ❌ ${cut.name} —— **没人管**`);
  }
}

const note = ambiguous ? `（另有 ${ambiguous} 条刀口不唯一，没砍）` : "";
console.log(
  survived === 0
    ? `\n${cuts.length - ambiguous} 刀，一刀都没漏。${note}`
    : `\n❌ ${survived} 刀活了下来 —— 那几处的测试是绿的，但它不守。${note}`,
);
process.exit(survived === 0 && ambiguous === 0 ? 0 : 1);
