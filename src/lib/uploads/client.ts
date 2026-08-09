import "server-only";

import { env } from "@/lib/env";
import {
  UPLOAD_ENDPOINT,
  explainUpstream,
  needsChunking,
  partCount,
  partRange,
  pickUrl,
} from "@/lib/uploads/rules";

/**
 * 往 files.mrusercontent.com 传文件。
 *
 * ─────────────────────────────────────────
 * 为什么由服务器代传，而不是浏览器直传
 * ─────────────────────────────────────────
 *
 * 直传更省我们的带宽，但那要求把 API key 发到浏览器里 ——
 * 而一个发到浏览器里的 key 就等于公开的 key，任何人都能拿它
 * 把这个图床当成自己的免费网盘用，而账单和封禁落在我们头上。
 *
 * 代传的代价是文件要过一遍我们这台 3.7G 内存的机器。
 * 所以**不落盘、不整份读进内存**：拿到的 File 直接塞进
 * 转发用的 FormData，Node 那边是流式读的。
 *
 * ─────────────────────────────────────────
 * 没配 API key 也能用，只是会撞上访客限流
 * ─────────────────────────────────────────
 *
 * 上游的访客身份是**按 IP 限流的：10 分钟 20 次**。而我们是从服务器传，
 * 全站共用一个出口 IP —— 也就是全站每 10 分钟只能发 20 张图。
 * 本地开发无所谓，线上必须配 key，否则第一个热闹的晚上就撞墙。
 * 这件事在界面上说出来（见 UploadButton），不让人对着一个
 * 「太频繁」发呆。
 */

export interface UploadOk {
  ok: true;
  url: string;
  /** 上游给的备注，原样透出去 —— 它可能解释了为什么这次和上次不一样 */
  remark?: string;
}
export interface UploadErr {
  ok: false;
  error: string;
  /** 值得重试的（网络抖动、上游存储抽风）标 true，界面据此给「再试一次」 */
  retryable?: boolean;
}
export type UploadResult = UploadOk | UploadErr;

/** 上游要求：有 key 就带上；**没有就什么都不带，不要伪造任何认证头** */
function authHeaders(): Record<string, string> {
  return env.uploads.apiKey ? { Authorization: `Bearer ${env.uploads.apiKey}` } : {};
}

/**
 * 上游偶尔会返回 HTML（比如它前面那层 CDN 挡下来时）。
 * 直接 `.json()` 会抛一个 "Unexpected token <"，
 * 而那句话对排查毫无帮助 —— 得说清楚是上游没给 JSON。
 */
async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const TIMEOUT_MS = 120_000;

