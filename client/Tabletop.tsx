import { t as tr } from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { MousePointer2, Hand, UserRound, BrickWall, DoorOpen, Lightbulb, Ruler, Minus, Plus, Maximize, Focus } from 'lucide-react';
import type { Actor, Member, Point, Scene, Token } from '../shared/model';
import { tokenResources } from '../shared/model';
import { inLevel, tokenBodyRadius, visibilityPolygon } from '../shared/geometry';
import type { SendCommand } from './session';

export type Tool = 'select' | 'pan' | 'token' | 'wall' | 'door' | 'light' | 'ruler';
export type Selection = { kind: 'token' | 'wall' | 'light'; id: string } | null;
const TOOLS = [
  { id: 'select', label: "Select and move", icon: MousePointer2 }, { id: 'pan', label: "Pan map", icon: Hand },
  { id: 'token', label: "Add token", icon: UserRound }, { id: 'wall', label: "Draw wall", icon: BrickWall },
  { id: 'door', label: "Draw door", icon: DoorOpen }, { id: 'light', label: "Add light", icon: Lightbulb },
  { id: 'ruler', label: "Measure distance", icon: Ruler },
] as const;
const pts = (points: Point[]) => points.map(p => `${p.x},${p.y}`).join(' ');
export function Tabletop({ scene, actors, self, selection, setSelection, command, onCreateToken, online, currentCombatTokenId }: {
  scene: Scene; actors: Actor[]; self: Member; selection: Selection; setSelection: (value: Selection) => void;
  command: SendCommand; onCreateToken: (point: Point) => void; online: boolean; currentCombatTokenId?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), layer = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 700 }), [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [gesture, setGesture] = useState<{ start: Point; end: Point; kind: string; tokenId?: string; screen?: Point; origin?: Point } | null>(null);
  const [preview, setPreview] = useState<{ id: string; at: Point } | null>(null);
  const [measurement, setMeasurement] = useState<{ start: Point; end: Point } | null>(null);
  const fit = Math.min(size.width / scene.width, size.height / scene.height);
  const gm = self.role === 'gm';
  useEffect(() => { const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); if (wrap.current) observer.observe(wrap.current); return () => observer.disconnect(); }, []);
  useEffect(() => {
    const compact = size.width < 600;
    const initialZoom = compact ? Math.min(4, Math.max(1, .65 / fit)) : 1;
    const focus = compact ? scene.tokens.find(t => t.levelId === scene.activeLevelId && t.owners.includes(self.id)) : undefined;
    setZoom(initialZoom); setPan(focus ? { x: (scene.width / 2 - focus.x) * fit * initialZoom, y: (scene.height / 2 - focus.y) * fit * initialZoom } : { x: 0, y: 0 });
    setGesture(null); setPreview(null); setMeasurement(null); setSelection(null);
  }, [scene.id, size.width < 600]);
  const point = (event: { clientX: number; clientY: number }): Point => {
    const matrix = layer.current?.getScreenCTM(); if (!matrix) return { x: 0, y: 0 };
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: p.x, y: p.y };
  };
  const snapVertex = (p: Point) => scene.grid.type === 'none' ? p : ({ x: Math.round(p.x / scene.grid.size) * scene.grid.size, y: Math.round(p.y / scene.grid.size) * scene.grid.size });
  const snapCenter = (p: Point, token: Token) => scene.grid.type === 'none' ? p : ({
    x: Math.round((p.x - token.width * scene.grid.size / 2) / scene.grid.size) * scene.grid.size + token.width * scene.grid.size / 2,
    y: Math.round((p.y - token.height * scene.grid.size / 2) / scene.grid.size) * scene.grid.size + token.height * scene.grid.size / 2,
  });
  const tokens = scene.tokens.filter(t => t.levelId === scene.activeLevelId);
  const walls = scene.walls.filter(w => inLevel(w, scene.activeLevelId));
  const lights = scene.lights.filter(l => inLevel(l, scene.activeLevelId));
  const vision = useMemo(() => tokens.filter(t => t.owners.includes(self.id) && t.visionEnabled !== false).map(t => {
    // Keep the sampled polygon's circular boundary outside the scene; range is an exact SVG circle.
    const acrossScene = 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(t.x, t.y));
    return { id: t.id, x: t.x, y: t.y, radius: t.vision, full: t.visionUnlimited || scene.globalLightEnabled,
      los: visibilityPolygon(t, acrossScene, scene.walls, scene.activeLevelId) };
  }), [tokens, self.id, scene.walls, scene.activeLevelId, scene.width, scene.height, scene.globalLightEnabled]);
  const lightVisibility = useMemo(() => scene.lights.filter(l => inLevel(l, scene.activeLevelId)).map(light => ({
    id: light.id,
    los: visibilityPolygon(light, 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(light.x, light.y)), scene.walls, scene.activeLevelId, 'light'),
  })), [scene.lights, scene.walls, scene.activeLevelId, scene.width, scene.height]);
  const fog = !gm && scene.visionEnabled;
  function focusSelection() {
    const object = selection?.kind === 'token' ? scene.tokens.find(t => t.id === selection.id)
      : selection?.kind === 'light' ? scene.lights.find(l => l.id === selection.id) : undefined;
    const wall = selection?.kind === 'wall' ? scene.walls.find(w => w.id === selection.id) : undefined;
    const at = object ?? (wall ? { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 } : undefined);
    if (!at) return;
    const nextZoom = Math.min(4, Math.max(1, 50 / (fit * scene.grid.size)));
    setZoom(nextZoom); setPan({ x: (scene.width / 2 - at.x) * fit * nextZoom, y: (scene.height / 2 - at.y) * fit * nextZoom });
  }
  function down(event: React.PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.button !== 1) return;
    const at = point(event); svg.current?.setPointerCapture(event.pointerId);
    if (tool === 'pan' || event.button === 1) { setGesture({ start: at, end: at, kind: 'pan', screen: { x: event.clientX, y: event.clientY }, origin: pan }); return; }
    if (tool === 'select') { setSelection(null); return; }
    if (tool === 'token' && gm && online) { onCreateToken(scene.grid.type === 'none' ? at : { x: (Math.floor(at.x / scene.grid.size) + .5) * scene.grid.size, y: (Math.floor(at.y / scene.grid.size) + .5) * scene.grid.size }); return; }
    if (tool === 'light' && gm && online) { void command('light.create', { sceneId: scene.id, levelId: scene.activeLevelId, ...snapVertex(at), name: tr("Light source"), bright: 100, dim: 200, color: '#e7bb71', enabled: true }); return; }
    if ((tool === 'wall' || tool === 'door') && (!gm || !online)) return;
    setGesture({ start: tool === 'ruler' ? at : snapVertex(at), end: at, kind: tool });
  }
  function move(event: React.PointerEvent<SVGSVGElement>) {
    if (!gesture) return;
    if (gesture.kind === 'pan') { setPan({ x: gesture.origin!.x + event.clientX - gesture.screen!.x, y: gesture.origin!.y + event.clientY - gesture.screen!.y }); return; }
    const at = point(event);
    if (gesture.kind === 'token') {
      const token = scene.tokens.find(t => t.id === gesture.tokenId); if (!token) return;
      setPreview({ id: token.id, at: snapCenter({ x: gesture.origin!.x + at.x - gesture.start.x, y: gesture.origin!.y + at.y - gesture.start.y }, token) });
    }
    setGesture({ ...gesture, end: tool === 'ruler' || gesture.kind === 'token' ? at : snapVertex(at) });
  }
  function up(event: React.PointerEvent<SVGSVGElement>) {
    if (!gesture) return;
    if (gesture.kind === 'token' && preview && online) void command('token.move', { id: preview.id, sceneId: scene.id, ...preview.at, ...(gm && event.altKey ? { bypass: true } : {}) });
    if ((gesture.kind === 'wall' || gesture.kind === 'door') && Math.hypot(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y) > 5) {
      void command('wall.create', { sceneId: scene.id, levelId: scene.activeLevelId, a: gesture.start, b: gesture.end, kind: gesture.kind, state: 'closed', movement: true, sight: true, light: true, sound: true });
    }
    if (gesture.kind === 'ruler') setMeasurement({ start: gesture.start, end: gesture.end });
    setGesture(null);
    setPreview(null);
  }
  const ruler = gesture?.kind === 'ruler' ? gesture : tool === 'ruler' ? measurement : null;
  const rulerDistance = ruler ? Math.hypot(ruler.end.x - ruler.start.x, ruler.end.y - ruler.start.y) / scene.grid.size * scene.grid.distance : 0;
  const annotation = gesture && ['wall', 'door'].includes(gesture.kind) ? gesture : ruler ? { ...ruler, kind: 'ruler' } : null;
  return <div className="tabletop" ref={wrap}>
    <svg ref={svg} className={`world tool-${tool}`} width="100%" height="100%" aria-label={tr("Map: {p0}", { p0: scene.name })} role="application"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { setGesture(null); setPreview(null); }}
      onWheel={event => { event.preventDefault(); const next = Math.min(4, Math.max(.3, zoom * (event.deltaY < 0 ? 1.1 : .9))); const r = svg.current!.getBoundingClientRect(); const p = { x: event.clientX - r.left - size.width / 2, y: event.clientY - r.top - size.height / 2 }; setPan({ x: p.x - (p.x - pan.x) * next / zoom, y: p.y - (p.y - pan.y) * next / zoom }); setZoom(next); }}>
      <defs>
        <pattern id="grid" width={scene.grid.size} height={scene.grid.size} patternUnits="userSpaceOnUse"><path d={`M ${scene.grid.size} 0 L 0 0 0 ${scene.grid.size}`} fill="none" stroke="#6b858e" strokeWidth="1" opacity=".23" /></pattern>
        {vision.map(v => <clipPath key={v.id} id={`sight-${v.id}`}><polygon points={pts(v.los)}/></clipPath>)}
        <mask id="vision-mask" maskUnits="userSpaceOnUse" x="0" y="0" width={scene.width} height={scene.height}>
          <rect width={scene.width} height={scene.height} fill="white" />
          {vision.map(v => <g key={v.id} fill="black">
            {v.full ? <polygon points={pts(v.los)}/> : <g clipPath={`url(#sight-${v.id})`}>
              {v.radius > 0 && <circle cx={v.x} cy={v.y} r={v.radius}/>}
              {lights.filter(l => l.enabled && l.dim > 0).map(light => <circle key={light.id} cx={light.x} cy={light.y} r={light.dim} clipPath={`url(#light-clip-${light.id})`}/>)}
            </g>}
          </g>)}
        </mask>
        {lights.map(light => <radialGradient key={light.id} id={`light-${light.id}`}><stop offset="0" stopColor={light.color} stopOpacity=".25"/><stop offset={light.dim > 0 ? Math.min(1, light.bright / light.dim) : 0} stopColor={light.color} stopOpacity=".2"/><stop offset="1" stopColor={light.color} stopOpacity="0"/></radialGradient>)}
        {lightVisibility.map(light => <clipPath key={light.id} id={`light-clip-${light.id}`}><polygon points={pts(light.los)}/></clipPath>)}
      </defs>
      <g ref={layer} transform={`translate(${size.width / 2 + pan.x} ${size.height / 2 + pan.y}) scale(${fit * zoom}) translate(${-scene.width / 2} ${-scene.height / 2})`}>
        <rect width={scene.width} height={scene.height} fill={scene.background.startsWith('#') ? scene.background : '#18232b'} />
        {scene.background.startsWith('/assets/') && <image href={scene.background} width={scene.width} height={scene.height} preserveAspectRatio="none" />}
        {scene.grid.type === 'square' && <rect width={scene.width} height={scene.height} fill="url(#grid)" pointerEvents="none" />}
        {lights.filter(l => l.enabled).map(light => <circle key={light.id} cx={light.x} cy={light.y} r={light.dim} fill={`url(#light-${light.id})`} clipPath={`url(#light-clip-${light.id})`} pointerEvents="none" />)}
        {walls.map(wall => {
          const selected = selection?.kind === 'wall' && selection.id === wall.id;
          const door = wall.kind !== 'wall'; const color = selected ? '#f4d88b' : door ? wall.state === 'open' ? '#72b9ac' : '#d7b777' : '#c3ced2';
          const label = !door ? tr("Wall") : wall.kind === 'secret'
            ? wall.state === 'open' ? tr("Secret door: open") : wall.state === 'locked' ? tr("Secret door: locked") : tr("Secret door: closed")
            : wall.state === 'open' ? tr("Door: open") : wall.state === 'locked' ? tr("Door: locked") : tr("Door: closed");
          return <g key={wall.id} role="button" tabIndex={0} aria-label={label}
            onPointerDown={event => { if (tool !== 'select' || event.button !== 0) return; event.stopPropagation(); setSelection({ kind: 'wall', id: wall.id }); }}
            onDoubleClick={event => { if (door && tool === 'select') { event.stopPropagation(); void command('door.toggle', { id: wall.id, sceneId: scene.id }); } }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); setSelection({ kind: 'wall', id: wall.id }); } }}>
            <title>{label}</title>
            <rect x={Math.min(wall.a.x, wall.b.x) - 4} y={Math.min(wall.a.y, wall.b.y) - 4} width={Math.abs(wall.b.x - wall.a.x) + 8} height={Math.abs(wall.b.y - wall.a.y) + 8} fill="transparent" pointerEvents="none" />
            <line x1={wall.a.x} y1={wall.a.y} x2={wall.b.x} y2={wall.b.y} stroke="transparent" strokeWidth={18 / (fit * zoom)} />
            <line x1={wall.a.x} y1={wall.a.y} x2={wall.b.x} y2={wall.b.y} stroke={color} strokeWidth={door ? 7 : selected || tool === 'wall' || tool === 'door' || !scene.background.startsWith('/assets') ? 4 : 1.5} opacity={door || selected || !scene.background.startsWith('/assets') || tool === 'wall' ? 1 : .28} strokeDasharray={wall.state === 'open' ? '10 8' : undefined} />
            {selected && [wall.a, wall.b].map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="5" fill={color} />)}
          </g>;
        })}
        {lights.map(light => gm && <g key={light.id} role="button" tabIndex={0} aria-label={tr("Light: {p0}", { p0: light.name })} onPointerDown={event => { if (tool !== 'select' || event.button !== 0) return; event.stopPropagation(); setSelection({ kind: 'light', id: light.id }); }} onKeyDown={event => { if (event.key === 'Enter') setSelection({ kind: 'light', id: light.id }); }}>
          {selection?.id === light.id && <circle cx={light.x} cy={light.y} r={light.dim} stroke={light.color} fill="none" strokeDasharray="5 6" />}
          <circle cx={light.x} cy={light.y} r="10" fill={light.color} opacity={light.enabled ? 1 : .3}/><circle cx={light.x} cy={light.y} r="16" stroke={light.color} fill="none" opacity=".4" />
        </g>)}
        {tokens.map(token => {
          const pos = preview?.id === token.id ? preview.at : token; const selected = selection?.kind === 'token' && selection.id === token.id;
          const w = token.width * scene.grid.size, h = token.height * scene.grid.size, radius = tokenBodyRadius(token, scene.grid.size); const hp = tokenResources(token, actors);
          const canMove = online && (gm || token.owners.includes(self.id));
          return <g key={token.id} role="button" tabIndex={0} aria-label={tr("Token {p0}, HP {p1} of {p2}", { p0: token.name, p1: hp.hp ?? tr("unknown"), p2: hp.maxHp ?? tr("unknown") })} data-token-id={token.id} transform={`translate(${pos.x} ${pos.y})`} opacity={token.hidden ? .4 : 1}
            onPointerDown={event => { if (tool !== 'select' || event.button !== 0) return; event.stopPropagation(); setSelection({ kind: 'token', id: token.id }); if (!canMove) return; svg.current?.setPointerCapture(event.pointerId); setGesture({ start: point(event), end: point(event), kind: 'token', tokenId: token.id, origin: token }); }}
            onKeyDown={event => { const delta: Record<string, Point> = { ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 }, ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 } }; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelection({ kind: 'token', id: token.id }); } if (canMove && delta[event.key]) { event.preventDefault(); void command('token.move', { id: token.id, sceneId: scene.id, x: token.x + delta[event.key].x * scene.grid.size, y: token.y + delta[event.key].y * scene.grid.size }); } }}>
            {currentCombatTokenId === token.id && <rect x={-w / 2 - 10} y={-h / 2 - 10} width={w + 20} height={h + 20} rx="9" fill="none" stroke="#f3d18a" strokeWidth="3" pointerEvents="none"><title>{tr("Current turn")}</title></rect>}
            {selected && <rect x={-w / 2 - 6} y={-h / 2 - 6} width={w + 12} height={h + 12} fill="none" stroke={token.color} strokeWidth="2" strokeDasharray="9 8" />}
            <circle r={radius} fill="#17232c" stroke={token.color} strokeWidth="3.5"/><circle r={radius - 5} fill="none" stroke={token.color} strokeWidth="1" opacity=".18"/>
            <path d={`M -5 ${radius - 5} L 0 ${radius + 2} L 5 ${radius - 5}`} fill={token.color} transform={`rotate(${token.rotation})`} pointerEvents="none"/>
            <text textAnchor="middle" dominantBaseline="central" fill="#e9eef0" fontSize={radius * 1.13} fontFamily="Segoe UI, sans-serif" pointerEvents="none">{token.name.slice(0, 1).toUpperCase()}</text>
            {hp.hp !== null && hp.maxHp !== null && <><rect x={-radius} y={radius + 9} width={radius * 2} height="5" rx="2.5" fill="#3a4949"/><rect x={-radius} y={radius + 9} width={Math.max(0, Math.min(1, hp.hp / Math.max(1, hp.maxHp))) * radius * 2} height="5" rx="2.5" fill={hp.hp < hp.maxHp * .3 ? '#d77e6c' : '#6bc799'}/></>}
            <text className="token-name" textAnchor="middle" y={radius + 32} fill="#dce5e9" fontSize="13" paintOrder="stroke" stroke="#142029" strokeWidth="4">{token.name}</text>
          </g>;
        })}
        {fog && <rect width={scene.width} height={scene.height} fill="#0b1118" mask="url(#vision-mask)" pointerEvents="none" />}
        {annotation && <g pointerEvents="none"><line x1={annotation.start.x} y1={annotation.start.y} x2={annotation.end.x} y2={annotation.end.y} stroke="#e4c576" strokeWidth="3" strokeDasharray="8 5"/>{annotation.kind === 'ruler' && <text x={(annotation.start.x + annotation.end.x) / 2} y={(annotation.start.y + annotation.end.y) / 2 - 15} fill="#fff" fontSize={16 / (fit * zoom)} textAnchor="middle" paintOrder="stroke" stroke="#18232b" strokeWidth="4">{rulerDistance.toFixed(1)} {scene.grid.units}</text>}</g>}
      </g>
    </svg>
    <div className="tools" aria-label={tr("Map tools")}>{TOOLS.filter(item => gm || ['select', 'pan', 'ruler'].includes(item.id)).map(item => <button key={item.id} type="button" title={tr(item.label)} aria-label={tr(item.label)} aria-pressed={tool === item.id} onClick={() => { setTool(item.id); setGesture(null); }} className={tool === item.id ? 'active' : ''}><item.icon size={21} /></button>)}</div>
    <div className="zoom-bar"><button aria-label={tr("Zoom out")} onClick={() => setZoom(z => Math.max(.3, z / 1.2))}><Minus size={18}/></button><span>{Math.round(zoom * 100)}%</span><button aria-label={tr("Zoom in")} onClick={() => setZoom(z => Math.min(4, z * 1.2))}><Plus size={18}/></button><button aria-label={tr("Fit map")} onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}><Maximize size={17}/></button></div>
    {selection && <button className="focus-selection" aria-label={tr("Show selected object")} title={tr("Show selected object")} onClick={focusSelection}><Focus size={20}/></button>}
    <div className="canvas-hint">{tool === 'wall' || tool === 'door' ? tr("Drag from the start to the end of the segment") : tool === 'ruler' ? tr("Drag to measure · straight-line distance") : tool === 'token' ? tr("Click the map to place a token") : tool === 'light' ? tr("Click the map to place a light") : selection ? gm ? tr("Drag to move · Alt to pass through walls") : tr("Arrow keys move the selected token") : tr("Select an object to open its properties")}</div>
  </div>;
}
