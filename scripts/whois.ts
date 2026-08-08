/**
 * 查一个账号的完整状态：身份组、绑定情况、在哪些群、最近登录。
 *
 *   npm run whois -- <昵称或wxid>
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  bindCodes,
  groupMembers,
  groups,
  roles,
  sessions,
  userRoles,
  users,
} from "@/lib/db/schema";

const target = process.argv[2];

if (!target) {
  const all = db.select().from(users).orderBy(desc(users.createdAt)).all();
  console.log(`共 ${all.length} 个账号`);
  for (const u of all) {
    console.log(`  ${u.wxId}  昵称=${JSON.stringify(u.wxNickname)}  ${u.kind}/${u.status}`);
  }
  process.exit(0);
}

const user =
  db.select().from(users).where(eq(users.wxId, target)).get() ??
  db.select().from(users).where(eq(users.wxNickname, target)).get();

if (!user) {
  console.log(`本站没有「${target}」的账号`);
  process.exit(0);
}

console.log(`账号 ${user.id}`);
console.log(`  wx_id       ${user.wxId}`);
console.log(`  微信昵称     ${JSON.stringify(user.wxNickname)}`);
console.log(`  站内昵称     ${JSON.stringify(user.siteNickname)}`);
console.log(`  头像        ${user.wxAvatarUrl ?? "—"}`);
console.log(`  类型/状态    ${user.kind} / ${user.status}`);
console.log(`  等级/积分    L${user.level} / ${user.points}`);
console.log(`  首次绑定     ${user.firstBoundAt ? new Date(user.firstBoundAt).toLocaleString("zh-CN") : "—"}`);

const heldRoles = db
  .select({ key: roles.key, name: roles.name, scopeType: userRoles.scopeType, scopeId: userRoles.scopeId })
  .from(userRoles)
  .innerJoin(roles, eq(roles.id, userRoles.roleId))
  .where(and(eq(userRoles.userId, user.id), isNull(userRoles.revokedAt)))
  .all();
console.log(`  身份组      ${heldRoles.map((r) => r.name + (r.scopeId ? `@${r.scopeId}` : "")).join(", ") || "—"}`);

const memberships = db
  .select({ name: groups.name, left: groupMembers.leftAt, msgs: groupMembers.messages })
  .from(groupMembers)
  .innerJoin(groups, eq(groups.convId, groupMembers.convId))
  .where(eq(groupMembers.wxId, user.wxId!))
  .all();
console.log(`  在群        ${memberships.filter((m) => !m.left).length} 个`);
for (const m of memberships) {
  console.log(`     ${m.left ? "已退" : "在群"}  ${String(m.msgs).padStart(5)} 条  ${m.name}`);
}

const activeSessions = db
  .select()
  .from(sessions)
  .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)))
  .all();
console.log(`  活跃会话     ${activeSessions.length} 个`);

const binds = db
  .select()
  .from(bindCodes)
  .where(eq(bindCodes.matchedWxId, user.wxId!))
  .orderBy(desc(bindCodes.createdAt))
  .limit(3)
  .all();
console.log(`  最近绑定记录`);
for (const b of binds) {
  console.log(
    `     ${new Date(b.createdAt).toLocaleString("zh-CN")}  ${b.matchedChannel}  ${JSON.stringify(b.matchedSource?.slice(0, 40))}`,
  );
}
if (binds.length === 0) console.log("     —");
