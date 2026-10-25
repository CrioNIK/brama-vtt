import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MousePointer2, Hand, UserRound, BrickWall, DoorOpen, Lightbulb, Ruler, Minus, Plus, Maximize, Focus } from 'lucide-react';
import { getLocale, t as tr } from '../shared/i18n';
import type { Point, Token, Wall } from '../shared/model';
import { tokenResources } from '../shared/model';
import { effectiveWallDirection, inLevel } from '../shared/geometry';
import type { TabletopProps, Tool, Selection } from './Tabletop';
import { PixiScene, type PixiDiagnostics, type PixiSceneInput } from './renderer/PixiScene';
import { TabletopGeometryCache } from './tabletop-geometry';
import { tabletopRegions } from './tabletop-scene';
import { keyboardTokenDestination, pickTabletopObject, screenToWorld, snapTokenCenter, worldToScreen, zoomAtScreenPoint } from './tabletop-interaction';
import { startMapRenderer } from './tabletop-renderer-lifecycle';

const TOOLS = [
  { id: 'select', label: 'Select and move', icon: MousePointer2 }, { id: 'pan', label: 'Pan map', icon: Hand },
  { id: 'token', label: 'Add token', icon: UserRound }, { id: 'wall', label: 'Draw wall', icon: BrickWall },
  { id: 'door', label: 'Draw door', icon: DoorOpen }, { id: 'light', label: 'Add light', icon: Lightbulb },
  { id: 'ruler', label: 'Measure distance', icon: Ruler },
] as const;
type Gesture = { start: Point; end: Point; kind: Tool | 'token'; tokenId?: string; screen?: Point; origin?: Point };
type RendererState = Pick<PixiDiagnostics, 'status' | 'error' | 'contextVersion'>;

function wallLabel(wall: Wall) {
  const direction = effectiveWallDirection(wall);
  const side = direction === 'left' ? tr('Configured blocking side: left of A → B')
    : direction === 'right' ? tr('Configured blocking side: right of A → B') : tr('Configured blocking side: both sides');
  const kind = wall.kind === 'wall' ? tr('Wall') : wall.kind === 'secret'
    ? wall.state === 'open' ? tr('Secret door: open') : wall.state === 'locked' ? tr('Secret door: locked') : tr('Secret door: closed')
    : wall.state === 'open' ? tr('Door: open') : wall.state === 'locked' ? tr('Door: locked') : tr('Door: closed');
  return tr('{wall}. {direction}. A ({ax}, {ay}) → B ({bx}, {by}).', {
    wall: kind, direction: side, ax: wall.a.x, ay: wall.a.y, bx: wall.b.x, by: wall.b.y,
  });
}

