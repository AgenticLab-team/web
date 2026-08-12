/**
 * 「他一般什么时候说话」—— 把 24 小时直方图读成一句人话。纯函数。
 *
 * ═════════════════════════════════════════
 * 这块东西暴露的是作息，不是活跃度
 * ═════════════════════════════════════════
 *
 * `lib/privacy/rules.ts` 当初删掉 `hide_activity_hours` 开关时写得很清楚：
 * 那个开关守的是**作息**（几点睡、几点起），而作息要逐小时的直方图
 * 才暴露得出来 —— 当时没有任何地方展示直方图，所以那个开关
 * 「守的东西不存在」。它同时留了一句：
 *
 *   > 哪天真做了热力图，再把它加回来 —— 它暴露的是一个人的作息。
 *
 * 这个文件就是那一天。开关跟着一起回来了（见 PRIVACY_SWITCHES）。
 *
 * ═════════════════════════════════════════
 * 只说得出「大概什么时候」，不说得更细
 * ═════════════════════════════════════════
 *
 * 给的是一个**三小时的窗口**加一句标签，不是「他 23:47 还在线」。
 * 前者说的是习惯，后者说的是行踪 —— 后一种没有人会想要挂在主页上。
 */

/** 24 个数，第 i 个是 i 点说了多少条 */
export type HourHistogram = number[];

export interface HourSummary {
  /** 归一化到 0–1 的 24 个数，画条形用。最高的那一根是 1 */
  bars: number[];
  /** 最活跃的三小时窗口，闭区间 `[from, to]`，可能跨零点 */
  from: number;
  to: number;
  /** 这个窗口占全天的比例（0–1） */
  share: number;
  /** 一句标签；说不出来时为 null */
  label: string | null;
  total: number;
}

/** 少于这么多条消息，作息谈不上「习惯」，只是几次偶然 */
export const MIN_MESSAGES = 50;

/** 窗口宽度：三小时。一小时太窄（谁都有一个最高的小时），六小时就等于没说 */
const WINDOW = 3;

/**
 * 一句标签只在**这个窗口确实突出**时才给。
 *
 * 三小时占全天 12.5% 是完全平均。低于这个门槛的人作息是散的 ——
 * 硬给一句「夜猫子」是编的，而编出来的标签比没有标签坏得多：
 * 它看上去很确定。
 */
const MIN_SHARE = 0.3;

/** 把任意长度/含脏值的数组收拾成 24 个非负整数 */
export function normalizeHistogram(raw: unknown): HourHistogram | null {
  if (!Array.isArray(raw)) return null;
  const out = new Array<number>(24).fill(0);
  for (let i = 0; i < 24; i++) {
    const v = raw[i];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[i] = Math.floor(v);
  }
  return out;
}

/** 两个直方图相加（跨群合并时用） */
export function addHistograms(a: HourHistogram, b: HourHistogram): HourHistogram {
  return a.map((v, i) => v + (b[i] ?? 0));
}

function labelFor(from: number): string | null {
  /*
   * 按窗口**起点**分档。用中点或终点都行，但要固定一个 ——
   * 换来换去会让同一个人在两次改动之间从「夜猫子」变成「早起」，
   * 而数据一个字没变。
   */
  if (from >= 0 && from <= 3) return "夜里最活跃";
  if (from >= 4 && from <= 8) return "早起型";
  if (from >= 9 && from <= 12) return "上午最活跃";
  if (from >= 13 && from <= 16) return "下午最活跃";
  if (from >= 17 && from <= 20) return "傍晚最活跃";
  return "深夜型";
}

/**
 * 直方图 → 一句话。数据不够或作息太散时返回 `null`。
 *
 * **返回 null 是常态**：很多人说话时间就是散的，
 * 而硬给一个标签会让整块区域看起来像是在算命。
 */
export function summarizeHours(hist: HourHistogram): HourSummary | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total < MIN_MESSAGES) return null;

  const max = Math.max(...hist);
  if (max === 0) return null;

  /*
   * 找最活跃的三小时窗口，**要绕过零点**。
   *
   * 不绕的话，一个 23:00–1:00 说话的人会被切成两半：
   * 22–0 和 0–2 各拿到一半，两边都不突出，于是「作息太散」——
   * 而他恰恰是这里面作息最规律的那一类。
   */
  let bestFrom = 0;
  let bestSum = -1;
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < WINDOW; k++) sum += hist[(start + k) % 24];
    if (sum > bestSum) {
      bestSum = sum;
      bestFrom = start;
    }
  }

  const share = bestSum / total;
  return {
    bars: hist.map((v) => v / max),
    from: bestFrom,
    to: (bestFrom + WINDOW - 1) % 24,
    share,
    label: share >= MIN_SHARE ? labelFor(bestFrom) : null,
    total,
  };
}

/** `23` → `23:00`；窗口写成 `21:00–24:00`（终点用开区间的写法，读起来才对） */
export function formatWindow(from: number, to: number): string {
  const end = (to + 1) % 24;
  return `${String(from).padStart(2, "0")}:00–${String(end === 0 ? 24 : end).padStart(2, "0")}:00`;
}
