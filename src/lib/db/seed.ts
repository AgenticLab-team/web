import "server-only";

import { eq } from "drizzle-orm";

import { db } from "./index";
import {
  featureFlags,
  permissions as permissionsTable,
  rolePermissions,
  roles,
  settings,
} from "./schema";
import { RETIRED_FLAGS } from "@/lib/flags/registry";
import { runRepairs } from "./repairs";
import { PERMISSIONS, RETIRED_PERMISSIONS } from "@/lib/rbac/permissions";
import { BUILTIN_ROLES, resolveRolePermissions } from "@/lib/rbac/roles";
import { seedBoards } from "@/lib/forum/seed-boards";
import { seedTitles } from "@/lib/titles/seed-titles";
import { seedShopItems } from "@/lib/shop/seed-items";
import { seedMailDomains } from "@/lib/mail/seed-domains";
import { DEFAULT_FLAGS, DEFAULT_SETTINGS, RETIRED_SETTINGS } from "@/lib/settings/defaults";

export interface SeedReport {
  permissions: number;
  roles: number;
  rolePermissions: number;
  /** 这次启动清掉了几个退役的权限点 */
  permissionsRetired: number;
  /** 这次启动清掉了几个退役的功能开关 */
  flagsRetired: number;
  /** 这次启动修好的历史数据 —— 空数组表示没有需要修的 */
  repaired: { key: string; fixed: number }[];
  settings: number;
  /** 这次启动清掉了几个退役的配置项 —— 数字不为零时值得在日志里看见 */
  settingsRetired: number;
  flags: number;
  boards: number;
  titles: number;
  shopItems: number;
  /** 邮箱域名池：新写入 / 认到人头上 / punycode 出问题的 */
  mailDomains: number;
  mailClaimed: number;
  mailBanwords: number;
  mailPunycodeProblems: string[];
  /** 这次靠匹配认出来的域名归属 —— 「凭什么是他的」写在 why 里 */
  mailMatched: { domain: string; userId: string; why: string }[];
  mailExpiryFilled: number;
}

/**
 * 幂等种子。每次启动都跑：
 * 权限点以代码为准强制覆盖，配置项只补不改（管理员改过的值不能被重置）。
 */
