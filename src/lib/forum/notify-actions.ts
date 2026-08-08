"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/auth/session";

import { markRead } from "./notify";

export async function markNotificationsRead(id?: string) {
  const user = await getCurrentUser();
  if (!user) return { ok: false };
  markRead(user.id, id);
  revalidatePath("/notifications");
  return { ok: true };
}
