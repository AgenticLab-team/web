/**
 * 给本地 demo 装一把**故意很弱**的钥匙：登录名 123，密码 123。
 *
 *   npm run demo-login
 *
 * ═════════════════════════════════════════
 * 这个脚本绕过了两条这个站自己的规矩
 * ═════════════════════════════════════════
 *
 *   · 登录名**不能全是数字**（lib/auth/login-name.ts）——
 *     纯数字会和手机号抢同一个输入框；
 *   · 密码**至少 10 位**（lib/auth/password.ts）——
 *     「长度是唯一真正有用的维度」。
 *
 * 两条都只在**设置**的时候校验，登录只验哈希（`verifyPassword`），
 * 而 `resolveIdentity` 是直接 `lower(username) = ?` 查表的。
 * 所以直接写库能造出一个这个站自己不会允许你创建的账号 ——
 * 这不是漏洞，是「校验在写入侧」的正常后果。
 *
 * 也正因为如此：**它只配用在本地看界面**。下面挡了 production，
 * 而且用的是合成种子里的那个人（scripts/seed-ui.ts），不碰真实数据。
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { credentials, users } from "@/lib/db/schema";
import { hashPassword } from "@/lib/auth/password";
import { getSettingBool, updateSetting } from "@/lib/settings/store";

const USERNAME = "123";
const PASSWORD = "123";
/** 合成种子里的站长，见 scripts/seed-ui.ts 的 P 前缀 */
const SEED_USER_ID = "seeduip_u_you";

/**
 * 「管理员必须用 Passkey」这条开关，在本地 demo 里要关掉。
 *
 * ═════════════════════════════════════════
 * 不是因为它碍事，是因为这里根本走不通 Passkey
 * ═════════════════════════════════════════
 *
 * 这个 demo 账号有 owner 角色，于是持有 dangerLevel ≥ 2 的权限，
 * `isPrivileged()` 判定为真 —— 密码通道按站点设置直接关闭，
 * 而且给的是那句最诚实的拒绝：「密码是对的，进不来是因为这条规则」。
 *
 * 那条规则是对的。问题在于**这个环境里另一条路结构上就不存在**：
 * 开发机和浏览器不是同一台，只能用局域网 IP 访问，
 * 而 WebAuthn 既不接受 IP 当 rpId、也要求安全上下文。
 * 于是两条路同时关着 —— 这正是 `lockoutRisk()` 里叫 `stranded` 的那种人。
 *
 * 所以本地关掉它。**线上不要关**：那个开关躺在库里很久没有任何代码读它，
 * 后台却显示成「开着」—— 一个显示成开的安全开关，
 * 效果是让人不再去想「管理员账号只有一道密码」这件事。
 */
const PASSKEY_RULE = "auth.require_passkey_for_admin";

function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("这个脚本只配跑在本地 —— 它装的是一把三位数的钥匙");
  }

  const user = db.select().from(users).where(eq(users.id, SEED_USER_ID)).get();
  if (!user) {
    throw new Error(
      `找不到 ${SEED_USER_ID} —— 先跑 npm run bootstrap && npm run seed-ui 灌合成数据`,
    );
  }

  db.update(users).set({ username: USERNAME }).where(eq(users.id, user.id)).run();

  // 重跑要幂等：先撤掉自己上次装的那把，别攒出一堆同名凭证
  db.delete(credentials)
    .where(eq(credentials.id, "seeduip_cred_demo"))
    .run();

  db.insert(credentials)
    .values({
      id: "seeduip_cred_demo",
      userId: user.id,
      type: "password",
      name: "本地 demo",
      secret: hashPassword(PASSWORD),
    })
    .run();

  // 见上面 PASSKEY_RULE 那段：这个环境里 Passkey 走不通，不关就是两条路全堵
  let passkeyNote = "「管理员强制 Passkey」本来就是关的";
  if (getSettingBool(PASSKEY_RULE, true)) {
    updateSetting(PASSKEY_RULE, "false", {
      actorId: user.id,
      reason: "本地 demo：局域网 IP 下 WebAuthn 用不了，不关就没有任何一条路进得来",
    });
    passkeyNote = "关掉了「管理员强制 Passkey」（只影响这个本地库）";
  }

  const site = process.env.SITE_URL ?? "http://localhost:3177";
  console.log(`\n装好了。${site}/login\n`);
  console.log(`  登录名  ${USERNAME}`);
  console.log(`  密码    ${PASSWORD}`);
  console.log(`  这个人  ${user.wxNickname ?? user.id}（合成数据，站长权限）`);
  console.log(`  顺带    ${passkeyNote}\n`);
}

main();
