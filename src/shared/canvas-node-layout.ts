import type { AssetCanvasNode, AssetCanvasNodeLayout, AssetCanvasNodeType } from "./contracts.js";

/** Default sizes of the only node types whose size the user controls; other nodes size to their content. */
export const RESIZABLE_CANVAS_NODE_SIZES = {
  text: { width: 300, height: 190 },
  document: { width: 360, height: 330 },
  table: { width: 640, height: 360 },
} as const;

export function isResizableCanvasNodeType(type: AssetCanvasNodeType): type is keyof typeof RESIZABLE_CANVAS_NODE_SIZES {
  return Object.hasOwn(RESIZABLE_CANVAS_NODE_SIZES, type);
}

export function canvasNodeLayout(
  node: Pick<AssetCanvasNode, "position" | "width" | "height">,
): AssetCanvasNodeLayout {
  return {
    ...node.position,
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
  };
}

export function canvasNodeContent({
  position: _position,
  width: _width,
  height: _height,
  ...node
}: AssetCanvasNode) {
  return node;
}

export function applyCanvasNodeLayout(
  node: AssetCanvasNode,
  layout: AssetCanvasNodeLayout,
): AssetCanvasNode {
  return {
    ...node,
    position: { x: layout.x, y: layout.y },
    ...(layout.width !== undefined ? { width: layout.width } : {}),
    ...(layout.height !== undefined ? { height: layout.height } : {}),
  };
}
