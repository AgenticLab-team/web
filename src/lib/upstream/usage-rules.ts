/**
 * 上游调用记账里**不碰数据库**的那部分。
 *
 * 单独一个文件是因为 `usage.ts` 引了 `server-only` 和 db ——
 * 而 db 一加载就会去要 `NEKOBOT_API_KEY`。测这两个纯函数
 * 不该顺带拉起半个应用。
 *
 * 这个仓库已经为同一件事拆过一次（`forum/tag-rules.ts`）。
 */

/**
 * 端点要**归一化**再存。
 *
 * ─────────────────────────────────────────
 * 两个理由，第二个更要紧
 * ─────────────────────────────────────────
 *
 * **① 基数会炸。** `/users/wxid_abc123/groups?days=7` 每个人每次查询
 * 都是一个新字符串，聚合出来是几万行各不相同的「端点」，
 * 什么也看不出来。
 *
 * **② 会把成员 id 存进这张表。** 路径里带着 wxId 和会话 id ——
 * 一张用来看调用量的运维表，不该顺带攒下一份「谁在什么时候被谁查了」。
 * 这条比第一条重要：基数炸了只是难看，存了 id 是隐私问题，
 * 而且不会有人注意到。
 *
 * 查询串一律丢掉：里面有关键词、时间范围、分页 ——
 * 全是内容，不是端点。
 */
export function normalizeEndpoint(path: string): string {
  const noQuery = path.split("?")[0];
  return (
    noQuery
      // /groups/<convId>/... 和 /users/<wxId>/...
      .replace(/^\/groups\/[^/]+/, "/groups/:id")
      .replace(/^\/users\/(?!search$)[^/]+/, "/users/:id")
      .replace(/^\/friend-requests\/[^/]+/, "/friend-requests/:id")
  );
}

/**
 * 这次调用是谁打的。
 *
 * 不做成参数往下传：调用点有几十个，漏一个就是一行空白，
 * 而空白看起来像「不知道」而不是「忘了传」。
 *
 * 从进程入口认：同步、健康探测、周报各是独立进程跑的，
 * 网页服务是另一个。这个粒度足够回答「是后台任务打的还是页面打的」，
 * 而那正是看这张表时想知道的。
 */
export function callerRole(argv1 = process.argv[1] ?? ""): string {
  const name = argv1.split("/").pop()?.replace(/\.[tj]s$/, "") ?? "";
  if (!name || name === "next" || name.startsWith("next-")) return "web";
  return name;
}
