"use client";

import { useCallback, useRef, useState } from "react";

/**
 * 编辑器里的上传。
 *
 * ─────────────────────────────────────────
 * 先插占位，传完再换掉
 * ─────────────────────────────────────────
 *
 * 传一张图要几秒。这几秒里如果编辑器什么都不显示，人会以为没点上、
 * 于是再点一次 —— 而每一次都真的传了一份，还各占一次配额。
 *
 * 所以点下去**立刻**在光标处插一段占位文字，传完把它换成真链接。
 * 顺带解决了另一件事：他可以在等的时候接着写别的，
 * 而图最后会落在他当初放的地方，不是文末。
 *
 * ─────────────────────────────────────────
 * 换的时候按**文本**找，不按下标
 * ─────────────────────────────────────────
 *
 * 等待的这几秒里，人很可能在别处又敲了几十个字 ——
 * 当初记下的那个下标早就指向别的地方了，按下标替换会把
 * 一句话从中间劈开。所以每次上传生成一个**唯一的占位串**，
 * 传完在全文里找它。找不到就说明他自己把那行删了，
 * 那就什么都不做 —— 别硬塞回去。
 */

let counter = 0;

/** 占位串要长得不像正常内容，否则可能和用户自己写的字撞上 */
function makeToken(name: string): string {
  counter += 1;
  const short = name.length > 24 ? `${name.slice(0, 22)}…` : name;
  return `![上传中 ${short} ⧗${counter}]()`;
}

export interface UploadState {
  /** 正在传的文件名，用来显示进度条上那句话 */
  active: string[];
  error: string | null;
  /** 这次上传之后还剩几次配额；null 表示还不知道 */
  remaining: number | null;
  /** 上游走的是访客通道（站点没配 key），会撞上全站共享的限流 */
  guestQuota: boolean;
}

export function useUpload(options: {
  /** 拿当前全文 */
  getValue: () => string;
  /** 写回全文 */
  setValue: (next: string) => void;
  /** 在光标处插入一段文本，返回插入之后的全文 */
  insertAtCursor: (text: string) => void;
}) {
  const { getValue, setValue, insertAtCursor } = options;

  const [state, setState] = useState<UploadState>({
    active: [],
    error: null,
    remaining: null,
    guestQuota: false,
  });

  // 用 ref 记住「还有几个在传」，避免在闭包里读到旧的 state
  const inflight = useRef(0);

  const replaceToken = useCallback(
    (token: string, replacement: string) => {
      const current = getValue();
      if (!current.includes(token)) return; // 人自己把那行删了，不硬塞
      setValue(current.replace(token, replacement));
    },
    [getValue, setValue],
  );

  const uploadOne = useCallback(
    async (file: File) => {
      const token = makeToken(file.name);
      insertAtCursor(token);

      inflight.current += 1;
      setState((s) => ({ ...s, active: [...s.active, file.name], error: null }));

      try {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch("/api/uploads", { method: "POST", body: form });
        const payload = (await res.json().catch(() => null)) as {
          markdown?: string;
          error?: string;
          remaining?: number;
          guestQuota?: boolean;
        } | null;

        if (!res.ok || !payload?.markdown) {
          /*
           * 失败时把占位**删掉**，而不是留在正文里。
           *
           * 留着的话，人一不留神就把 `![上传中 …]()` 发出去了 ——
           * 而那在帖子里渲染成一个破图标，比什么都没有更糟。
           */
          replaceToken(token, "");
          setState((s) => ({ ...s, error: payload?.error ?? `传不上去（${res.status}）` }));
          return;
        }

        replaceToken(token, payload.markdown);
        setState((s) => ({
          ...s,
          remaining: payload.remaining ?? s.remaining,
          guestQuota: payload.guestQuota ?? s.guestQuota,
        }));
      } catch {
        replaceToken(token, "");
        setState((s) => ({ ...s, error: "网络断了，没传上去" }));
      } finally {
        inflight.current -= 1;
        setState((s) => ({ ...s, active: s.active.filter((n) => n !== file.name) }));
      }
    },
    [insertAtCursor, replaceToken],
  );

  /**
   * 一次选了好几个文件时**一个一个传**。
   *
   * 并排传更快，但服务端是按人限流的（10 分钟 8 次）——
   * 五张图同时打过去，很可能有两张撞上 429 而另外三张成功，
   * 于是正文里三张图两个空洞，人还得自己分辨是哪两张。
   * 一个一个传的话，撞上限时后面的都还没开始，
   * 那句「还剩几次」也来得及显示。
   */
  const upload = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        await uploadOne(file);
      }
    },
    [uploadOne],
  );

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  return { ...state, busy: state.active.length > 0, upload, clearError };
}

/**
 * 从粘贴事件里挑出文件。
 *
 * **只在真的有文件时才拦下这次粘贴** —— 一律 preventDefault 的话，
 * 从别处复制一段文字过来会粘不进去，而那是编辑器里最常用的操作。
 *
 * 截图粘贴（⌘⇧4 之后 ⌘V）走的正是这条路，它是桌面端发图最顺手的方式，
 * 顺手到值得为它单独写一段。
 */
export function filesFromPaste(event: ClipboardEvent | React.ClipboardEvent): File[] {
  const data = "clipboardData" in event ? event.clipboardData : null;
  if (!data) return [];
  return Array.from(data.files ?? []);
}

/** 拖进来的文件。目录会被浏览器给成一个 size 为 0 的条目，滤掉 */
export function filesFromDrop(event: React.DragEvent): File[] {
  return Array.from(event.dataTransfer?.files ?? []).filter((f) => f.size > 0);
}
