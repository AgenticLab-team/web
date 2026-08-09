import { Readable } from "node:stream";
import { createDeflateRaw } from "node:zlib";

/**
 * 一个**流式**的 zip 打包器。
 *
 * ─────────────────────────────────────────
 * 为什么自己写而不是装一个库
 * ─────────────────────────────────────────
 *
 * 仓库里没有任何 zip 依赖，而常见的那几个（archiver / jszip）
 * 要么把整份内容留在内存里，要么拖进来一串 Node 流的适配层。
 * zip 的「存储型 + 数据描述符」写法本身只有几十行头部字段 ——
 * 用到的那部分比引入并驯服一个库要小。
 *
 * ─────────────────────────────────────────
 * 关键在于：**尺寸是写完才知道的**
 * ─────────────────────────────────────────
 *
 * 本地文件头里有 crc32 和压缩前后大小三个字段，而它们都要等
 * 整个文件写完才算得出来。常规做法是先把这个文件整体压进内存、
 * 量出大小、再写头 —— 那样一份四万条消息的 jsonl 会完整地
 * 在内存里存在一次，而这台机器只有 3.7G。
 *
 * zip 对这件事有现成的解法：通用标志位第 3 位（0x08）置上，
 * 三个字段先写 0，真值放在数据流**后面**的数据描述符里。
 * 于是每个文件都可以边读边压边发，内存里最多只有一个 deflate 缓冲区。
 *
 * ─────────────────────────────────────────
 * 没做 zip64
 * ─────────────────────────────────────────
 *
 * 单文件或整包超过 4 GiB 时 zip64 才是必需的。导出有条数上限
 * （见 self-export-rules.ts），正常情况下差几个数量级。
 * 但「差几个数量级」不是「不会发生」，所以超了就**抛错**，
 * 而不是让那几个字段悄悄溢出 —— 一个能下载下来但解不开的
 * 压缩包，比一次明确的失败难查得多。
 */

const ZIP64_LIMIT = 0xffff_ffff;

/** 第 3 位：三个尺寸字段在数据描述符里。第 11 位：文件名是 UTF-8 */
const FLAG_DATA_DESCRIPTOR_UTF8 = 0x0808;
/** deflate */
const METHOD_DEFLATE = 8;
/** 2.0 —— 支持 deflate 所需的最低版本 */
const VERSION_NEEDED = 20;

