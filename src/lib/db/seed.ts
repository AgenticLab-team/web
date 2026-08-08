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
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { BUILTIN_ROLES, resolveRolePermissions } from "@/lib/rbac/roles";
import { seedBoards } from "@/lib/forum/seed-boards";
import { DEFAULT_FLAGS, DEFAULT_SETTINGS } from "@/lib/settings/defaults";

export interface SeedReport {
  permissions: number;
  roles: number;
  rolePermissions: number;
  settings: number;
  flags: number;
  boards: number;
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
    settings: 0,
    flags: 0,
    boards: 0,
  };

  db.transaction((tx) => {
    // 权限点字典由代码定义，直接覆盖
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

  return report;
}
