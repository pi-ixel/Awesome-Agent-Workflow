export interface NativeLayerFact {
  readonly position: string;
  readonly zIndex: number;
  readonly visible: boolean;
  readonly withinViewport: boolean;
  readonly containsViewport: boolean;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export function isNativeOccludingLayer(
  layer: NativeLayerFact,
  viewport: NativeLayerFact["rect"],
): boolean {
  if (
    !layer.visible ||
    layer.withinViewport ||
    layer.containsViewport ||
    !["fixed", "absolute"].includes(layer.position) ||
    layer.zIndex < 20
  )
    return false;
  return (
    layer.rect.left < viewport.right &&
    layer.rect.right > viewport.left &&
    layer.rect.top < viewport.bottom &&
    layer.rect.bottom > viewport.top
  );
}