const SIG_LOCAL = 0x0403_4b50;
const SIG_DESCRIPTOR = 0x0807_4b50;
const SIG_CENTRAL = 0x0201_4b50;
const SIG_EOCD = 0x0605_4b50;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** 增量 crc32：把上一块的返回值当 seed 传进来接着算 */
export function crc32(chunk: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffff_ffff) >>> 0;
  for (let i = 0; i < chunk.length; i += 1) {
    c = (CRC_TABLE[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffff_ffff) >>> 0;
}

/**
 * zip 里的时间是 1980 年的 MS-DOS 格式，**不带时区** ——
 * 解压出来显示成几点取决于写的时候用了哪个时区。
 * 这个社群在东八区，按东八区写，和站内其它时间显示对得上。
 */
export function dosDateTime(ts: number): { date: number; time: number } {
  const d = new Date(ts + 8 * 3_600_000);
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

export interface ZipEntry {
  /** 包内路径。用 / 分隔，不要以 / 开头 */
  name: string;
  /** 修改时间，默认取打包时刻 */
  mtime?: number;
  /**
   * 内容。**是个函数而不是一段数据** —— 只有轮到这个文件时才开始产出，
   * 这正是「不会一次性全读进内存」这条的落点。
   */
  content: () => AsyncIterable<string | Uint8Array>;
}

interface CentralRecord {
  name: Buffer;
  crc: number;
  csize: number;
  usize: number;
  offset: number;
  date: number;
  time: number;
}

function localHeader(name: Buffer, date: number, time: number): Buffer {
  const buf = Buffer.alloc(30 + name.length);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(FLAG_DATA_DESCRIPTOR_UTF8, 6);
  buf.writeUInt16LE(METHOD_DEFLATE, 8);
  buf.writeUInt16LE(time, 10);
  buf.writeUInt16LE(date, 12);
  // crc / 压缩后 / 压缩前：全为 0，真值在数据描述符里
  buf.writeUInt16LE(name.length, 26);
  buf.writeUInt16LE(0, 28);
  name.copy(buf, 30);
  return buf;
}

function dataDescriptor(crc: number, csize: number, usize: number): Buffer {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
  buf.writeUInt32LE(crc, 4);
  buf.writeUInt32LE(csize, 8);
  buf.writeUInt32LE(usize, 12);
  return buf;
}

function centralHeader(rec: CentralRecord): Buffer {
  const buf = Buffer.alloc(46 + rec.name.length);
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  // 高字节 0 = MS-DOS，低字节是版本号。跨平台解压器对这个最不挑剔
  buf.writeUInt16LE(VERSION_NEEDED, 4);
  buf.writeUInt16LE(VERSION_NEEDED, 6);
  buf.writeUInt16LE(FLAG_DATA_DESCRIPTOR_UTF8, 8);
  buf.writeUInt16LE(METHOD_DEFLATE, 10);
  buf.writeUInt16LE(rec.time, 12);
  buf.writeUInt16LE(rec.date, 14);
  buf.writeUInt32LE(rec.crc, 16);
  buf.writeUInt32LE(rec.csize, 20);
  buf.writeUInt32LE(rec.usize, 24);
  buf.writeUInt16LE(rec.name.length, 28);
  buf.writeUInt16LE(0, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(0, 38);
  buf.writeUInt32LE(rec.offset, 42);
  rec.name.copy(buf, 46);
  return buf;
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(size, 12);
  buf.writeUInt32LE(offset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

/**
 * 把一串条目压成 zip 字节流。
 *
 * 条目本身也是异步可迭代的：调用方可以在产出前一个文件之后
 * 再决定下一个文件是什么（导出里的 manifest 就靠这个 ——
 * 它要写各文件的真实条数，只能等前面都写完）。
 */
export async function* zipStream(
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  now: number = Date.now(),
): AsyncGenerator<Uint8Array> {
  const central: CentralRecord[] = [];
  let offset = 0;

  const emit = function* (buf: Buffer) {
    offset += buf.length;
    yield buf;
  };

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { date, time } = dosDateTime(entry.mtime ?? now);
    const entryOffset = offset;

    yield* emit(localHeader(name, date, time));

    let crc = 0;
    let usize = 0;
    let csize = 0;

    /*
     * 在喂给 deflate 之前先量一遍：crc32 和「压缩前大小」说的都是
     * 原始字节，压完再算就晚了。
     */
    async function* measured() {
      for await (const chunk of entry.content()) {
        const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
        if (buf.length === 0) continue;
        usize += buf.length;
        crc = crc32(buf, crc);
        yield buf;
      }
    }

    const deflate = createDeflateRaw({ level: 6 });
    /*
     * pipe 之后用 for await 读 —— 背压是自动的：这个循环不取，
     * deflate 就不再向源要数据。整个导出的内存上界就是这一个缓冲区。
     */
    Readable.from(measured()).pipe(deflate);
    for await (const chunk of deflate) {
      const buf = chunk as Buffer;
      csize += buf.length;
      yield* emit(buf);
    }

    if (usize > ZIP64_LIMIT || csize > ZIP64_LIMIT) {
      throw new Error(`${entry.name} 超过 4 GiB，需要 zip64；导出应当先被条数上限拦住`);
    }

    yield* emit(dataDescriptor(crc, csize, usize));
    central.push({ name, crc, csize, usize, offset: entryOffset, date, time });
  }

  const centralOffset = offset;
  for (const rec of central) yield* emit(centralHeader(rec));
  const centralSize = offset - centralOffset;

  if (centralOffset > ZIP64_LIMIT) {
    throw new Error("压缩包超过 4 GiB，需要 zip64");
  }

  yield endOfCentralDirectory(central.length, centralSize, centralOffset);
}

/**
 * 异步生成器 → Web ReadableStream。
 *
 * 用 pull 而不是在 start 里一次性推完：pull 是消费者驱动的，
 * 客户端下载得慢，这边就产得慢。推模式下 controller 的队列会
 * 无限涨，等于又把整包攒回内存里。
 */
export function toReadableStream(source: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      // 用户取消下载时把生成器也停掉，否则它会继续查库直到跑完
      await iterator.return?.(reason);
    },
  });
}