/** React owns input and accessibility; Pixi owns every visible map pixel. */
export function PixiTabletop({ scene, actors, self, selection, setSelection, command, onCreateToken, online,
  currentCombatTokenId, onRendererDiagnostics }: TabletopProps) {
  const wrap = useRef<HTMLDivElement>(null), viewportHost = useRef<HTMLDivElement>(null), canvasHost = useRef<HTMLDivElement>(null);
  const geometryCache = useRef<TabletopGeometryCache | null>(null);
  if (geometryCache.current === null) geometryCache.current = new TabletopGeometryCache();
  const rendererSession = useRef<ReturnType<typeof startMapRenderer<PixiSceneInput>> | null>(null);
  const latestInput = useRef<PixiSceneInput | null>(null), diagnosticsSink = useRef(onRendererDiagnostics);
  const [rendererState, setRendererState] = useState<RendererState>({ status: 'initializing', contextVersion: null });
  const [retry, setRetry] = useState(0);
  const [size, setSize] = useState({ width: 1000, height: 700 }), [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<Tool>('select'), [gesture, setGesture] = useState<Gesture | null>(null);
  const [preview, setPreview] = useState<{ id: string; at: Point } | null>(null);
  const [measurement, setMeasurement] = useState<{ start: Point; end: Point } | null>(null);
  const fit = Math.min(size.width / scene.width, size.height / scene.height), gm = self.role === 'gm';
  const viewport = { ...size, zoom, pan, scale: fit * zoom };
  const ready = rendererState.status === 'ready';
  const tokens = scene.tokens.filter(token => token.levelId === scene.activeLevelId);
  const walls = scene.walls.filter(wall => inLevel(wall, scene.activeLevelId));
  const lights = scene.lights.filter(light => inLevel(light, scene.activeLevelId));
  const regions = tabletopRegions(scene, self, geometryCache.current);
  const ruler = gesture?.kind === 'ruler' ? gesture : tool === 'ruler' ? measurement : null;
  const rulerDistance = ruler ? Math.hypot(ruler.end.x - ruler.start.x, ruler.end.y - ruler.start.y) / scene.grid.size * scene.grid.distance : 0;
  const annotation: PixiSceneInput['annotation'] = gesture && (gesture.kind === 'wall' || gesture.kind === 'door')
    ? { kind: gesture.kind, start: gesture.start, end: gesture.end }
    : ruler ? { kind: 'ruler', start: ruler.start, end: ruler.end, label: `${rulerDistance.toFixed(1)} ${scene.grid.units}` } : null;
  const input: PixiSceneInput = { scene, actors, self, selection, currentCombatTokenId, preview, annotation, ...regions, viewport, tool, locale: getLocale() };

  useLayoutEffect(() => {
    diagnosticsSink.current = onRendererDiagnostics;
    latestInput.current = input;
    rendererSession.current?.update(input);
  });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize(current => current.width === width && current.height === height ? current : { width, height });
    });
    if (wrap.current) observer.observe(wrap.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const host = canvasHost.current; if (!host) return;
    let active = true;
    setRendererState({ status: 'initializing', contextVersion: null });
    const renderer = new PixiScene(host, diagnostics => {
      if (!active || diagnostics.status === 'destroyed') return;
      diagnosticsSink.current?.(diagnostics);
      // Frame counters belong to the optional harness sink, never to React render state.
      setRendererState(current => current.status === diagnostics.status && current.error === diagnostics.error && current.contextVersion === diagnostics.contextVersion
        ? current : { status: diagnostics.status, error: diagnostics.error, contextVersion: diagnostics.contextVersion });
    });
    const session = startMapRenderer(renderer, error => {
      if (active) setRendererState({ status: 'error', error: error instanceof Error ? error.message : String(error), contextVersion: null });
    });
    rendererSession.current = session;
    if (latestInput.current) session.update(latestInput.current);
    return () => {
      active = false;
      if (rendererSession.current === session) rendererSession.current = null;
      session.destroy();
    };
  }, [retry]);
  useEffect(() => {
    const compact = size.width < 600, initialZoom = compact ? Math.min(4, Math.max(1, .65 / fit)) : 1;
    const focus = compact ? scene.tokens.find(token => token.levelId === scene.activeLevelId && token.owners.includes(self.id)) : undefined;
    setZoom(initialZoom); setPan(focus ? { x: (scene.width / 2 - focus.x) * fit * initialZoom, y: (scene.height / 2 - focus.y) * fit * initialZoom } : { x: 0, y: 0 });
    setGesture(null); setPreview(null); setMeasurement(null); setSelection(null);
  }, [scene.id, size.width < 600]);
  // A permission/level transition cancels stale drags without moving their committed source.
  useEffect(() => { setGesture(null); setPreview(null); }, [scene.activeLevelId, self.id, self.role, online]);

  const point = (event: { clientX: number; clientY: number }): Point | null => {
    const rect = viewportHost.current?.getBoundingClientRect();
    return rect ? screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top }, scene, viewport) : null;
  };
  const snapVertex = (p: Point) => scene.grid.type === 'none' ? p : { x: Math.round(p.x / scene.grid.size) * scene.grid.size, y: Math.round(p.y / scene.grid.size) * scene.grid.size };
  const canMove = (token: Token) => ready && online && (gm || token.owners.includes(self.id));
  function down(event: React.PointerEvent<HTMLDivElement>) {
    if (!ready || (event.button !== 0 && event.button !== 1)) return;
    const at = point(event); if (!at) return;
    event.preventDefault(); viewportHost.current?.focus({ preventScroll: true });
    viewportHost.current?.setPointerCapture(event.pointerId);
    if (tool === 'pan' || event.button === 1) { setGesture({ start: at, end: at, kind: 'pan', screen: { x: event.clientX, y: event.clientY }, origin: pan }); return; }
    if (tool === 'select') {
      const hit = pickTabletopObject(scene, at, viewport.scale, gm); setSelection(hit);
      const token = hit?.kind === 'token' ? tokens.find(value => value.id === hit.id) : undefined;
      if (token && canMove(token)) setGesture({ start: at, end: at, kind: 'token', tokenId: token.id, origin: { x: token.x, y: token.y } });
      return;
    }
    if (tool === 'token' && gm && online) { onCreateToken(scene.grid.type === 'none' ? at : { x: (Math.floor(at.x / scene.grid.size) + .5) * scene.grid.size, y: (Math.floor(at.y / scene.grid.size) + .5) * scene.grid.size }); return; }
    if (tool === 'light' && gm && online) { void command('light.create', { sceneId: scene.id, levelId: scene.activeLevelId, ...snapVertex(at), name: tr('Light source'), bright: 100, dim: 200, color: '#e7bb71', enabled: true }); return; }
    if ((tool === 'wall' || tool === 'door') && (!gm || !online)) return;
    if (tool === 'wall' || tool === 'door' || tool === 'ruler') setGesture({ start: tool === 'ruler' ? at : snapVertex(at), end: at, kind: tool });
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    if (!gesture) return;
    if (gesture.kind === 'pan') { setPan({ x: gesture.origin!.x + event.clientX - gesture.screen!.x, y: gesture.origin!.y + event.clientY - gesture.screen!.y }); return; }
    const at = point(event); if (!at) return;
    if (gesture.kind === 'token') {
      const token = tokens.find(value => value.id === gesture.tokenId); if (!token || !canMove(token)) { setGesture(null); setPreview(null); return; }
      setPreview({ id: token.id, at: snapTokenCenter({ x: gesture.origin!.x + at.x - gesture.start.x, y: gesture.origin!.y + at.y - gesture.start.y }, token, scene) });
    }
    setGesture({ ...gesture, end: gesture.kind === 'ruler' || gesture.kind === 'token' ? at : snapVertex(at) });
  }
  function up(event: React.PointerEvent<HTMLDivElement>) {
    if (viewportHost.current?.hasPointerCapture(event.pointerId)) viewportHost.current.releasePointerCapture(event.pointerId);
    if (!gesture) return;
    const token = gesture.kind === 'token' ? tokens.find(value => value.id === gesture.tokenId) : undefined;
    if (token && preview && canMove(token)) void command('token.move', { id: preview.id, sceneId: scene.id, ...preview.at, ...(gm && event.altKey ? { bypass: true } : {}) });
    if (ready && gm && online && (gesture.kind === 'wall' || gesture.kind === 'door') && Math.hypot(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y) > 5)
      void command('wall.create', { sceneId: scene.id, levelId: scene.activeLevelId, a: gesture.start, b: gesture.end, kind: gesture.kind, state: 'closed', movement: true, sight: true, light: true, sound: true });
    if (gesture.kind === 'ruler') setMeasurement({ start: gesture.start, end: gesture.end });
    setGesture(null); setPreview(null);
  }
  function tokenKey(event: React.KeyboardEvent, token: Token) {
    const destination = keyboardTokenDestination(event.key, token, scene.grid.size);
    if (!destination || !canMove(token)) return;
    event.preventDefault(); event.stopPropagation();
    void command('token.move', { id: token.id, sceneId: scene.id, ...destination });
  }
  function focusSelection() {
    const object = selection?.kind === 'token' ? tokens.find(token => token.id === selection.id)
      : selection?.kind === 'light' ? lights.find(light => light.id === selection.id) : undefined;
    const wall = selection?.kind === 'wall' ? walls.find(value => value.id === selection.id) : undefined;
    const at = object ?? (wall ? { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 } : undefined);
    if (!at) return;
    const next = Math.min(4, Math.max(1, 50 / (fit * scene.grid.size)));
    setZoom(next); setPan({ x: (scene.width / 2 - at.x) * fit * next, y: (scene.height / 2 - at.y) * fit * next });
  }
  function objectButton(value: Exclude<Selection, null>, at: Point, label: string, token?: Token) {
    const screen = worldToScreen(at, scene, viewport);
    return <button key={`${value.kind}-${value.id}`} type="button" className="map-object-accessible" data-map-object={value.id}
      data-token-id={token?.id} style={{ left: screen.x, top: screen.y }} aria-label={label}
      aria-pressed={selection?.kind === value.kind && selection.id === value.id}
      onPointerDown={event => event.stopPropagation()} onClick={() => setSelection(value)}
      onKeyDown={event => { if (token) tokenKey(event, token); }}>{label}</button>;
  }
  return <div className="tabletop pixi-tabletop" ref={wrap}>
    <div ref={viewportHost} className={`pixi-viewport world tool-${tool}`} role="application" tabIndex={0}
      aria-label={tr('Map: {p0}', { p0: scene.name })} data-render-status={rendererState.status}
      data-render-backend={ready ? 'webgl' : rendererState.status === 'initializing' ? 'pending' : 'unavailable'}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setGesture(null); setPreview(null); }}
      onDoubleClick={event => {
        if (!ready || !online || tool !== 'select') return; const at = point(event); if (!at) return;
        const hit = pickTabletopObject(scene, at, viewport.scale, gm), wall = hit?.kind === 'wall' ? walls.find(value => value.id === hit.id) : undefined;
        if (wall && wall.kind !== 'wall') void command('door.toggle', { id: wall.id, sceneId: scene.id });
      }}
      onKeyDown={event => { if (event.target === event.currentTarget && selection?.kind === 'token') { const token = tokens.find(value => value.id === selection.id); if (token) tokenKey(event, token); } }}
      onWheel={event => {
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect();
        const next = zoomAtScreenPoint(viewport, { x: event.clientX - rect.left, y: event.clientY - rect.top }, zoom * (event.deltaY < 0 ? 1.1 : .9));
        setPan(next.pan); setZoom(next.zoom);
      }}>
      <div ref={canvasHost} className="pixi-canvas-host"/>
      <div className="map-accessibility" aria-label={tr('Map objects')}>
        {walls.map(wall => objectButton({ kind: 'wall', id: wall.id }, { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 }, wallLabel(wall)))}
        {gm && lights.map(light => objectButton({ kind: 'light', id: light.id }, light, tr('Light: {p0}', { p0: light.name })))}
        {tokens.map(token => { const hp = tokenResources(token, actors); return objectButton({ kind: 'token', id: token.id }, preview?.id === token.id ? preview.at : token,
          tr('Token {p0}, HP {p1} of {p2}', { p0: token.name, p1: hp.hp ?? tr('unknown'), p2: hp.maxHp ?? tr('unknown') }), token); })}
      </div>
    </div>
    {!ready && <div className="map-render-message" role={rendererState.status === 'initializing' ? 'status' : 'alert'}>
      <p>{rendererState.status === 'initializing' ? tr('Starting WebGL map…') : rendererState.status === 'context-lost' ? tr('The WebGL context was lost.') : tr('WebGL map unavailable.')}</p>
      {rendererState.status !== 'initializing' && <><button type="button" onClick={() => setRetry(value => value + 1)}>{tr('Retry WebGL')}</button><p>{tr('Choose SVG comparison to use the reference renderer.')}</p></>}
    </div>}
    <div className="tools" aria-label={tr('Map tools')}>{TOOLS.filter(item => gm || ['select', 'pan', 'ruler'].includes(item.id)).map(item => <button key={item.id} type="button"
      title={tr(item.label)} aria-label={tr(item.label)} aria-pressed={tool === item.id} onClick={() => { setTool(item.id); setGesture(null); setPreview(null); }} className={tool === item.id ? 'active' : ''}><item.icon size={21}/></button>)}</div>
    <div className="zoom-bar"><button aria-label={tr('Zoom out')} onClick={() => setZoom(value => Math.max(.3, value / 1.2))}><Minus size={18}/></button><span>{Math.round(zoom * 100)}%</span>
      <button aria-label={tr('Zoom in')} onClick={() => setZoom(value => Math.min(4, value * 1.2))}><Plus size={18}/></button>
      <button aria-label={tr('Fit map')} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize size={17}/></button></div>
    {selection && <button className="focus-selection" aria-label={tr('Show selected object')} title={tr('Show selected object')} onClick={focusSelection}><Focus size={20}/></button>}
    <div className="canvas-hint">{tool === 'wall' || tool === 'door' ? tr('Drag from the start to the end of the segment') : tool === 'ruler' ? tr('Drag to measure · straight-line distance')
      : tool === 'token' ? tr('Click the map to place a token') : tool === 'light' ? tr('Click the map to place a light')
      : selection ? gm ? tr('Drag to move · Alt to pass through walls') : tr('Arrow keys move the selected token') : tr('Select an object to open its properties')}</div>
  </div>;
}
