/**
 * 每天晚上那一条。由 systemd timer 在 20:00 触发。
 *
 *   npm run daily-digest                     今天这条（已经发过就不重发）
 *   npm run daily-digest -- --force          重发 —— **会再往所有群发一次**，慎用
 *   npm run daily-digest -- --to=<conv_id>   试发给一个群：不记账、不受开关拦
 *
 * 没有 `--dry`：候选、去重、发不发的判断全都要接库，
 * 一个不接库的「预览」预览的是另一件事，而那正好是预览唯一的用途。
 * 想知道今天会挑出什么，看 `digest_runs` 里那一行就够了。
 */
import { buildDailyDigest } from "@/lib/digest/build-daily";

/*
 * `--to=<conv_id>` 是**试发**：只发那一个群、不记账、不受模块开关拦。
 * 三条的理由见 build-daily.ts 里 targetConvIds 那段。
 */
const to = process.argv.find((a) => a.startsWith("--to="))?.slice("--to=".length);

const result = buildDailyDigest({
  force: process.argv.includes("--force"),
  targetConvIds: to ? [to] : undefined,
});
console.log(JSON.stringify(result));

/*
 * 「今天没内容」**不是失败**。
 *
 * 退非零的话，systemd 会把它记成一次失败的任务，
 * 而健康检查那边会因此报警 —— 于是「今天没人发好帖子」
 * 会变成一条运维告警，几次之后就没人看告警了。
 */