async function post(path: string, body: BodyInit, headers: Record<string, string> = {}) {
  /*
   * 必须有超时。没有的话，上游卡住时这个请求会一直挂着，
   * 而 Next 的并发是有限的 —— 几个卡住的上传就能让整站变慢，
   * 表现是「网站突然很卡」，没有人会联想到有人在传图。
   */
  return fetch(`${UPLOAD_ENDPOINT}${path}`, {
    method: "POST",
    body,
    headers: { ...authHeaders(), ...headers },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** 单次直传。≤16MB 走这条 */
async function uploadSingle(file: File): Promise<UploadResult> {
  const form = new FormData();
  // 字段名必须是 file —— 上游接口说明写死的
  form.append("file", file, file.name);

  const res = await post("/api/upload", form);
  const payload = await readJson(res);

  if (!res.ok) {
    const raw = typeof payload?.error === "string" ? payload.error : undefined;
    return {
      ok: false,
      error: explainUpstream(res.status, raw),
      retryable: res.status === 502 || res.status >= 500,
    };
  }

  const url = payload ? pickUrl(payload) : null;
  if (!url) return { ok: false, error: "图床没给回可用的链接", retryable: true };

  return { ok: true, url, remark: typeof payload?.remark === "string" ? payload.remark : undefined };
}

/**
 * 分片上传。>16MB 走这条：init → 逐片 part → finish。
 *
 * 上游建议「并发 2 片、单片最多重试 3 次」。这里照办，
 * 但**并发数写成常量而不是散在代码里** —— 它是一个要调的旋钮：
 * 调大了会把我们这台机器的上行占满，调小了大文件传不完。
 */
const PART_CONCURRENCY = 2;
const PART_RETRIES = 3;

async function uploadChunked(file: File): Promise<UploadResult> {
  const initRes = await post(
    "/api/upload/init",
    JSON.stringify({ filename: file.name, size: file.size }),
    { "Content-Type": "application/json" },
  );
  const init = await readJson(initRes);
  if (!initRes.ok || !init) {
    const raw = typeof init?.error === "string" ? init.error : undefined;
    return { ok: false, error: explainUpstream(initRes.status, raw), retryable: initRes.status >= 500 };
  }

  const id = typeof init.id === "string" ? init.id : null;
  const partSize = typeof init.partSize === "number" ? init.partSize : 0;
  if (!id || partSize <= 0) return { ok: false, error: "图床没给回分片会话", retryable: true };

  /*
   * 片数以**我们自己按 partSize 算出来的**为准，不吃上游返回的 parts。
   * 两边算得不一样时（比如它用了另一种取整），按它的数字切会漏掉
   * 最后几个字节 —— 而那样传上去的文件是坏的，且上游照收不误。
   */
  const total = partCount(file.size, partSize);

  const sendPart = async (index: number): Promise<string | null> => {
    const [start, end] = partRange(index, partSize, file.size);
    for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
      try {
        const form = new FormData();
        form.append("id", id);
        form.append("idx", String(index));
        form.append("file", file.slice(start, end), file.name);
        const res = await post("/api/upload/part", form);
        if (res.ok) return null;
        if (res.status < 500 && res.status !== 429) {
          const payload = await readJson(res);
          const raw = typeof payload?.error === "string" ? payload.error : undefined;
          return explainUpstream(res.status, raw);
        }
      } catch (error) {
        if (attempt === PART_RETRIES) {
          return `第 ${index + 1} 片传不上去：${error instanceof Error ? error.message : String(error)}`;
        }
      }
      // 退避一下再试 —— 立刻重试多半撞上同一个原因
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
    return `第 ${index + 1} 片重试 ${PART_RETRIES} 次都没成功`;
  };

  for (let i = 0; i < total; i += PART_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(PART_CONCURRENCY, total - i) }, (_, k) =>
      sendPart(i + k),
    );
    const errors = (await Promise.all(batch)).filter((e): e is string => e !== null);
    if (errors.length > 0) return { ok: false, error: errors[0], retryable: true };
  }

  const finishRes = await post("/api/upload/finish", JSON.stringify({ id }), {
    "Content-Type": "application/json",
  });
  const finish = await readJson(finishRes);

  if (finishRes.status === 409) {
    /*
     * 409 带着 missing 数组。**把缺了几片说出来**而不是笼统地说失败 ——
     * 「缺第 7、12 片」指向的是网络，「缺全部」指向的是会话过期，
     * 两者要做的事完全不同。
     */
    const missing = Array.isArray(finish?.missing) ? finish.missing.length : 0;
    return { ok: false, error: `有 ${missing || "若干"} 片没传上去，再试一次`, retryable: true };
  }

  if (!finishRes.ok || !finish) {
    const raw = typeof finish?.error === "string" ? finish.error : undefined;
    return {
      ok: false,
      error: explainUpstream(finishRes.status, raw),
      retryable: finishRes.status >= 500,
    };
  }

  const url = pickUrl(finish);
  if (!url) return { ok: false, error: "图床没给回可用的链接", retryable: true };
  return { ok: true, url, remark: typeof finish.remark === "string" ? finish.remark : undefined };
}

export async function uploadFile(file: File): Promise<UploadResult> {
  try {
    return needsChunking(file.size) ? await uploadChunked(file) : await uploadSingle(file);
  } catch (error) {
    /*
     * 超时和网络错误在这里收口。**不要把原始异常抛给页面** ——
     * 那串 undici 的堆栈对用户毫无意义，而「传不上去，再试一次」
     * 恰恰是他能做的全部。
     */
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = /timeout|aborted/i.test(message);
    return {
      ok: false,
      error: timedOut ? "传太久了，超时了 —— 换个小一点的文件或者稍后再试" : "连不上图床，再试一次",
      retryable: true,
    };
  }
}

/** 有没有配 key。界面据此提示「现在走的是访客通道，会限速」 */
export function usingGuestQuota(): boolean {
  return !env.uploads.apiKey;
}
