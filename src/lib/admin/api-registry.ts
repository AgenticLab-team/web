import "server-only";

import {
  ADMIN_SECTION_KEYS,
  ADMIN_SECTION_META,
  type AdminSectionMeta,
} from "@/lib/admin/api-section-rules";

/**
 * 后台在开放 API 上的分区注册表。
 *
 * ═════════════════════════════════════════
 * 三十个后台页，三条端点
 * ═════════════════════════════════════════
 *
 * 一页一条端点是五十多条：三十个读、二十多个写。那意味着加一个
 * 后台页要在**三个地方**各写一遍（页面、路由文件、API 目录），
 * 而三处里迟早有一处会被忘掉 —— 忘掉的那一处不会报错。
 *
 * 现在它们共用 `GET`/`POST /api/v1/admin/{section}`，
 * 分工全在这张表里。
 *
 * ═════════════════════════════════════════
 * 它**不放大任何权限**
 * ═════════════════════════════════════════
 *
 * 每个分区声明自己要哪个权限点，而真正的判定仍然由
 * `requireAdmin` / `requireWritableAdmin` 在动作函数内部做 ——
 * 这里声明的那一份是给**列分区**用的（「我能进哪几个」），
 * 不是给放行用的。
 *
 * 两处判定听起来像是重复，其实方向相反：
 *   · 这里判错（写宽了）→ 终端里多列出一个分区，点进去 403
 *   · 动作函数里判错 → 真的越权
 *
 * 所以这里可以是「大致的」，那里必须是准的。反过来就不行。
 *
 * ═════════════════════════════════════════
 * 写操作一律调**网页那边同一个动作函数**
 * ═════════════════════════════════════════
 *
 * 不在这里重写任何一条业务逻辑。那些函数里有
 * `requireWritableAdmin("权限点")`、有 `audit(...)`、有预览态拦截 ——
 * 后台写操作的「必备三件套」（`ARCHITECTURE.md` 第四节）。
 *
 * 重写一份的话，这三样里迟早漏掉一样，而漏掉的后果是
 * **管理员以别人的身份写了数据，审计日志记在被预览的人头上**。
 *
 * 身份怎么传进那些函数：见 `lib/api-tokens/as-caller.ts`。
 */

export interface AdminActionSpec {
  key: string;
  label: string;
  /**
   * 危险等级。≥2 的动作要求请求体里带 `confirm: true`。
   *
   * ─────────────────────────────────────────
   * 它挡的是「脚本手滑」，不是「有人恶意」
   * ─────────────────────────────────────────
   *
   * 恶意的那个人当然会把 `confirm` 填上。这一条防的是
   * 一个 `for` 循环写错了对象、或者一次复制粘贴把
   * 「封禁」的请求体发给了「加备注」—— 而后者在后台里
   * 是真实发生过的一类事故。
   */
  danger?: number;
  /** 这个动作要哪些字段。会随 `/admin/sections` 一起发给终端，用来画表单 */
  fields: { name: string; label: string; type: "string" | "number" | "boolean"; required?: boolean }[];
  run: (body: Record<string, unknown>) => Promise<{ ok: boolean; error?: string | null }>;
}

/**
 * 一个分区的**实现**：怎么读、能做哪些动作。
 *
 * 名字、说明、权限点不在这里 —— 它们在 `api-section-rules.ts`，
 * 那一份是纯数据、不拖数据库，对齐守卫读的是它。
 * 两份的键必须一一对应，`tests/tui-parity.test.ts` 盯着。
 */
export interface AdminSectionImpl {
  /** 读这个分区。`id` 有值时是详情 */
  read: (input: { id: string | null; query: string; limit: number; offset: number }) => unknown;
  actions: AdminActionSpec[];
}

export type AdminSection = AdminSectionMeta & AdminSectionImpl;

/* ── 读：全部走网页那边同一批查询函数 ─────────────────── */