export function seedDatabase(): SeedReport {
  const report: SeedReport = {
    permissions: 0,
    roles: 0,
    rolePermissions: 0,
    permissionsRetired: 0,
    flagsRetired: 0,
    repaired: [],
    settings: 0,
    settingsRetired: 0,
    flags: 0,
    boards: 0,
    titles: 0,
    shopItems: 0,
    mailDomains: 0,
    mailClaimed: 0,
    mailBanwords: 0,
    mailPunycodeProblems: [],
    mailMatched: [],
    mailExpiryFilled: 0,
  };

  db.transaction((tx) => {
    // 权限点字典由代码定义，直接覆盖
    /*
     * 先把退役的权限点从库里清掉。
     *
     * 权限矩阵那一页读的是库里的 `permissions` 表，不是代码里的清单 ——
     * 只删清单的话，那个勾照样摆在矩阵上，而且再没有人知道它是死的。
     *
     * `role_permissions` 里的授权行也要一起删：留着的话，
     * 「谁拥有 X」的反查会列出一批人，而 X 已经不存在了。
     */
    for (const retired of RETIRED_PERMISSIONS) {
      tx.delete(rolePermissions).where(eq(rolePermissions.permissionKey, retired.key)).run();
      const gone = tx.delete(permissionsTable).where(eq(permissionsTable.key, retired.key)).run();
      if (gone.changes > 0) report.permissionsRetired++;
    }

    for (const def of PERMISSIONS) {
      tx.insert(permissionsTable)
        .values({
          key: def.key,
          category: def.category,
          label: def.label,
          description: "description" in def ? def.description : null,
          scopable: "scopable" in def ? Boolean(def.scopable) : false,
          dangerLevel: "dangerLevel" in def ? (def.dangerLevel ?? 0) : 0,
        })
        .onConflictDoUpdate({
          target: permissionsTable.key,
          set: {
            category: def.category,
            label: def.label,
            description: "description" in def ? def.description : null,
            scopable: "scopable" in def ? Boolean(def.scopable) : false,
            dangerLevel: "dangerLevel" in def ? (def.dangerLevel ?? 0) : 0,
          },
        })
        .run();
      report.permissions++;
    }

    for (const roleDef of BUILTIN_ROLES) {
      const existing = tx.select().from(roles).where(eq(roles.key, roleDef.key)).get();

      let roleId: string;
      if (existing) {
        roleId = existing.id;
        // 内置角色的展示属性跟随代码，但不动管理员可能调过的 priority 之外的东西
        tx.update(roles)
          .set({
            name: roleDef.name,
            description: roleDef.description,
            color: roleDef.color,
            icon: roleDef.icon,
            isSystem: true,
            updatedAt: Date.now(),
          })
          .where(eq(roles.id, roleId))
          .run();
      } else {
        const inserted = tx
          .insert(roles)
          .values({
            key: roleDef.key,
            name: roleDef.name,
            description: roleDef.description,
            color: roleDef.color,
            icon: roleDef.icon,
            priority: roleDef.priority,
            isSystem: true,
            assignable: roleDef.key !== "guest",
          })
          .returning({ id: roles.id })
          .get();
        roleId = inserted.id;
        report.roles++;
      }

      // 内置角色的权限集合以代码为准：先清空再写入，避免代码删掉的权限残留在库里
      tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId)).run();

      for (const key of resolveRolePermissions(roleDef)) {
        tx.insert(rolePermissions).values({ roleId, permissionKey: key, granted: true }).run();
        report.rolePermissions++;
      }
      for (const key of roleDef.denies ?? []) {
        tx.insert(rolePermissions)
          .values({ roleId, permissionKey: key, granted: false })
          .onConflictDoUpdate({
            target: [rolePermissions.roleId, rolePermissions.permissionKey],
            set: { granted: false },
          })
          .run();
      }
    }

    /*
     * ─────────────────────────────────────────
     * 先把退役的配置项从库里删掉
     * ─────────────────────────────────────────
     *
     * 后台那一页列的是**库里的行**，不是 DEFAULT_SETTINGS。
     * 只从清单里删，那个旋钮照样摆在后台 ——
     * 而且从此再没有人知道它是死的。
     *
     * 顺序要在插入之前：一个键如果同时出现在两张表里（改错了），
     * 先删后插至少还原成「它在」，不会变成「时有时无」。
     * 那种不一致查起来最费劲。
     *
     * 历史记录（setting_history）不动 —— 谁在什么时候把它拨成什么，
     * 是审计要用的，不该跟着旋钮一起消失。
     */
    for (const retired of RETIRED_SETTINGS) {
      const gone = tx.delete(settings).where(eq(settings.key, retired.key)).run();
      if (gone.changes > 0) report.settingsRetired++;
    }

    // 配置项只在缺失时插入 —— 管理员改过的值绝不能被启动流程重置
    for (const def of DEFAULT_SETTINGS) {
      const result = tx
        .insert(settings)
        .values({
          key: def.key,
          value: def.value,
          type: def.type,
          category: def.category,
          label: def.label,
          description: def.description,
          defaultValue: def.value,
          minValue: def.min,
          maxValue: def.max,
          requiresPermission: def.requiresPermission,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) report.settings++;
    }

    /*
     * 一次性数据修复 —— 代码里的 bug 修掉之后，
     * 它写进库里的坏数据不会自己变好。每一条都是幂等的，
     * 修完之后再也匹配不到行。说明见 lib/db/repairs.ts。
     */
    report.repaired = runRepairs(tx as never).filter((r) => r.fixed > 0);

    /*
     * 退役的开关先从库里清掉 —— 后台那一页读的是库里的行，
     * 不是代码里的清单。只删清单的话那个开关照样摆着。
     */
    for (const retired of RETIRED_FLAGS) {
      const gone = tx.delete(featureFlags).where(eq(featureFlags.key, retired.key)).run();
      if (gone.changes > 0) report.flagsRetired++;
    }

    for (const flag of DEFAULT_FLAGS) {
      const result = tx
        .insert(featureFlags)
        .values({
          key: flag.key,
          enabled: flag.enabled,
          description: flag.description,
        })
        .onConflictDoNothing()
        .run();
      if (result.changes > 0) report.flags++;
    }
  });

  report.boards = seedBoards();
  report.titles = seedTitles();
  report.shopItems = seedShopItems();

  const mail = seedMailDomains();
  report.mailDomains = mail.domains;
  report.mailClaimed = mail.claimed;
  report.mailBanwords = mail.banwords;
  report.mailPunycodeProblems = mail.punycodeProblems;
  report.mailMatched = mail.matched;
  report.mailExpiryFilled = mail.expiryFilled;

  return report;
}
