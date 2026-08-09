"use client";

import { createContext, useContext, useMemo, useState } from "react";

/**
 * 「引用回复」的桥。
 *
 * 回复列表是服务端渲染的，回复框是另一个客户端组件 ——
 * 两者之间没有共同的客户端父级能传 props，所以用一个极小的 context
 * 把「用户点了哪条的引用」递过去。
 *
 * Provider 只在**能回复**的时候包（登录且帖子未锁定）：
 * 没有 Provider 时 useQuote() 返回 null，引用按钮就不出现 ——
 * 出现一个点了没反应的按钮比不出现更糟。
 */
export interface QuoteTarget {
  replyId: string;
  floor: number;
  authorName: string;
}

interface QuoteContextValue {
  quote: QuoteTarget | null;
  setQuote: (target: QuoteTarget) => void;
  clearQuote: () => void;
}

const QuoteContext = createContext<QuoteContextValue | null>(null);

export function useQuote(): QuoteContextValue | null {
  return useContext(QuoteContext);
}

export function QuoteProvider({ children }: { children: React.ReactNode }) {
  const [quote, setQuoteState] = useState<QuoteTarget | null>(null);

  const value = useMemo(
    () => ({
      quote,
      setQuote: (target: QuoteTarget) => setQuoteState(target),
      clearQuote: () => setQuoteState(null),
    }),
    [quote],
  );

  return <QuoteContext.Provider value={value}>{children}</QuoteContext.Provider>;
}
