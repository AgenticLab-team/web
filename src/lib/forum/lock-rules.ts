/**
 * 谁能锁帖、谁能解锁。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 楼主锁自己的帖子，和版主锁帖不是一回事
 * ─────────────────────────────────────────
 *
 * 原来锁帖只认 `forum.post.lock` 这一个权限，也就是只有版主能锁。
 * 而 FORUM.md 4.3 一直写着楼主可以锁自己的 ——
 * 「这个问题解决了，不用再讨论了」是楼主该有的动作，
 * 和「这串已经吵起来了，版主叫停」完全是两件事。
 *
 * ─────────────────────────────────────────
 * 难的不是加锁，是解锁
 * ─────────────────────────────────────────
 *
 * 楼主一旦能解锁，他就能解掉**版主**加的那把锁 ——
 * 版主叫停、楼主解开、再吵起来，处罚形同虚设。
 *
 * 所以必须记住是谁锁的（`posts.locked_by`），
 * 然后只允许**解开自己加的那把**。
 *
 * 删除那边早就是这么办的：作者自删的自己能恢复，
 * 管理员删的必须走申诉。这里照抄同一条线，
 * 一来是对的，二来两处不一致的话，人会以为其中一处是 bug。
 */

export type LockActor = {
  userId: string;
  /** 有 `forum.post.lock` 权限 —— 版主 / 管理员 */
  canModerate: boolean;
};

export type LockState = {
  authorId: string;
  status: string;
  /** 谁锁的。null = 没锁，或者是这两列加进来之前锁的 */
  lockedBy: string | null;
};

export function isLocked(status: string): boolean {
  return status === "locked";
}

export function canLock(actor: LockActor | null, post: LockState): boolean {
  if (!actor) return false;
  if (isLocked(post.status)) return false;
  return actor.canModerate || actor.userId === post.authorId;
}

export function canUnlock(actor: LockActor | null, post: LockState): boolean {
  if (!actor) return false;
  if (!isLocked(post.status)) return false;

  // 版主解得开任何一把
  if (actor.canModerate) return true;

  /*
   * 楼主只解得开**自己加的那把**。
   *
   * `lockedBy` 为 null 的历史数据（这两列加进来之前锁的）
   * 一律当成「不是楼主锁的」—— 那时候只有版主能锁，
   * 所以这个默认值是事实，不是保守猜测。
   */
  return actor.userId === post.authorId && post.lockedBy === actor.userId;
}

export type LockKind = "none" | "author" | "moderator";

export function lockKind(post: LockState): LockKind {
  if (!isLocked(post.status)) return "none";
  return post.lockedBy === post.authorId ? "author" : "moderator";
}

/**
 * 锁上之后那一行字。
 *
 * ─────────────────────────────────────────
 * 「该帖已锁定」只说了发生什么，没说为什么
 * ─────────────────────────────────────────
 *
 * 而这两种锁在读者眼里是完全不同的信号：
 * 楼主收尾的帖子仍然值得读（多半还有个结论），
 * 被版主叫停的那种则是在说「这里出过问题」。
 * 用同一句话盖住，等于把两件事混成一件。
 */
export function lockNotice(post: LockState, reason: string | null): string {
  const why = reason?.trim();

  if (lockKind(post) === "author") {
    return why ? `楼主结束了这个讨论：${why}` : "楼主结束了这个讨论";
  }
  return why ? `版主锁定了这个帖子：${why}` : "版主锁定了这个帖子";
}

/**
 * 锁的时候要不要填理由。
 *
 * 要 —— 而且两种锁都要。
 *
 * 版主那边本来就必填（处置要留痕）。楼主这边看起来可以省，
 * 但那句话是**写给读者的**：一个突然不能回复的帖子，
 * 如果没有任何说明，看起来就是坏了。
 */
export const REASON_REQUIRED = true;

export const MAX_LOCK_REASON = 100;

export type ReasonVerdict = { ok: true; reason: string } | { ok: false; message: string };

export function checkLockReason(raw: string): ReasonVerdict {
  const reason = raw.trim().replace(/\s+/g, " ");
  if (!reason) return { ok: false, message: "说一句为什么 —— 这句话会显示给看帖的人" };
  if (reason.length > MAX_LOCK_REASON) {
    return { ok: false, message: `最多 ${MAX_LOCK_REASON} 个字` };
  }
  return { ok: true, reason };
}
