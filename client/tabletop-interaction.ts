import type { Point, Scene, Token } from '../shared/model';
import { inLevel, tokenBodyRadius } from '../shared/geometry';
import type { PixiViewport } from './renderer/PixiScene';
import type { Selection } from './Tabletop';

export function worldToScreen(point: Point, scene: Pick<Scene, 'width' | 'height'>, view: PixiViewport): Point {
  return { x: view.width / 2 + view.pan.x + (point.x - scene.width / 2) * view.scale,
    y: view.height / 2 + view.pan.y + (point.y - scene.height / 2) * view.scale };
}
export function screenToWorld(point: Point, scene: Pick<Scene, 'width' | 'height'>, view: PixiViewport): Point | null {
  if (!Number.isFinite(view.scale) || view.scale <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: (point.x - view.width / 2 - view.pan.x) / view.scale + scene.width / 2,
    y: (point.y - view.height / 2 - view.pan.y) / view.scale + scene.height / 2 };
}
export function zoomAtScreenPoint(view: PixiViewport, anchor: Point, zoom: number): { zoom: number; pan: Point } {
  const next = Math.max(.3, Math.min(4, zoom));
  const p = { x: anchor.x - view.width / 2, y: anchor.y - view.height / 2 };
  return { zoom: next, pan: { x: p.x - (p.x - view.pan.x) * next / view.zoom,
    y: p.y - (p.y - view.pan.y) * next / view.zoom } };
}
export function snapTokenCenter(point: Point, token: Token, scene: Scene): Point {
  if (scene.grid.type === 'none') return point;
  const halfW = token.width * scene.grid.size / 2, halfH = token.height * scene.grid.size / 2;
  return { x: Math.round((point.x - halfW) / scene.grid.size) * scene.grid.size + halfW,
    y: Math.round((point.y - halfH) / scene.grid.size) * scene.grid.size + halfH };
}
export function keyboardTokenDestination(key: string, token: Token, gridSize: number): Point | null {
  const delta: Record<string, Point> = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } };
  return delta[key] ? { x: token.x + delta[key].x * gridSize, y: token.y + delta[key].y * gridSize } : null;
}

/** Mirror the rendered layer order; wall picking keeps the prior 18 CSS-pixel hit stroke. */
export function pickTabletopObject(scene: Scene, point: Point, scale: number, gm: boolean): Selection {
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  for (const token of [...scene.tokens].reverse()) {
    if (token.levelId !== scene.activeLevelId) continue;
    const radius = tokenBodyRadius(token, scene.grid.size);
    if (Math.hypot(point.x - token.x, point.y - token.y) <= radius + 2) return { kind: 'token', id: token.id };
    // HP/name rows were interactive in the SVG token group as well.
    if (Math.abs(point.x - token.x) <= radius && point.y >= token.y + radius + 7 && point.y <= token.y + radius + 36)
      return { kind: 'token', id: token.id };
  }
  if (gm) for (const light of [...scene.lights].reverse()) {
    if (inLevel(light, scene.activeLevelId) && Math.hypot(point.x - light.x, point.y - light.y) <= 17) return { kind: 'light', id: light.id };
  }
  for (const wall of [...scene.walls].reverse()) {
    if (!inLevel(wall, scene.activeLevelId)) continue;
    const dx = wall.b.x - wall.a.x, dy = wall.b.y - wall.a.y, length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((point.x - wall.a.x) * dx + (point.y - wall.a.y) * dy) / length)) : 0;
    if (Math.hypot(point.x - wall.a.x - t * dx, point.y - wall.a.y - t * dy) <= 9 / scale) return { kind: 'wall', id: wall.id };
  }
  return null;
}