import { allGrants, revokeAllSshTokens, sendLog } from "@/lib/api-tokens/store";
import { domainSummary, listBoxes, listDomains, recentRejections } from "@/lib/mail/admin-queries";
import { listApps } from "@/lib/oauth/store";
import { listAlerts } from "@/lib/alerts/dispatch";
import { domainExportCounts } from "@/lib/activities/export";
import { listModules as listActivityModules } from "@/lib/activities/registry";
import { appealFacets, appealQueue } from "@/lib/admin/appeals";
import { auditActionFacets, queryAuditLogs } from "@/lib/admin/audit-query";
import { listBoardsForAdmin, listTagsForAdmin, orphanTags } from "@/lib/admin/boards";
import { systemStatus } from "@/lib/admin/dashboard";
import { dailyCapPressure, economySnapshot, topEarners } from "@/lib/admin/economy";
import { escalationFacets, escalationQueue } from "@/lib/admin/escalation";
import { listGroupsForAdmin, cursors, retryableJobs, syncOverview, upstreamStatus } from "@/lib/admin/groups";
import { buildMatrix } from "@/lib/admin/permissions";
import { reportFacets, reportQueue } from "@/lib/admin/reports";
import { listSettings, modifiedCount } from "@/lib/admin/settings";
import { getUserDetail, listDepartures, listUsers, userFacets } from "@/lib/admin/users";
import { offsiteSummary } from "@/lib/backup/offsite";
import { recentDigests } from "@/lib/digest/build";
import { listFlagsForAdmin, orphanFlagKeys } from "@/lib/flags/server";
import { awaitingConsent, readyToRaise } from "@/lib/forum/consent-queue";
import { listPosts } from "@/lib/forum/queries";
import { GUEST } from "@/lib/forum/visibility";
import { recentJoinRequests } from "@/lib/join/actions";
import { inviteUseStats, listInvites, pendingRewards } from "@/lib/invites/queries";
import { enrichProgress } from "@/lib/links/enrich";
import { moduleHealth } from "@/lib/modules/health";
import { listAllLedger, ledgerSummary, riskQueue } from "@/lib/points/admin";
import { configuredLevels, levelCounts, levelsHealth } from "@/lib/points/levels";
import { listRoles } from "@/lib/rbac/role-admin";
import { listItems, pagedOrders, pendingShipments } from "@/lib/shop/queries";
import { recentPruneTasks, storageOverview } from "@/lib/storage/queries";
import { usageSummary } from "@/lib/upstream/usage";
import { db } from "@/lib/db";
import { sensitiveWords } from "@/lib/db/schema";
import { todayKey } from "@/lib/time";

/* ── 写：一律是网页那边的动作函数，这里只做参数映射 ───── */

import { audit } from "@/lib/audit";
import { requireWritableAdmin } from "@/lib/admin/guard";
import { approveAndExecute, rejectApproval } from "@/lib/admin/approval-actions";
import { createBoard, updateBoard } from "@/lib/admin/board-actions";
import { approveEscalation, rejectEscalation } from "@/lib/admin/escalation-actions";
import { retryAllFailed, triggerSync, updateGroupConfig } from "@/lib/admin/group-actions";
import { bulkModeratePosts } from "@/lib/admin/post-actions";
import { claimReports, resolveReports } from "@/lib/admin/report-actions";
import { changeSetting, resetSetting } from "@/lib/admin/setting-actions";
import {
  addUserNote,
  adjustPoints,
  grantRole,
  revokeRole,
  revokeUserSessions,
  setUserStatus,
} from "@/lib/admin/user-actions";
import { addWord, removeWord } from "@/lib/admin/word-actions";
import { handleAppeal } from "@/lib/forum/appeals";
import { queueSend, saveDraft as saveBroadcastDraft } from "@/lib/broadcast/actions";
import { setFlagEnabled } from "@/lib/flags/actions";
import { createInvite, revokeInvite } from "@/lib/invites/actions";
import { setModuleEnabled } from "@/lib/modules/actions";
import { revertLedgerEntry } from "@/lib/points/admin-actions";
import { saveLevels } from "@/lib/points/level-actions";
import { createPruneTask, executePruneTask } from "@/lib/storage/actions";

/** 从请求体里取一个必填字符串。取不到就让动作函数自己去报错 */
const str = (b: Record<string, unknown>, k: string): string =>
  typeof b[k] === "string" ? (b[k] as string) : "";
const num = (b: Record<string, unknown>, k: string): number =>
  typeof b[k] === "number" ? (b[k] as number) : Number(b[k]) || 0;
