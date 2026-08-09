/**
 * 把群消息切成「会话窗口」。纯函数，不碰数据库。
 *
 * ─────────────────────────────────────────
 * 为什么不是一条消息一个向量
 * ─────────────────────────────────────────
 *
 * 语义检索的常规做法是给每条记录算一个向量。在这个站上那样做基本没用，
 * 而这不是猜的 —— 数过：
 *
 *   ≤ 4 字的消息   7,582 条   25%
 *   ≤ 8 字         15,203 条  50%
 *   ≤ 15 字        23,814 条  78%
 *
 * **一半的群消息不超过 8 个字。**「哈哈」「好的」「?」「+1」——
 * 这些东西单独拿去嵌入，得到的向量彼此都差不多，检索时既召不回
 * 想要的，又会把一堆语气词排到前面。做出来会像能用，实际每次都答非所问，
 * 而那比没有这个功能更糟：人会以为搜过了。
 *
 * 群聊里有意义的单位是**一段对话**，不是一句话。所以按
 * 「同一个群 + 相邻消息间隔不超过 GAP」切段，整段一起嵌入。
 * 同样是数出来的：切完 3,506 段，平均每段 9 条 / 145 字 ——
 * 那才是一个能表达一件事的长度。
 *
 * ─────────────────────────────────────────
 * 顺带解决了成本和内存
 * ─────────────────────────────────────────
 *
 * 3,506 段而不是 30,339 条:向量少一个数量级。
 * 512 维、每维 4 字节 → 7 MB,整份读进内存做余弦相似度毫无压力,
 * 不需要引入任何向量数据库。
 */

/** 相邻两条消息间隔超过这个数就断开 —— 群聊的话题切换基本都伴随一段沉默 */
export const WINDOW_GAP_MS = 5 * 60_000;

/**
 * 一段最多多少字。
 *
 * 超了就断，即使中间没有停顿。太长的段会把好几个话题揉进一个向量里，
 * 检索时哪个话题都不像 —— 而且嵌入接口本身也有长度上限。
 */
export const WINDOW_MAX_CHARS = 900;

/** 一段最多多少条，防止刷屏把一段撑爆 */
export const WINDOW_MAX_MESSAGES = 40;

export interface WindowInput {
  id: string;
  convId: string;
  ts: number;
  senderName: string;
  content: string;
}

export interface MessageWindow {
  convId: string;
  startTs: number;
  endTs: number;
  messageIds: string[];
  /** 拼给嵌入接口的文本，带说话人 */
  text: string;
}

/**
 * 值得嵌入的最短长度。
 *
 * 一段只有「哈哈」的对话没有可检索的内容，
 * 给它算个向量只会在结果里占位置。
 */
export const MIN_WINDOW_CHARS = 12;

/**
 * 切段。输入**必须按 (convId, ts) 排好序**。
 *
 * 不在函数里自己排是刻意的:调用方是从 SQL 里 ORDER BY 出来的,
 * 再排一遍是白花的钱;而如果调用方没排,那说明它拿错了数据 ——
 * 这里替它兜住只会把那个错误藏起来。所以顺序不对时如实抛。
 */
export function buildWindows(messages: WindowInput[]): MessageWindow[] {
  const out: MessageWindow[] = [];
  let current: WindowInput[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const text = current.map((m) => `${m.senderName}：${m.content}`).join("\n");
    if (text.replace(/\s/g, "").length >= MIN_WINDOW_CHARS) {
      out.push({
        convId: current[0].convId,
        startTs: current[0].ts,
        endTs: current[current.length - 1].ts,
        messageIds: current.map((m) => m.id),
        text,
      });
    }
    current = [];
    chars = 0;
  };

  let prev: WindowInput | null = null;
  for (const msg of messages) {
    if (prev && prev.convId === msg.convId && msg.ts < prev.ts) {
      throw new Error(`切段的输入没有按时间排序：${prev.id} (${prev.ts}) 在 ${msg.id} (${msg.ts}) 之前`);
    }

    const sameConv = prev?.convId === msg.convId;
    const gap = sameConv && prev ? msg.ts - prev.ts : Infinity;
    const wouldOverflow =
      chars + msg.content.length > WINDOW_MAX_CHARS || current.length >= WINDOW_MAX_MESSAGES;

    if (!sameConv || gap > WINDOW_GAP_MS || wouldOverflow) flush();

    current.push(msg);
    chars += msg.content.length + 1;
    prev = msg;
  }
  flush();

  return out;
}

/**
 * 一段的稳定标识。
 *
 * 用 (convId, 第一条消息 id) 而不是自增主键 —— 重跑切段时,
 * 同一段要能认出「这段已经嵌过了」,否则每次同步都会把整个语料重嵌一遍。
 * 用第一条消息的 id 是因为它在这一段里唯一且不会变。
 */
export function windowKey(w: MessageWindow): string {
  return `${w.convId}:${w.messageIds[0]}`;
}

/**
 * 余弦相似度。
 *
 * 向量都做过归一化的话点积就够了，但**不假设它们归一化过** ——
 * 不同嵌入模型的输出不一样，而一个悄悄退化成「按向量长度排序」的
 * 检索，看起来完全正常。
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`向量维度对不上：${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Float32Array 与 BLOB 之间来回 —— SQLite 存二进制比存 JSON 小四倍也快得多 */
export function vectorToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function blobToVector(b: Buffer): Float32Array {
  /*
   * 必须 copy，不能直接把 Buffer 的内存当成 Float32Array 用。
   *
   * better-sqlite3 返回的 Buffer 可能落在一块共享的 ArrayBuffer 上，
   * 偏移量不一定是 4 的倍数 —— 直接构造会抛，或者更糟：读到隔壁的数据。
   */
  const copy = new ArrayBuffer(b.byteLength);
  new Uint8Array(copy).set(b);
  return new Float32Array(copy);
}
