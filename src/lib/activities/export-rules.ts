/**
 * 导出域名申请列表。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 已经有一个「导出」了，但它只有域名
 * ─────────────────────────────────────────
 *
 * `exportRegistrarList` 吐的是一列光秃秃的域名，复制到剪贴板，
 * 拿去注册商的批量注册框里粘 —— 那条路径本身没问题，别动它。
 *
 * 问题是它**只能干那一件事**。域名注册完之后要发给谁、
 * 哪几个失败了失败在哪、这一批是什么时候申请的 ——
 * 一列域名一个都答不上来，管理员只能回后台一条条点开看。
 *
 * 所以这里是另一个东西：一份**能存下来、能用表格打开、能对账**的清单。
 *
 * ─────────────────────────────────────────
 * 导出的文件是会离开这个系统的
 * ─────────────────────────────────────────
 *
 * 它会被下载、被转发、被扔进某个注册商的工单里。所以列的选择
 * 不是「后台能看到什么就导什么」：**微信 ID 不进这份文件**。
 * 管理员在后台看得到它，但那是在登录态下看一眼；
 * 一个 CSV 落到本地之后就再也不受这套权限管了。
 * 昵称加用户 ID 足够定位到人，而用户 ID 拿到系统外面没有用 —— 这正是要的。
 */

import { applicationStatusLabel } from "@/lib/activities/state";
import { COMMUNITY_TIMEZONE } from "@/lib/time";

export interface ExportRow {
  domain: string | null;
  status: string;
  applicantName: string | null;
  userId: string;
  createdAt: number;
  reviewedAt: number | null;
  fulfilledAt: number | null;
  failureReason: string | null;
}

/**
 * CSV 一格里的内容。
 *
 * ─────────────────────────────────────────
 * 昵称是用户自己填的，而它会被 Excel 当成公式执行
 * ─────────────────────────────────────────
 *
 * 一个把昵称改成 `=1+1` 的人，导出的表在 Excel 里打开会显示 `2`。
 * 而这只是无害的那一版：`=cmd|'/c calc'!A1` 这类写法在
 * Excel / WPS / Google Sheets 上都曾经能弹出真的命令执行，
 * 到今天也仍然会先弹一个「是否允许」的框 —— 而管理员对着
 * 一份自己刚从后台导出的文件，多半会点允许。
 *
 * 引号转义**挡不住这个**：`"=1+1"` 在 Excel 眼里照样是公式。
 * 所以以 `= + - @` 以及制表符 / 回车开头的格子前面补一个单引号，
 * 让它退回成纯文本。这一条和 CSV 语法无关，是专门给电子表格加的。
 *
 * 只处理开头那一个字符，不动内容 —— 昵称叫「=不等于=」的人
 * 导出来还得是他自己那个名字。
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);

  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;

  // RFC 4180：含逗号、引号、换行的要包起来，里面的引号翻倍
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/**
 * 毫秒时间戳 → `2026-08-09 23:31`（东八区）。
 *
 * 导出的表是给人看的，ISO 那串 `T` 和 `Z` 只会让人以为时间不对 ——
 * 而且 UTC 会让晚上 8 点之后的申请看起来像是第二天的。
 * 社群在中国，就按东八区写。
 */
const stamp = new Intl.DateTimeFormat("zh-CN", {
  timeZone: COMMUNITY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function csvTime(ts: number | null | undefined): string {
  if (!ts) return "";
  // zh-CN 会给出 `2026/08/09 23:31`，换成横杠更像表格里的日期
  return stamp.format(new Date(ts)).replaceAll("/", "-");
}

export const EXPORT_COLUMNS = [
  "域名",
  "状态",
  "申请人",
  "用户 ID",
  "申请时间",
  "审核时间",
  "完成时间",
  "失败原因",
] as const;

/**
 * 拼出整份 CSV。
 *
 * ─────────────────────────────────────────
 * 开头那个 BOM 不是脏东西
 * ─────────────────────────────────────────
 *
 * 没有它，Excel 在中文 Windows 上会按 GBK 读这份 UTF-8 文件，
 * 于是每一个中文昵称都是乱码。管理员看到的是一整列方块字，
 * 而他不会去想编码 —— 他会觉得这个导出坏了。
 *
 * 行尾用 CRLF 同理：RFC 4180 就是这么写的，Excel 也更认这个。
 */
export function buildCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];

  for (const row of rows) {
    lines.push(
      [
        csvCell(row.domain),
        csvCell(applicationStatusLabel(row.status)),
        csvCell(row.applicantName),
        csvCell(row.userId),
        csvCell(csvTime(row.createdAt)),
        csvCell(csvTime(row.reviewedAt)),
        csvCell(csvTime(row.fulfilledAt)),
        csvCell(row.failureReason),
      ].join(","),
    );
  }

  return `﻿${lines.join("\r\n")}\r\n`;
}

/** 导出的范围。和「复制给注册商」那个列表的口径对齐，省得两处答案不一样 */
export const EXPORT_SCOPES = {
  /** 还要去注册的 */
  pending: ["approved", "fulfilling"],
  /** 已经注册好的 —— 发货 / 对账用 */
  fulfilled: ["fulfilled"],
  /** 全部，含撤回和失败 —— 复盘用 */
  all: null,
} as const;

export type ExportScope = keyof typeof EXPORT_SCOPES;

/**
 * 这个参数是从 URL 里来的，所以校验要收得死。
 *
 * **不能写成 `value in EXPORT_SCOPES`** —— `in` 会走原型链，
 * 于是 `?scope=__proto__` 判定为合法，接着
 * `EXPORT_SCOPES["__proto__"]` 拿到的是 `Object.prototype`，
 * 它既不是 null 也没有 `.includes`，下一行直接把这个接口炸成 500。
 * 同样的写法在别处还能变成原型污染。用自有键判断。
 */
export function isExportScope(value: string | null): value is ExportScope {
  return value !== null && Object.hasOwn(EXPORT_SCOPES, value);
}

/**
 * 下载下来叫什么名字。
 *
 * 带上活动和范围和日期，因为**管理员会导好几次**：
 * 全都叫 `export.csv` 的话，下载目录里躺着 `export(3).csv`，
 * 而没有人分得清哪一份是哪一次的。
 *
 * 日期由调用方传进来 —— 这里读时钟的话，
 * 这个函数就没法测了，而文件名恰恰是容易写错的那种东西。
 */
export function exportFilename(activityTitle: string, scope: ExportScope, dateKey: string): string {
  const scopeLabel = { pending: "待注册", fulfilled: "已注册", all: "全部" }[scope];
  // 文件名里出现 / \ : * ? " < > | 会在某些系统上存不下来，换成横杠
  const safeTitle = activityTitle.replace(/[/\\:*?"<>|]/g, "-").trim() || "活动";
  return `${safeTitle}-${scopeLabel}-${dateKey}.csv`;
}

/**
 * 中文文件名要走 `filename*=UTF-8''…`。
 *
 * 光写 `filename="域名-待注册.csv"` 的话，非 ASCII 字符在
 * Content-Disposition 里是没有定义的：多数浏览器会存成乱码或者
 * 干脆退回成 URL 最后一段。两个都写，老浏览器读前一个、
 * 认得 RFC 5987 的读后一个。
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