const bool = (b: Record<string, unknown>, k: string): boolean => b[k] === true;

const IMPLS: readonly ({ key: string } & AdminSectionImpl)[] = [
  {
    key: "dashboard",
    read: () => systemStatus(),
    actions: [],
  },
  {
    key: "health",
    read: ({ limit }) => ({
      status: systemStatus(),
      upstream: usageSummary(),
      alerts: listAlerts(limit),
    }),
    actions: [],
  },
  {
    key: "storage",
    read: ({ limit }) => ({ overview: storageOverview(), tasks: recentPruneTasks(limit) }),
    actions: [
      {
        key: "plan_prune",
        label: "生成一个裁剪计划",
        /*
         * 没有参数：保留多少天是**系统设置**里的事，不是这次调用的事。
         * 让调用方传一个天数，等于开了一条绕过设置页（有历史、可回滚）
         * 的路，而裁剪是不可逆的。
         */
        fields: [],
        run: async () => createPruneTask(),
      },
      {
        key: "run_prune",
        label: "执行裁剪计划",
        /*
         * 危险级 2：裁掉的消息**找不回来**（异地备份里还有，
         * 但那是一次恢复演练，不是一次撤销）。
         */
        danger: 2,
        fields: [{ name: "task_id", label: "计划 id", type: "string", required: true }],
        run: async (b) => executePruneTask({ taskId: str(b, "task_id") }),
      },
    ],
  },
  {
    key: "backup",
    read: () => offsiteSummary(),
    actions: [],
  },
  {
    key: "audit",
    read: ({ query, limit }) => ({
      facets: auditActionFacets(),
      logs: queryAuditLogs({ action: query || undefined, perPage: limit }),
    }),
    actions: [],
  },
  {
    key: "users",
    read: ({ id, query, limit }) =>
      id
        ? getUserDetail(id)
        : {
            facets: userFacets(),
            users: listUsers({ keyword: query || undefined, perPage: limit }),
            departures: listDepartures(),
          },
    actions: [
      {
        key: "adjust_points",
        label: "调整积分",
        danger: 1,
        fields: [
          { name: "user_id", label: "用户 id", type: "string", required: true },
          { name: "delta", label: "加减多少", type: "number", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          adjustPoints({ userId: str(b, "user_id"), delta: num(b, "delta"), reason: str(b, "reason") }),
      },
      {
        key: "set_status",
        label: "改账号状态（封禁 / 解封）",
        /* 把人挡在门外，而且他不一定知道为什么 —— 要显式确认 */
        danger: 2,
        fields: [
          { name: "user_id", label: "用户 id", type: "string", required: true },
          { name: "status", label: "active / banned", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
          { name: "days", label: "封多少天（不填是永久）", type: "number" },
        ],
        run: async (b) =>
          setUserStatus({
            userId: str(b, "user_id"),
            status: str(b, "status") as never,
            reason: str(b, "reason"),
            /* 上游收的是秒，而人想的是天 —— 换算在这里做一次 */
            durationSeconds: b.days === undefined ? undefined : num(b, "days") * 86400,
          }),
      },
      {
        key: "grant_role",
        label: "发一个身份组",
        danger: 2,
        fields: [
          { name: "user_id", label: "用户 id", type: "string", required: true },
          { name: "role_key", label: "身份组 key", type: "string", required: true },
          { name: "reason", label: "理由", type: "string" },
        ],
        run: async (b) =>
          grantRole({ userId: str(b, "user_id"), roleKey: str(b, "role_key"), reason: str(b, "reason") }),
      },
      {
        key: "revoke_role",
        label: "收回一个身份组",
        danger: 2,
        fields: [
          /*
           * 收回要的是**那一次授予的 id**，不是 (人, 身份组)。
           * 因为同一个身份组可以在不同 scope 上授予多次
           * （版主：A 版一次、B 版一次），按 (人, 组) 收回会收错一个。
           */
          { name: "user_role_id", label: "那次授予的 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => revokeRole({ userRoleId: str(b, "user_role_id"), reason: str(b, "reason") }),
      },
      {
        key: "revoke_sessions",
        label: "把他所有设备踢下线",
        danger: 1,
        fields: [
          { name: "user_id", label: "用户 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => revokeUserSessions({ userId: str(b, "user_id"), reason: str(b, "reason") }),
      },
      {
        key: "add_note",
        label: "加一条备注",
        fields: [
          { name: "user_id", label: "用户 id", type: "string", required: true },
          { name: "note", label: "备注", type: "string", required: true },
        ],
        run: async (b) => addUserNote({ userId: str(b, "user_id"), content: str(b, "note") }),
      },
    ],
  },
  {
    key: "user",
    read: ({ id }) => (id ? getUserDetail(id) : null),
    actions: [],
  },
  {
    key: "binds",
    read: ({ limit }) => recentJoinRequests(limit),
    actions: [],
  },
  {
    key: "roles",
    read: () => ({ roles: listRoles(), matrix: buildMatrix() }),
    actions: [],
  },
  {
    key: "invites",
    read: () => ({
      invites: listInvites(),
      stats: inviteUseStats(),
      pending: pendingRewards(),
    }),
    actions: [
      {
        key: "create",
        label: "建一个邀请码",
        fields: [
          { name: "note", label: "备注（给谁）", type: "string" },
          { name: "max_uses", label: "最多用几次", type: "number" },
          { name: "expires_in_days", label: "几天后过期（不填是不过期）", type: "number" },
        ],
        run: async (b) =>
          createInvite({
            note: str(b, "note"),
            maxUses: num(b, "max_uses") || 1,
            expiresInDays: num(b, "expires_in_days") || null,
          }),
      },
      {
        key: "revoke",
        label: "作废一个邀请码",
        danger: 1,
        fields: [
          { name: "id", label: "邀请码 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => revokeInvite({ id: str(b, "id"), reason: str(b, "reason") }),
      },
    ],
  },
  {
    key: "reports",
    read: ({ query, limit }) => ({
      facets: reportFacets(),
      queue: reportQueue({ status: query || undefined, limit }),
      consent: { awaiting: awaitingConsent(), ready: readyToRaise() },
    }),
    actions: [
      /*
       * ─────────────────────────────────────────
       * 认领和处理的对象是**被举报的那个东西**，不是某一条举报
       * ─────────────────────────────────────────
       *
       * 同一篇帖子会被十个人各举报一次。按举报 id 逐条处理的话，
       * 处理完第一条之后，剩下九条还挂在队列上 —— 而它们说的是同一件事。
       *
       * 所以队列本来就是按 (目标类型, 目标 id) 聚合的，
       * 这两个动作跟着它走。
       */
      {
        key: "claim",
        label: "认领",
        fields: [
          { name: "target_type", label: "post / reply / user", type: "string", required: true },
          { name: "target_id", label: "目标 id", type: "string", required: true },
        ],
        run: async (b) =>
          claimReports({ targetType: str(b, "target_type"), targetId: str(b, "target_id") }),
      },
      {
        key: "resolve",
        label: "处理掉",
        danger: 1,
        fields: [
          { name: "target_type", label: "post / reply / user", type: "string", required: true },
          { name: "target_id", label: "目标 id", type: "string", required: true },
          { name: "outcome", label: "resolved / rejected / duplicate", type: "string", required: true },
          { name: "resolution", label: "说明", type: "string", required: true },
        ],
        run: async (b) =>
          resolveReports({
            targetType: str(b, "target_type"),
            targetId: str(b, "target_id"),
            outcome: str(b, "outcome") as never,
            resolution: str(b, "resolution"),
          }),
      },
    ],
  },
  {
    key: "appeals",
    read: ({ query, limit }) => ({
      facets: appealFacets(),
      queue: appealQueue({ status: query || undefined, perPage: limit }),
    }),
    actions: [
      {
        key: "handle",
        label: "处理一条申诉",
        danger: 1,
        fields: [
          { name: "appeal_id", label: "申诉 id", type: "string", required: true },
          { name: "accept", label: "是否采纳", type: "boolean", required: true },
          { name: "reply", label: "回复", type: "string", required: true },
        ],
        run: async (b) =>
          handleAppeal({
            appealId: str(b, "appeal_id"),
            accept: bool(b, "accept"),
            response: str(b, "reply"),
          }),
      },
    ],
  },
  {
    key: "posts",
    read: ({ query, limit, offset }) =>
      listPosts(GUEST, { limit, offset, sort: query === "hot" ? "hot" : "recent" }),
    actions: [
      {
        key: "bulk_moderate",
        label: "批量处理",
        danger: 2,
        fields: [
          { name: "ids", label: "帖子 id（逗号分隔）", type: "string", required: true },
          { name: "action", label: "动作", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          bulkModeratePosts({
            ids: str(b, "ids").split(",").map((s) => s.trim()).filter(Boolean),
            action: str(b, "action") as never,
            reason: str(b, "reason"),
          }),
      },
    ],
  },
  {
    key: "escalation",
    read: ({ query, limit }) => ({
      facets: escalationFacets(),
      queue: escalationQueue({ status: query || undefined, limit }),
    }),
    actions: [
      {
        key: "approve",
        label: "同意",
        danger: 2,
        fields: [
          { name: "id", label: "请求 id", type: "string", required: true },
          { name: "note", label: "说明", type: "string", required: true },
        ],
        run: async (b) => approveEscalation({ id: str(b, "id"), note: str(b, "note") }),
      },
      {
        key: "reject",
        label: "驳回",
        danger: 1,
        fields: [
          { name: "id", label: "请求 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => rejectEscalation({ id: str(b, "id"), note: str(b, "reason") }),
      },
    ],
  },
  {
    key: "approvals",
    read: ({ limit }) => queryAuditLogs({ action: "approval", perPage: limit }),
    actions: [
      {
        key: "approve",
        label: "批准并执行",
        danger: 2,
        fields: [
          { name: "id", label: "审批 id", type: "string", required: true },
          { name: "note", label: "说明", type: "string", required: true },
        ],
        run: async (b) => approveAndExecute({ id: str(b, "id"), note: str(b, "note") }),
      },
      {
        key: "reject",
        label: "驳回",
        danger: 1,
        fields: [
          { name: "id", label: "审批 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => rejectApproval({ id: str(b, "id"), note: str(b, "reason") }),
      },
    ],
  },
  {
    key: "words",
    read: ({ limit, offset }) =>
      db.select().from(sensitiveWords).limit(limit).offset(offset).all(),
    actions: [
      {
        key: "add",
        label: "加一个词",
        fields: [
          { name: "word", label: "词", type: "string", required: true },
          { name: "kind", label: "block / replace / warn", type: "string", required: true },
          { name: "replacement", label: "替换成什么（kind=replace 时）", type: "string" },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          addWord({
            word: str(b, "word"),
            kind: str(b, "kind") as never,
            replacement: str(b, "replacement") || undefined,
            reason: str(b, "reason"),
          }),
      },
      {
        key: "remove",
        label: "删一个词",
        fields: [
          { name: "id", label: "id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => removeWord({ id: str(b, "id"), reason: str(b, "reason") }),
      },
    ],
  },
  {
    key: "boards",
    read: () => ({
      boards: listBoardsForAdmin(),
      tags: listTagsForAdmin(),
      orphanTags: orphanTags(),
    }),
    actions: [
      /*
       * ─────────────────────────────────────────
       * 三个可见性字段一个都不能省，所以它们全是必填
       * ─────────────────────────────────────────
       *
       * `visibleTo`（谁看得到这个版块）、`defaultVisibility`（新帖默认多公开）、
       * `maxVisibility`（这个版块里最公开能到哪）是三件不同的事。
       *
       * 给它们默认值是很自然的写法，也是这里最危险的一处：
       * 一个漏填的建版请求会拿到一个**默认公开**的版块，
       * 而建它的人以为自己建的是个内部版。
       *
       * 所以宁可让调用方多传三个字段。
       */
      {
        key: "create",
        label: "建一个版块",
        fields: [
          { name: "key", label: "版块 key", type: "string", required: true },
          { name: "name", label: "名字", type: "string", required: true },
          { name: "visible_to", label: "谁看得到这个版块", type: "string", required: true },
          { name: "default_visibility", label: "新帖默认可见性", type: "string", required: true },
          { name: "max_visibility", label: "最公开能到哪", type: "string", required: true },
          { name: "post_min_level", label: "发帖等级门槛", type: "number", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
          { name: "description", label: "版块说明", type: "string" },
        ],
        run: async (b) =>
          createBoard({
            key: str(b, "key"),
            name: str(b, "name"),
            description: str(b, "description") || undefined,
            visibleTo: str(b, "visible_to") as never,
            defaultVisibility: str(b, "default_visibility") as never,
            maxVisibility: str(b, "max_visibility") as never,
            postMinLevel: num(b, "post_min_level"),
            reason: str(b, "reason"),
          }),
      },
      {
        key: "update",
        label: "改一个版块",
        fields: [
          { name: "id", label: "版块 id", type: "string", required: true },
          { name: "name", label: "名字", type: "string", required: true },
          { name: "visible_to", label: "谁看得到这个版块", type: "string", required: true },
          { name: "default_visibility", label: "新帖默认可见性", type: "string", required: true },
          { name: "max_visibility", label: "最公开能到哪", type: "string", required: true },
          { name: "post_min_level", label: "发帖等级门槛", type: "number", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          updateBoard({
            id: str(b, "id"),
            name: str(b, "name"),
            visibleTo: str(b, "visible_to") as never,
            defaultVisibility: str(b, "default_visibility") as never,
            maxVisibility: str(b, "max_visibility") as never,
            postMinLevel: num(b, "post_min_level"),
            reason: str(b, "reason"),
          }),
      },
    ],
  },
  {
    key: "groups",
    read: () => ({
      groups: listGroupsForAdmin(),
      sync: syncOverview(),
      cursors: cursors(),
      retryable: retryableJobs(),
      upstream: upstreamStatus(),
    }),
    actions: [
      {
        key: "set_sync",
        label: "开关某个群的同步",
        /*
         * 群配置是**整体保存**的，不是逐字段打补丁。
         *
         * 打补丁的写法（只传要改的那个）在这里很危险：没传的字段
         * 是「别动」还是「设成默认」，取决于实现细节 ——
         * 而其中一个字段是「这个群算不算积分」。
         */
        fields: [
          { name: "conv_id", label: "群 id", type: "string", required: true },
          { name: "sync_excluded", label: "排除同步", type: "boolean", required: true },
          { name: "count_for_points", label: "算不算积分", type: "boolean", required: true },
          { name: "public_leaderboard", label: "上不上公开榜", type: "boolean", required: true },
          { name: "quality_min", label: "高质量消息最短字数（不填跟全局）", type: "number" },
          { name: "retention_days", label: "保留多少天（不填跟全局）", type: "number" },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          updateGroupConfig({
            convId: str(b, "conv_id"),
            syncExcluded: bool(b, "sync_excluded"),
            countForPoints: bool(b, "count_for_points"),
            publicLeaderboard: bool(b, "public_leaderboard"),
            qualityMin: b.quality_min === undefined ? null : num(b, "quality_min"),
            retentionDays: b.retention_days === undefined ? null : num(b, "retention_days"),
            reason: str(b, "reason"),
          }),
      },
      {
        key: "sync_now",
        label: "立刻排一轮同步",
        fields: [
          { name: "kind", label: "同步哪一类（messages / members / groups）", type: "string", required: true },
          { name: "scope", label: "限定某个群（不填是全部）", type: "string" },
        ],
        run: async (b) => triggerSync({ kind: str(b, "kind"), scope: str(b, "scope") || undefined }),
      },
      {
        key: "retry_failed",
        label: "重试全部失败的任务",
        fields: [],
        run: async () => retryAllFailed(),
      },
    ],
  },
  {
    key: "points",
    read: () => ({
      snapshot: economySnapshot(),
      top: topEarners(),
      /* 「今天」的口径要和积分那一侧一致 —— 一律走 todayKey() */
      pressure: dailyCapPressure(todayKey()),
    }),
    actions: [],
  },
  {
    key: "points-ledger",
    read: ({ limit, offset }) => ({
      summary: ledgerSummary(),
      risk: riskQueue(),
      entries: listAllLedger({ limit, offset }),
    }),
    actions: [
      {
        key: "revert",
        label: "撤销一笔",
        danger: 2,
        fields: [
          { name: "entry_id", label: "流水 id", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => revertLedgerEntry(str(b, "entry_id"), str(b, "reason")),
      },
    ],
  },
  {
    key: "points-levels",
    read: () => ({
      levels: configuredLevels(),
      counts: levelCounts(),
      health: levelsHealth(),
    }),
    actions: [
      {
        key: "save",
        label: "保存等级配置",
        danger: 1,
        fields: [{ name: "levels", label: "等级表（JSON 数组）", type: "string", required: true }],
        run: async (b) => {
          /*
           * 等级表是一个数组，而这一层的表单字段只有三种标量类型。
           * 所以它以 JSON 字符串传进来，在这里解析。
           *
           * 解析失败给一句人话，而不是让 `JSON.parse` 抛出去变成 500 ——
           * 500 会被客户端库当成服务端故障自动重试，而重试一份
           * 语法错误的 JSON 永远不会成功。
           */
          let levels: unknown;
          try {
            levels = JSON.parse(str(b, "levels"));
          } catch {
            return { ok: false, error: "levels 不是合法的 JSON" };
          }
          if (!Array.isArray(levels)) return { ok: false, error: "levels 要是一个数组" };
          return saveLevels(levels as never);
        },
      },
    ],
  },
  {
    key: "shop",
    read: ({ limit }) => ({
      items: listItems(true),
      orders: pagedOrders({ perPage: limit }),
      pending: pendingShipments(),
    }),
    actions: [],
  },
  {
    key: "activities",
    read: () => ({ modules: listActivityModules(), exports: domainExportCounts("all") }),
    actions: [],
  },
  {
    key: "broadcast",
    read: ({ limit }) => recentDigests(limit),
    actions: [
      {
        key: "save_draft",
        label: "存一份草稿",
        fields: [
          { name: "channel", label: "site（站内）/ wechat（发到群里）", type: "string", required: true },
          { name: "title", label: "标题", type: "string" },
          { name: "content", label: "正文", type: "string", required: true },
        ],
        run: async (b) =>
          saveBroadcastDraft({
            channel: str(b, "channel") as never,
            title: str(b, "title") || undefined,
            content: str(b, "content"),
          }),
      },
      {
        key: "queue_send",
        label: "排进发送队列",
        /*
         * 危险级 2：它会往一千六百人的群里发东西，而且**撤不回来**
         * （撤回接口有时间窗，过了就只能再发一条更正）。
         */
        danger: 2,
        fields: [{ name: "id", label: "草稿 id", type: "string", required: true }],
        run: async (b) => queueSend({ id: str(b, "id") }),
      },
    ],
  },
  {
    key: "community",
    read: () => systemStatus(),
    actions: [],
  },
  {
    key: "settings",
    read: () => ({ settings: listSettings(), modified: modifiedCount() }),
    actions: [
      {
        key: "change",
        label: "改一个设置",
        danger: 1,
        fields: [
          { name: "key", label: "设置项", type: "string", required: true },
          { name: "value", label: "新值", type: "string", required: true },
          { name: "reason", label: "理由", type: "string" },
        ],
        run: async (b) =>
          changeSetting({ key: str(b, "key"), value: str(b, "value"), reason: str(b, "reason") }),
      },
      {
        key: "reset",
        label: "恢复默认值",
        danger: 1,
        fields: [
          { name: "key", label: "设置项", type: "string", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) => resetSetting({ key: str(b, "key"), reason: str(b, "reason") }),
      },
    ],
  },
  {
    key: "flags",
    read: () => ({ flags: listFlagsForAdmin(), orphans: orphanFlagKeys() }),
    actions: [
      {
        key: "toggle",
        label: "开关一个功能",
        danger: 1,
        fields: [
          { name: "key", label: "开关 key", type: "string", required: true },
          { name: "enabled", label: "开", type: "boolean", required: true },
        ],
        run: async (b) => setFlagEnabled(str(b, "key"), bool(b, "enabled")),
      },
    ],
  },
  {
    key: "mail",
    /*
     * 读的是网页那一页同一批查询函数（`lib/mail/admin-queries.ts`）——
     * 这一整张注册表的规矩就是这个：终端和网页看到的是同一份数字，
     * 不然「哪个是对的」会变成一个没人答得上来的问题。
     */
    read: ({ limit }) => {
      const domains = listDomains();
      return {
        domains,
        summary: domainSummary(domains),
        boxes: listBoxes({ limit }),
        rejected: recentRejections(limit),
      };
    },
    /*
     * 没有 actions。域名上下架、封禁词增删都还只在网页上 ——
     * 而**空数组是一句话**：终端里这一屏是只读的，不是漏写了。
     */
    actions: [],
  },
  {
    key: "oauth",
    /* 只列应用，不列任何密钥 —— `listApps` 返回的是 hasSecret 而不是密钥本身 */
    read: () => ({ apps: listApps() }),
    actions: [],
  },
  {
    key: "modules",
    read: () => moduleHealth(),
    actions: [
      {
        key: "toggle",
        label: "开关一个模块",
        danger: 1,
        fields: [
          { name: "key", label: "模块 key", type: "string", required: true },
          { name: "enabled", label: "开", type: "boolean", required: true },
          { name: "reason", label: "理由", type: "string", required: true },
        ],
        run: async (b) =>
          setModuleEnabled({ key: str(b, "key"), enabled: bool(b, "enabled"), reason: str(b, "reason") }),
      },
    ],
  },
  {
    key: "api",
    read: ({ limit }) => ({
      grants: allGrants(),
      /* 全站视角的代发日志：`userId: null` 只有这一页能传 */
      log: sendLog({ userId: null, limit }),
    }),
    actions: [
      {
        key: "revoke_all_ssh_tokens",
        label: "撤销全部 SSH 网关令牌",
        /*
         * ═════════════════════════════════════════
         * 网关被怀疑失守时，**第一个要按的就是这个**
         * ═════════════════════════════════════════
         *
         * SSH 网关那台机器上放着一批别人的令牌明文（`TUI.md` 第三节）。
         * 出事时逐个去找「哪些是那台机器上的」做不到 ——
         * 令牌名字是人起的，散在几十个人名下，一眼看不出来。
         *
         * 所以按来源一刀切。代价是所有 SSH 用户要重新登录一次，
         * 而那正是这个动作应有的代价。
         */
        danger: 2,
        fields: [{ name: "reason", label: "为什么撤（会写进每一条的撤销原因）", type: "string", required: true }],
        run: async (b) => {
          const admin = await requireWritableAdmin("system.settings");
          const reason = str(b, "reason").trim();
          if (!reason) return { ok: false, error: "必须写清楚为什么撤 —— 被踢下线的人会看到它" };

          const n = revokeAllSshTokens(`站长撤销：${reason}`);
          audit(
            { actorId: admin.user.id },
            {
              action: "api.token.revoke_all_ssh",
              targetType: "api_token",
              targetLabel: "全部 SSH 网关令牌",
              after: { revoked: n },
              reason,
            },
          );
          return { ok: true };
        },
      },
    ],
  },
  {
    key: "llm",
    read: () => enrichProgress(),
    actions: [],
  },
];

/**
 * 把名字那一份和实现这一份拼起来。
 *
 * ─────────────────────────────────────────
 * 少一个或多一个都当场炸，而不是安静地少一个分区
 * ─────────────────────────────────────────
 *
 * 安静地少一个的后果是：终端里那一屏点进去 404，
 * 而 `/api/v1/admin/sections` 里它明明列着 —— 因为那条读的是名字那一份。
 * 在模块加载时就炸掉，比让它上线之后被一个人撞到好。
 */
export const ADMIN_SECTIONS: readonly AdminSection[] = ADMIN_SECTION_META.map((meta) => {
  const impl = IMPLS.find((i) => i.key === meta.key);
  if (!impl) throw new Error(`后台分区「${meta.key}」在 api-section-rules.ts 里有名字，但没有实现`);
  return { ...meta, read: impl.read, actions: impl.actions };
});

{
  const known = new Set(ADMIN_SECTION_KEYS);
  const extra = IMPLS.filter((i) => !known.has(i.key)).map((i) => i.key);
  if (extra.length > 0) {
    throw new Error(`后台分区有实现但没登记名字：${extra.join("、")}`);
  }
}

const BY_KEY = new Map(ADMIN_SECTIONS.map((s) => [s.key, s]));

export function adminSection(key: string): AdminSection | null {
  return BY_KEY.get(key) ?? null;
}

export function adminActionSpec(section: AdminSection, key: string): AdminActionSpec | null {
  return section.actions.find((a) => a.key === key) ?? null;
}
