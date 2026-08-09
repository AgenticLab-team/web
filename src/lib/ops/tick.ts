/**
 * 定时任务的步骤编排。纯逻辑，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 一轮里做六件事，就有六个地方能把后面的都掐断
 * ─────────────────────────────────────────
 *
 * 健康探测那一轮现在要做：探活、存储快照、自动裁剪、置顶清理、
 * 赛季结算、称号结算、告警投递。原来是七个 await 排成一串 ——
 * 任何一个抛异常，后面的全都不跑，进程退出码 1。
 *
 * 而**告警投递排在最后**。也就是说：只要前面任何一步出问题，
 * 「告诉你出问题了」的那一步就不会执行。
 * 报信的人被它要报的那件事挡在了门外。
 *
 * 所以这里把每一步隔开：
 *   · 一步失败不影响其它步
 *   · 失败本身要被记下来，并且**变成一条告警**
 *   · 告警投递永远跑，而且不依赖前面任何一步的结果
 *
 * ─────────────────────────────────────────
 * 还要量时间
 * ─────────────────────────────────────────
 *
 * 定时器每 5 分钟一次。一轮跑超过 5 分钟就会开始堆叠，
 * 而堆叠的第一个症状是「同步好像变慢了」，没人会想到是这里。
 */

export interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  /** 一行给人看的结果 */
  note: string;
  error?: string;
  /** 这一步失败算不算「这一轮失败了」 */
  critical: boolean;
}

export interface TickReport {
  steps: StepResult[];
  totalMs: number;
  failed: StepResult[];
  /**
   * 失败里**真正要紧的**那些。
   *
   * 「本机备份没做成」和「异地还没配对象存储」不该是同一个信号 ——
   * 后者天天都会出现，如果它让备份这一轮整体标红，
   * 那第一次真的备份失败时，没有人会多看一眼。
   */
  criticalFailed: StepResult[];
  /** 超过这个时间就该警觉 —— 定时器间隔的一半 */
  slow: boolean;
}

export interface StepSpec<T = unknown> {
  name: string;
  run: () => T | Promise<T>;
  /** 把结果变成一行人话；抛异常时不会被调用 */
  describe?: (result: T) => string;
  /**
   * 单步超时。卡住的一步会让整轮永远跑不完，
   * 而 systemd 不会为一个还在运行的 oneshot 单元起第二个实例 ——
   * 结果是从那一刻起**所有定时任务都停了**，而且没有任何报错。
   */
  timeoutMs?: number;
  /**
   * 这一步失败算不算「这一轮失败了」。默认算。
   *
   * 设成 false 的那些仍然会被记下来、在日志里标 ✗，
   * 只是不会让整轮退非零 —— 用在「本来就还没配好」这类已知缺口上。
   */
  critical?: boolean;
}

export const DEFAULT_STEP_TIMEOUT_MS = 60_000;
/** 定时器 5 分钟一轮，跑过一半就该说一声 */
export const SLOW_TICK_MS = 150_000;

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} 超过 ${Math.round(ms / 1000)} 秒还没返回`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 按顺序跑一串步骤，**互相不影响**。
 *
 * 顺序仍然有意义（存储快照要在自动裁剪之前），
 * 但「前一步失败」不再等于「后面都不跑」。
 */
export async function runSteps(
  steps: StepSpec<never>[],
  now: () => number = () => Date.now(),
): Promise<TickReport> {
  const started = now();
  const results: StepResult[] = [];

  for (const step of steps) {
    const stepStart = now();
    try {
      const raw = step.run();
      const value =
        raw instanceof Promise
          ? await withTimeout(raw, step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS, step.name)
          : raw;

      results.push({
        name: step.name,
        ok: true,
        ms: now() - stepStart,
        note: step.describe ? step.describe(value as never) : "",
        critical: step.critical !== false,
      });
    } catch (error) {
      /*
       * 失败不抛出去。抛出去的话这一轮就断了，
       * 而断掉的那部分里可能正好有「告诉你它断了」的那一步。
       */
      results.push({
        name: step.name,
        ok: false,
        ms: now() - stepStart,
        note: "",
        error: error instanceof Error ? error.message : String(error),
        critical: step.critical !== false,
      });
    }
  }

  const totalMs = now() - started;
  const failed = results.filter((s) => !s.ok);
  return {
    steps: results,
    totalMs,
    failed,
    criticalFailed: failed.filter((s) => s.critical),
    slow: totalMs > SLOW_TICK_MS,
  };
}

/**
 * 把一轮的失败汇成一条能发出去的告警。
 *
 * 返回 null 表示这一轮没有失败 —— **不要为「一切正常」发告警**，
 * 那是让人静音整个通道最快的办法。
 */
export function tickFailureReport(report: TickReport): { title: string; body: string } | null {
  if (report.criticalFailed.length === 0) return null;
  return {
    title: `定时任务有 ${report.criticalFailed.length} 步失败`,
    body: report.criticalFailed.map((s) => `${s.name}：${s.error}`).join("；"),
  };
}

/**
 * 把这一轮的结果变成一个健康组件状态。
 *
 * ─────────────────────────────────────────
 * 退出码和日志没有人看
 * ─────────────────────────────────────────
 *
 * 一步失败之后，现在的表现是：控制台打一行 ⚠、进程退出码 1、
 * systemd 把这一轮标成 failed。**这三样没有一个会有人主动去看。**
 *
 * 所以要把它接进已经在跑的那条链路 —— 写成 `cron` 组件的健康状态，
 * 剩下的（连续失败多久才报、报给谁、送没送到）告警那一套已经做好了。
 *
 * 「有个定时任务挂了」和「上游断了」应该走同一个口子出来，
 * 而不是各有各的通道，其中一条恰好没人订阅。
 */
export function tickHealth(report: TickReport, probeError: string | null): {
  status: "ok" | "degraded" | "down";
  detail: string;
} {
  if (probeError) {
    return { status: "down", detail: `探活整体失败：${probeError}` };
  }
  if (report.criticalFailed.length > 0) {
    return {
      status: "down",
      detail: report.criticalFailed.map((s) => `${s.name}：${s.error}`).join("；").slice(0, 200),
    };
  }
  if (report.failed.length > 0) {
    // 失败了但不要紧的：记下来，但别让它和真故障共用一个颜色
    return {
      status: "degraded",
      detail: report.failed.map((s) => `${s.name}：${s.error}`).join("；").slice(0, 200),
    };
  }
  if (report.slow) {
    // 还没坏，但再慢下去定时任务就会开始堆叠
    return {
      status: "degraded",
      detail: `整轮 ${(report.totalMs / 1000).toFixed(1)}s，超过定时器间隔的一半`,
    };
  }
  return { status: "ok", detail: `${report.steps.length} 步全过，${(report.totalMs / 1000).toFixed(1)}s` };
}

/** 一行总结，打给日志看 */
export function summarize(report: TickReport): string {
  const parts = report.steps.map(
    (s) => `${s.name}${s.ok ? "" : "✗"}${s.ms >= 1000 ? ` ${(s.ms / 1000).toFixed(1)}s` : ""}`,
  );
  const tail = report.slow ? ` ⚠ 整轮 ${(report.totalMs / 1000).toFixed(1)}s，超过定时器间隔的一半` : "";
  return `${parts.join(" · ")}${tail}`;
}
