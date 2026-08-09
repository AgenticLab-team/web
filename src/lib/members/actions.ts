"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { userSkills, users } from "@/lib/db/schema";
import { MAX_TAGS_PER_USER, parseTags, type TagIssue } from "@/lib/members/tags";

export interface SkillsResult {
  ok: boolean;
  error?: string;
  tags?: { slug: string; label: string }[];
  /** 填了但没存上的，以及为什么 —— 不静默丢弃 */
  issues?: TagIssue[];
  note?: string;
}

/**
 * 保存我的技能标签。
 *
 * 整份替换而不是增量增删：标签是一个小集合，用户心里想的是
 * 「我会这几样」而不是「我要加一个减一个」。
 * 增量接口会让「删掉最后一个」变成一个需要单独处理的动作。
 */
export async function updateMySkills(input: string[] | string): Promise<SkillsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const { tags, issues } = parseTags(input);

  db.transaction((tx) => {
    tx.delete(userSkills).where(eq(userSkills.userId, user.id)).run();
    tags.forEach((tag, index) => {
      tx.insert(userSkills)
        .values({ userId: user.id, slug: tag.slug, label: tag.label, sort: index })
        .run();
    });
  });

  revalidatePath("/members");
  revalidatePath("/me/profile");

  return {
    ok: true,
    tags,
    issues,
    note:
      tags.length === 0
        ? "标签已清空 —— 你不会再出现在按技能的筛选里"
        : `已保存 ${tags.length} 个标签${issues.length > 0 ? `，${issues.length} 个没存上` : ""}`,
  };
}

export async function updateMyBio(bio: string): Promise<SkillsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  const trimmed = bio.trim().slice(0, 140);
  db.update(users).set({ bio: trimmed || null }).where(eq(users.id, user.id)).run();

  revalidatePath("/members");
  revalidatePath("/me/profile");
  return { ok: true, note: trimmed ? "简介已保存" : "简介已清空" };
}

/**
 * 从成员目录里隐身。
 *
 * 隐身之后**自己还看得到自己那一行**（标着「仅自己可见」）——
 * 否则用户没有任何办法确认这个开关生效了，只能靠相信。
 */
export async function setDirectoryHidden(hidden: boolean): Promise<SkillsResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "请先登录" };

  db.update(users).set({ directoryHidden: hidden }).where(eq(users.id, user.id)).run();
  revalidatePath("/members");
  revalidatePath("/me/profile");

  return {
    ok: true,
    note: hidden
      ? "已隐身 —— 同群的人在成员目录里看不到你了"
      : `已出现在成员目录里，同群的人能看到你（最多 ${MAX_TAGS_PER_USER} 个标签）`,
  };
}
