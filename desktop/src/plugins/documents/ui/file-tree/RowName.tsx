/**
 * 行名渲染（对齐 ZCode WorkspaceFileTreeRowName.tsx）：compact 目录链名
 * （a/b/c）中的 "/" 以弱色单独着色，段名保持主体色。
 */
import { Fragment } from "react";

export function FileTreeRowName({
  name,
  className,
  slashClassName,
}: {
  readonly name: string;
  readonly className?: string;
  readonly slashClassName?: string;
}) {
  const segments = name.split("/");
  if (segments.length <= 1) {
    return <span className={className}>{name}</span>;
  }
  return (
    <span className={className}>
      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          {index > 0 ? <span className={slashClassName}>/</span> : null}
          <span>{segment}</span>
        </Fragment>
      ))}
    </span>
  );
}
