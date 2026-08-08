/**
 * 授予身份组。首个站长必须用这个从命令行授予 —— 后台自身需要有人先能进去。
 *
 *   npm run grant -- <昵称或wxid> <角色key>
 *   npm run grant -- jmr owner
 *   npm run grant                      列出所有角色与当前持有者
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, groupMembers, roles, userRoles, users } from "@/lib/db/schema";
import { nekobot } from "@/lib/nekobot/client";

const [target, roleKey] = process.argv.slice(2);

function listRoles() {
  const all = db.select().from(roles).orderBy(roles.priority).all();
  console.log("角色              持有者");
  for (const role of all.reverse()) {
    const holders = db
      .select({ nickname: users.wxNickname, siteName: users.siteNickname, wxId: users.wxId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(and(eq(userRoles.roleId, role.id), isNull(userRoles.revokedAt)))
      .all();
    const names = holders.map((h) => h.siteName ?? h.nickname ?? h.wxId).join(", ");
    console.log(`  ${role.key.padEnd(14)} ${names || "—"}`);
  }
}

async function resolveWxId(input: string): Promise<{ wxId: string; name: string } | null> {
  // 已经是 wxid 就直接用
  const direct = db
    .select({ wxId: groupMembers.wxId, name: groupMembers.displayName })
    .from(groupMembers)
    .where(eq(groupMembers.wxId, input))
    .get();
  if (direct) return { wxId: direct.wxId, name: direct.name ?? input };

  const results = await nekobot.searchUsers(input, 10);
  if (results.length === 0) return null;
  if (results.length > 1) {
    console.log(`「${input}」匹配到多个，请用 wxid 指定：`);
    for (const r of results) console.log(`  ${r.wx_id}  ${r.name}  (${r.messages} 条)`);
    return null;
  }
  return { wxId: results[0].wx_id, name: results[0].name };
}

async function main() {
  if (!target || !roleKey) {
    listRoles();
    return;
  }

  const role = db.select().from(roles).where(eq(roles.key, roleKey)).get();
  if (!role) {
    console.error(`没有 key 为「${roleKey}」的角色`);
    process.exit(1);
  }

  const resolved = await resolveWxId(target);
  if (!resolved) {
    console.error(`找不到「${target}」`);
    process.exit(1);
  }

  let user = db.select().from(users).where(eq(users.wxId, resolved.wxId)).get();
  if (!user) {
    // 还没登录过也可以先授权，等他绑定时直接就是这个身份
    user = db
      .insert(users)
      .values({
        wxId: resolved.wxId,
        wxNickname: resolved.name,
        wxAvatarUrl: null,
        kind: "member",
        status: "active",
      })
      .returning()
      .get();
    console.log(`已创建账号：${user.wxNickname}（${user.wxId}）`);
  }

  const existing = db
    .select()
    .from(userRoles)
    .where(
      and(
        eq(userRoles.userId, user.id),
        eq(userRoles.roleId, role.id),
        isNull(userRoles.revokedAt),
      ),
    )
    .get();

  if (existing) {
    console.log(`${user.wxNickname} 已经是 ${role.name} 了`);
    return;
  }

  db.transaction((tx) => {
    tx.insert(userRoles)
      .values({
        userId: user!.id,
        roleId: role.id,
        grantedBy: "cli",
        grantReason: "命令行授予",
      })
      .run();

    // 命令行授权同样进审计日志 —— 这条规则没有例外
    tx.insert(auditLogs)
      .values({
        actorId: "cli",
        action: "role.grant",
        targetType: "user",
        targetId: user!.id,
        targetLabel: user!.wxNickname ?? user!.wxId,
        after: { role: role.key },
        reason: "命令行授予",
        dangerLevel: 3,
      })
      .run();
  });

  console.log(`✓ ${user.wxNickname}（${user.wxId}）现在是「${role.name}」`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
