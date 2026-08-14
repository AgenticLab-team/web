import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { now, ulidPk } from "./_shared";

/**
 * 终端客户端的设备码登录。
 *
 * ═════════════════════════════════════════
 * 一条码有两个身份，一个给人念，一个给机器
 * ═════════════════════════════════════════
 *
 * `user_code`（`WXYZ-7Q2M`）是**人要念出来、在手机上敲进去的**，
 * 所以它必须短。短就意味着熵低，也就意味着它单独不足以换令牌。
 *
 * `device_code` 是终端自己揣着的长随机串，**从不显示给任何人**。
 * 换令牌那一步只认它。
 *
 * 这样一来，「有人偷看了你屏幕上那串码」这件事的后果是
 * 「他可以替你去点同意」（而那需要他有你的账号），
 * 而不是「他直接拿到了你的令牌」。
 *
 * 两个都只存哈希，理由和 `api_tokens` 那张表一样：
 * 一次库泄漏不该等于一批正在进行的登录被劫持。
 */
export const deviceCodes = sqliteTable(
  "device_codes",
  {
    id: ulidPk(),

    /**
     * SHA-256(user_code)。
     *
     * 存哈希而不是明文，代价是**站长在库里看不到那串码** ——
     * 这是对的：他没有任何理由需要看到它，而能看到就意味着
     * 一个拿到只读库权限的人可以批准别人正在进行的登录。
     */
    userCodeHash: text("user_code_hash").notNull(),
    /** SHA-256(device_code) */
    deviceCodeHash: text("device_code_hash").notNull(),

    /**
     * `pending` → `approved` / `denied`。
     *
     * **拒绝也要落成一个状态，而不是删行** —— 删掉的话，
     * 终端下一次轮询拿到的是「找不到这条码」，
     * 它只能显示成「过期了」。而人刚刚明确点了拒绝，
     * 屏幕上却说过期，他会以为自己点错了地方然后再来一次。
     */
    status: text("status").notNull().$type<"pending" | "approved" | "denied">(),

    /** `cli`（本地二进制）或 `ssh`（网关）—— 决定可申请的 scope 和令牌有效期 */
    source: text("source").notNull().$type<"cli" | "ssh">(),

    /** 终端自己报的：机器名 · 系统 · 终端类型。确认页上显示的就是它 */
    deviceLabel: text("device_label").notNull(),

    /**
     * 发起这次登录的 IP。
     *
     * 确认页上要显示 —— 它是用户唯一能用来判断
     * 「这台设备是不是我」的**不由客户端自报**的东西。
     * 其余字段（机器名、终端）都可以被伪造成任何样子。
     */
    requestIp: text("request_ip"),

    /** 申请了哪些 scope（ScopeKey[] 的 JSON）。同意页逐条列出来的就是它 */
    scopes: text("scopes", { mode: "json" }).notNull(),

    /**
     * SSH 网关专用：这条码绑在哪一把公钥上。
     *
     * 网关上没有「用户名」这个概念可以被信任（谁都能 `anyuser@`），
     * 所以身份的真源是 SSH 公钥指纹。换一把钥匙进来就是一次新的登录。
     */
    sshKeyFingerprint: text("ssh_key_fingerprint"),

    /** 谁批的。批过之后才有值 */
    approvedByUserId: text("approved_by_user_id"),
    approvedAt: integer("approved_at"),

    /*
     * ─────────────────────────────────────────
     * 这里**没有** `consumed_at`，是故意的
     * ─────────────────────────────────────────
     *
     * 换到令牌之后这一行直接删掉。加一列「已用」看起来更有痕迹，
     * 实际是把一批已完成的登录长期留在表里，而每一行都还带着
     * `device_code_hash` —— 每一行都是一次「哪天判定写错了就能
     * 再换一把令牌」的机会。
     *
     * 删掉才没有第二次机会（`docs/OAUTH-PROVIDER.md` 第六节
     * 对 `oauth_codes` 写的是同一句话）。
     *
     * 留痕由 `api_tokens` 那一侧负责：换出去的令牌带着
     * `source` 和 `device_label`，比一个布尔列说得多。
     */

    /**
     * 用户码被输错了几次。超过上限这条就作废。
     *
     * 挡的不是暴力猜（39 位熵下不现实），是**有人拿着一堆码来试，
     * 试出别人正在登录的那一串**。
     *
     * ─────────────────────────────────────────
     * 名字里带上 `wrong_code`，不叫 `attempts`
     * ─────────────────────────────────────────
     *
     * `bind_codes` 上已经有一个 `attempts`，而 `tests/dead-columns.test.ts`
     * 判「这一列有没有人读」时，有一种写法（`row.attempts`）
     * 认不出行是哪张表的 —— 两张表同名列会**互相洗白**：
     * 这里读一次，那边那个死列就被判成在用。
     *
     * 名字取得独一份，那条守卫就仍然管得住 `bind_codes.attempts`。
     * 顺带它也更准确：数的是「码输错了几次」，不是泛泛的尝试。
     */
    wrongCodeTries: integer("wrong_code_tries").notNull().default(0),

    /** 上一次轮询。判 `slow_down` 要用 */
    lastPolledAt: integer("last_polled_at"),
    /** 客户端当前的轮询间隔（秒），被推慢过就写在这儿 */
    pollInterval: integer("poll_interval").notNull().default(5),

    createdAt: now("created_at"),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    // 两条查询路径：网页上按 user_code 找，终端轮询按 device_code 找
    uniqueIndex("device_codes_user_code_idx").on(t.userCodeHash),
    uniqueIndex("device_codes_device_code_idx").on(t.deviceCodeHash),
    // 过期清理扫这一列
    index("device_codes_expires_idx").on(t.expiresAt),
  ],
);
