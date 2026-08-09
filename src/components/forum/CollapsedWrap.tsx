import { CollapsedReply } from "./CollapsedReply";

/**
 * 折不折叠的分叉点。
 *
 * 单独一层是为了让帖子页那边只写一次判断 ——
 * 在 JSX 里用三元表达式包一大段的话，两个分支里的内容
 * 会各写一遍，而改了一边忘了另一边是迟早的事。
 */
export function CollapsedWrap({
  collapsed,
  floor,
  authorName,
  reason,
  children,
}: {
  collapsed: boolean;
  floor: number;
  authorName: string;
  reason: string | null;
  children: React.ReactNode;
}) {
  if (!collapsed) return <>{children}</>;
  return (
    <CollapsedReply floor={floor} authorName={authorName} reason={reason}>
      {children}
    </CollapsedReply>
  );
}
