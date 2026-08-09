"use server";

import { revalidatePath } from "next/cache";

import { assertNotPreviewing, getCurrentUser } from "@/lib/auth/session";

import {
  connectionOf,
  setPinnedRepos,
  setPromptEnabled,
  setShowOnProfile,
  unlinkGithub,
} from "./link";
import { dismissPrompt, markPromptShared } from "./prompts";
import { cachedRepos, refreshGithubData } from "./repos";
import { sanitizePinned } from "./repo-rules";
import { githubEnabled } from "./secret";

/**
 * GitHub 绑定的 server action。
 *
 * **这里一个动作都不会创建账号或会话。** 全部动作的第一步都是
 * 「你是谁」——拿不到登录用户就直接返回失败。绑定的建立本身
 * 走的是 OAuth 回调路由（那里同样只认已有会话），不在这个文件里。
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

const fail = (error: string): ActionResult => ({ ok: false, error });

/**
 * 每个动作开头都跑这一段：没登录、没配置、没绑定，都不做事。
 *
 * 用一个显式的 `ok` 做判别标记，而不是靠「有没有 error 字段」——
 * 后者在 TS 里narrow 不干净，会让 ctx.user 变成可能为 undefined，
 * 于是每个调用点都得写一个多余的非空断言，而断言写多了就没人看了。
 */
type ConnCtx =
  | { ok: false; error: string }
  | { ok: true; user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>; conn: NonNullable<ReturnType<typeof connectionOf>> };

async function requireConnected(): Promise<ConnCtx> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };
  if (!githubEnabled()) return { ok: false, error: "这个站还没有配置 GitHub 绑定" };
  const conn = connectionOf(user.id);
  if (!conn) return { ok: false, error: "你还没有绑定 GitHub" };
  return { ok: true, user, conn };
}

export async function unlinkGithubAction(): Promise<ActionResult> {
  const ctx = await requireConnected();
  if (!ctx.ok) return fail(ctx.error);
  await assertNotPreviewing();

  unlinkGithub(ctx.user.id);
  revalidatePath("/me/security");
  revalidatePath("/me");
  return { ok: true, message: "已解绑" };
}

/**
 * 要不要在主页上展示。
 *
 * 这是个**独立于绑定**的开关：默认关着，绑定不会顺带打开它。
 * 有人绑定只是为了那个「有新项目要不要发帖」的提醒，
 * 并不想让同群的人看到自己的 GitHub。
 */
export async function setGithubVisibilityAction(show: boolean): Promise<ActionResult> {
  const ctx = await requireConnected();
  if (!ctx.ok) return fail(ctx.error);
  await assertNotPreviewing();

  setShowOnProfile(ctx.user.id, show);
  revalidatePath("/me/security");
  if (ctx.user.wxId) revalidatePath(`/members/${ctx.user.wxId}`);
  return { ok: true, message: show ? "已在主页展示" : "已从主页收起" };
}

/** 明确的「别再提醒我了」。点了之后一条新提示都不会再产生 */
export async function setGithubPromptEnabledAction(enabled: boolean): Promise<ActionResult> {
  const ctx = await requireConnected();
  if (!ctx.ok) return fail(ctx.error);
  await assertNotPreviewing();

  setPromptEnabled(ctx.user.id, enabled);
  revalidatePath("/me/security");
  revalidatePath("/me");
  return { ok: true, message: enabled ? "已开启提醒" : "以后不再提醒" };
}

/**
 * 单条「不用了」。
 *
 * 记录留在库里、状态变 dismissed —— **不删**。删掉的话下一轮检测
 * 会以为这个仓库没见过，于是又提示一遍，
 * 而那正是用户刚刚明确说不要的东西。
 */
export async function dismissGithubPromptAction(id: string): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  // 按 (id, userId) 双条件更新 —— 拿别人的 id 过来什么都改不动
  if (!dismissPrompt(user.id, id)) return fail("这条提示已经处理过了");
  revalidatePath("/me");
  return { ok: true };
}

/**
 * 帖子真的发出去了 —— 把那条提示标成 shared。
 *
 * 做成一个独立的 action、由发帖页发完再调一次，而不是给 createPost
 * 加一个 githubPromptId 参数：论坛模块不该认识 GitHub 模块。
 * 多一次往返在这条路上无所谓（一个人一年也发不了几次），
 * 而少一条跨模块的依赖是长期的事。
 *
 * 就算这一步失败了也不会重复提示 —— 那条记录早就在表里，
 * 唯一索引已经把「再提示一次」挡死了。这里只影响它还会不会
 * 在页面上挂到过期为止。
 */
export async function markGithubPromptSharedAction(
  promptId: string,
  postId: string,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("请先登录");
  await assertNotPreviewing();

  markPromptShared(user.id, promptId, postId);
  revalidatePath("/me");
  return { ok: true };
}

/** 自己挑主页上置顶哪几个仓库 */
export async function setGithubPinnedAction(pinned: string[]): Promise<ActionResult> {
  const ctx = await requireConnected();
  if (!ctx.ok) return fail(ctx.error);
  await assertNotPreviewing();

  // 只留真的属于这个人的仓库名，去重限长 —— 不清洗的话这一列会成为一个任意字符串写入口
  const clean = sanitizePinned(pinned, cachedRepos(ctx.user.id).repos);
  setPinnedRepos(ctx.user.id, clean);
  revalidatePath("/me/security");
  if (ctx.user.wxId) revalidatePath(`/members/${ctx.user.wxId}`);
  return { ok: true };
}

/**
 * 手动刷新。
 *
 * **冷却期内点了也不会真的去抓**（见 repo-rules 的 REPO_REFRESH_COOLDOWN_MS）——
 * GitHub 的限流按服务器出口 IP 算，一个人猛点会把全站的额度耗光，
 * 而症状是别人主页上的项目突然全空了。
 */
export async function refreshGithubAction(): Promise<ActionResult> {
  const ctx = await requireConnected();
  if (!ctx.ok) return fail(ctx.error);
  await assertNotPreviewing();

  const outcome = await refreshGithubData(ctx.user.id);
  revalidatePath("/me/security");
  revalidatePath("/me");

  if (!outcome.attempted) return { ok: true, message: "刚刚才刷过，稍后再试" };
  if (!outcome.ok) return fail("没能连上 GitHub，稍后再试一次");
  return { ok: true, message: `已更新 ${outcome.repoCount} 个仓库` };
}
