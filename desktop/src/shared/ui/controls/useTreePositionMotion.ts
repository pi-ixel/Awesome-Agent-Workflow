import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { playTreeParticles } from "./treePositionParticles.ts";

type Position = "left" | "right";

export function useTreePositionMotion({
  position,
  scope,
  enabled,
  rowRef,
  treeRef,
  previewRef,
  canvasRef,
}: {
  readonly position: Position;
  readonly scope: string;
  readonly enabled: boolean;
  readonly rowRef: RefObject<HTMLDivElement | null>;
  readonly treeRef: RefObject<HTMLDivElement | null>;
  readonly previewRef: RefObject<HTMLDivElement | null>;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const [placement, setPlacement] = useState({
    position,
    scope,
    isAnimated: false,
  });
  const played = useRef(placement);
  // 可见的同一棵树在位置变化时播放动效，切换目录或收起时直接定位。
  const isSameTree = placement.scope === scope;
  if (!isSameTree || placement.position !== position) {
    setPlacement({
      position,
      scope,
      isAnimated: isSameTree && enabled,
    });
  }

  useLayoutEffect(() => {
    if (played.current === placement) return;
    played.current = placement;
    if (!placement.isAnimated || !enabled) return;
    const row = rowRef.current;
    const tree = treeRef.current;
    const preview = previewRef.current;
    const canvas = canvasRef.current;
    if (row && tree && preview && canvas) {
      return playTreeParticles(row, tree, preview, canvas, placement.position);
    }
  }, [placement, enabled, rowRef, treeRef, previewRef, canvasRef]);

  return placement.position;
}
