import { AlphaFilter, Assets, Container, Graphics, Sprite, Text, VERSION, WebGLRenderer, type Texture } from 'pixi.js';
import type { Actor, Member, Point, Scene, Wall } from '../../shared/model';
import { tokenResources } from '../../shared/model';
import { effectiveWallDirection, inLevel, tokenBodyRadius } from '../../shared/geometry';
import { analyticRegion } from './AnalyticRegion';
import { lightPaintPlan, observerTerms, type ObserverRegion, type LightRegion } from './visibility';

export interface PixiViewport { width: number; height: number; zoom: number; pan: Point; scale: number }
export interface PixiSceneInput {
  scene: Scene; actors: Actor[]; self: Member;
  selection: { kind: 'token' | 'wall' | 'light'; id: string } | null;
  currentCombatTokenId?: string;
  preview?: { id: string; at: Point } | null;
  annotation?: { kind: 'wall' | 'door' | 'ruler'; start: Point; end: Point; label?: string } | null;
  vision: readonly ObserverRegion[]; lightVisibility: readonly LightRegion[];
  viewport: PixiViewport; tool?: string; locale?: string;
}
export interface PixiDiagnostics {
  status: 'initializing' | 'ready' | 'error' | 'context-lost' | 'destroyed';
  backend: 'webgl'; pixiVersion: string; contextVersion: number | null;
  contextAvailable: boolean; contextLost: boolean; width: number; height: number;
  resolution: number; frameCount: number; sceneBuilds: number; error?: string;
}
interface Retained { key: string; node: Container }

function label(value: string, x: number, y: number, size: number, color: string, stroke?: string) {
  const text = new Text({ text: value, style: { fontFamily: 'Segoe UI, sans-serif', fontSize: size, fill: color,
    ...(stroke ? { stroke: { color: stroke, width: 4 } } : {}) } });
  text.anchor.set(.5); text.position.set(x, y); return text;
}
function dashed(graphics: Graphics, a: Point, b: Point, color: string, width: number, dash = 10, gap = 8) {
  const length = Math.hypot(b.x - a.x, b.y - a.y); if (!(length > 0)) return;
  for (let at = 0; at < length; at += dash + gap) {
    const end = Math.min(length, at + dash);
    graphics.moveTo(a.x + (b.x - a.x) * at / length, a.y + (b.y - a.y) * at / length)
      .lineTo(a.x + (b.x - a.x) * end / length, a.y + (b.y - a.y) * end / length);
  }
  graphics.stroke({ color, width });
}
function dashedRect(g: Graphics, x: number, y: number, width: number, height: number, color: string) {
  const points = [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
  for (let i = 0; i < 4; i++) dashed(g, points[i], points[(i + 1) % 4], color, 2, 9, 8);
}
function dispose(node: Container) { node.destroy({ children: true, context: true }); }

/** Retained WebGL scene. React owns input, permission checks, controls and accessibility. */
export class PixiScene {
  private renderer: WebGLRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly stage = new Container();
  private readonly world = new Container();
  private readonly background = new Container();
  private readonly lightLayer = new Container();
  private readonly wallLayer = new Container();
  private readonly handleLayer = new Container();
  private readonly tokenLayer = new Container();
  private readonly fogLayer = new Container();
  private readonly annotationLayer = new Container();
  private readonly fogFilter = new AlphaFilter({ alpha: 1, resolution: 'inherit', antialias: 'inherit' });
  private readonly retained = new Map<Container, Map<string, Retained>>();
  private readonly regionIds = new WeakMap<object, number>();
  private nextRegionId = 1;
  private backgroundKey = '';
  private fogKey = '';
  private annotationKey = '';
  private annotationLabel: Text | null = null;
  private latest: PixiSceneInput | null = null;
  private frameRequest = 0;
  private disposed = false;
  private initialized = false;
  private diagnostics: PixiDiagnostics = { status: 'initializing', backend: 'webgl', pixiVersion: VERSION,
    contextVersion: null, contextAvailable: false, contextLost: false, width: 0, height: 0,
    resolution: 1, frameCount: 0, sceneBuilds: 0 };

  constructor(private readonly host: HTMLElement, private readonly onStatus?: (diagnostics: PixiDiagnostics) => void) {
    this.stage.eventMode = 'none'; this.world.eventMode = 'none';
    this.stage.addChild(this.world);
    this.world.addChild(this.background, this.lightLayer, this.wallLayer, this.handleLayer, this.tokenLayer, this.fogLayer, this.annotationLayer);
    // Erase only this isolated fog target, never the underlying map/tokens framebuffer.
    this.fogLayer.filters = [this.fogFilter];
  }

  async init(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    this.emit();
    const renderer = new WebGLRenderer();
    this.renderer = renderer;
    try {
      await renderer.init({ width: Math.max(1, this.host.clientWidth), height: Math.max(1, this.host.clientHeight),
        resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true, antialias: true,
        background: '#101820', backgroundAlpha: 1, preferWebGLVersion: 2, preserveDrawingBuffer: false });
      if (this.disposed) { renderer.destroy(true); return; }
      const canvas = renderer.canvas;
      this.canvas = canvas;
      canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block';
      canvas.setAttribute('aria-hidden', 'true'); canvas.dataset.renderer = 'pixi-webgl';
      canvas.addEventListener('webglcontextlost', this.contextLost);
      canvas.addEventListener('webglcontextrestored', this.contextRestored);
      this.host.appendChild(canvas);
      this.diagnostics = { ...this.diagnostics, status: 'ready', contextVersion: renderer.context.webGLVersion,
        contextAvailable: !!renderer.gl, contextLost: renderer.context.isLost,
        resolution: renderer.resolution, width: renderer.screen.width, height: renderer.screen.height };
      if (!this.diagnostics.contextAvailable || this.diagnostics.contextLost) throw new Error('WebGL context unavailable');
      // Scene coordinates are squared in the analytic disk test. Half-precision
      // fragment arithmetic can overflow even on ordinary maps; never silently use it.
      const precision = renderer.gl.getShaderPrecisionFormat(renderer.gl.FRAGMENT_SHADER, renderer.gl.HIGH_FLOAT);
      if (!precision || precision.precision === 0) throw new Error('High-precision WebGL fragment shaders are unavailable');
      this.emit();
      if (this.latest) this.update(this.latest); else this.requestRender();
    } catch (error) { if (!this.disposed) this.fail(error); throw error; }
  }

  getDiagnostics(): PixiDiagnostics { return { ...this.diagnostics }; }
  private emit() { this.onStatus?.(this.getDiagnostics()); }
  private fail(error: unknown) {
    this.diagnostics = { ...this.diagnostics, status: 'error', error: error instanceof Error ? error.message : String(error) };
    this.emit();
  }
  private contextLost = (event: Event) => {
    event.preventDefault(); this.diagnostics = { ...this.diagnostics, status: 'context-lost', contextLost: true }; this.emit();
  };
  private contextRestored = () => {
    if (this.disposed) return;
    this.diagnostics = { ...this.diagnostics, status: 'ready', contextLost: false, error: undefined }; this.emit(); this.requestRender();
  };
  private requestRender() {
    if (this.frameRequest || this.disposed || this.diagnostics.status !== 'ready') return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      if (!this.renderer || this.disposed || this.diagnostics.status !== 'ready') return;
      try { this.renderer.render(this.stage); this.diagnostics.frameCount++; this.emit(); }
      catch (error) { this.fail(error); }
    });
  }
  resize(width: number, height: number) {
    if (!this.renderer || this.diagnostics.status !== 'ready' || !(width > 0 && height > 0)) return;
    if (this.renderer.screen.width !== width || this.renderer.screen.height !== height) this.renderer.resize(width, height);
    this.diagnostics.width = width; this.diagnostics.height = height;
    this.requestRender();
  }
  private regionId(region: object) {
    let id = this.regionIds.get(region); if (!id) { id = this.nextRegionId++; this.regionIds.set(region, id); } return id;
  }
  private sync(layer: Container, items: { id: string; key: string; build: () => Container; update?: (node: Container) => void }[]) {
    let records = this.retained.get(layer); if (!records) { records = new Map(); this.retained.set(layer, records); }
    const keep = new Set(items.map(item => item.id));
    for (const [id, entry] of records) if (!keep.has(id)) { dispose(entry.node); records.delete(id); }
    items.forEach((item, index) => {
      let entry = records!.get(item.id);
      if (!entry || entry.key !== item.key) {
        if (entry) dispose(entry.node);
        entry = { key: item.key, node: item.build() }; records!.set(item.id, entry); layer.addChild(entry.node);
        this.diagnostics.sceneBuilds++;
      }
      item.update?.(entry.node);
      layer.setChildIndex(entry.node, index);
    });
  }
  update(input: PixiSceneInput) {
    this.latest = input;
    if (this.disposed || this.diagnostics.status !== 'ready') return;
    try {
      const { scene, self, selection, viewport } = input;
      this.resize(viewport.width, viewport.height);
      this.world.position.set(viewport.width / 2 + viewport.pan.x - scene.width * viewport.scale / 2,
        viewport.height / 2 + viewport.pan.y - scene.height * viewport.scale / 2);
      this.world.scale.set(viewport.scale);
      this.updateBackground(scene);
      const gm = self.role === 'gm';
      const lights = scene.lights.filter(light => inLevel(light, scene.activeLevelId));
      const regions = new Map(input.lightVisibility.map(light => [light.id, light.region]));
      this.sync(this.lightLayer, lights.filter(light => light.enabled && light.dim > 0 && regions.has(light.id)).map(light => ({
        id: light.id, key: JSON.stringify([light, this.regionId(regions.get(light.id)!), scene.width, scene.height]), build: () => {
          const node = new Container();
          const plan = lightPaintPlan(regions.get(light.id)!);
          if (plan.isolated) {
            const filter = new AlphaFilter({ alpha: 1, resolution: 'inherit', antialias: 'inherit' });
            node.filters = [filter]; node.on('destroyed', () => filter.destroy());
          }
          for (const term of plan.terms) {
            term.disks.push({ x: light.x, y: light.y, radius: light.dim });
            const shape = analyticRegion(term, scene.width, scene.height, { color: light.color, gradient: light, overwrite: plan.overwrite });
            if (shape) node.addChild(shape);
          }
          return node;
        },
      })));
      this.sync(this.wallLayer, scene.walls.filter(wall => inLevel(wall, scene.activeLevelId)).map(wall => ({
        id: wall.id, key: JSON.stringify([wall.a, wall.b, wall.kind, wall.state, wall.direction, selection?.kind === 'wall' && selection.id === wall.id, input.tool, scene.background]),
        build: () => this.buildWall(wall, input),
      })));
      this.sync(this.handleLayer, gm ? lights.map(light => ({ id: light.id, key: JSON.stringify([light, selection?.kind === 'light' && selection.id === light.id]), build: () => {
        const g = new Graphics();
        if (selection?.kind === 'light' && selection.id === light.id) g.circle(light.x, light.y, light.dim).stroke({ color: light.color, width: 1 });
        g.circle(light.x, light.y, 10).fill({ color: light.color, alpha: light.enabled ? 1 : .3 });
        g.circle(light.x, light.y, 16).stroke({ color: light.color, width: 1, alpha: .4 }); return g;
      } })) : []);
      this.sync(this.tokenLayer, scene.tokens.filter(token => token.levelId === scene.activeLevelId).map(token => {
        const hp = tokenResources(token, input.actors), position = input.preview?.id === token.id ? input.preview.at : token;
        const selected = selection?.kind === 'token' && selection.id === token.id;
        const combat = input.currentCombatTokenId === token.id;
        return { id: token.id, key: JSON.stringify([token.name, token.width, token.height, token.rotation,
          token.color, token.hidden, hp, selected, combat, scene.grid.size]), update: (node: Container) => node.position.set(position.x, position.y), build: () => {
          const node = new Container(); node.position.set(position.x, position.y); node.alpha = token.hidden ? .4 : 1;
          const w = token.width * scene.grid.size, h = token.height * scene.grid.size, radius = tokenBodyRadius(token, scene.grid.size);
          const g = new Graphics();
          if (combat) g.roundRect(-w / 2 - 10, -h / 2 - 10, w + 20, h + 20, 9).stroke({ color: '#f3d18a', width: 3 });
          if (selected) dashedRect(g, -w / 2 - 6, -h / 2 - 6, w + 12, h + 12, token.color);
          g.circle(0, 0, radius).fill('#17232c').stroke({ color: token.color, width: 3.5 });
          g.circle(0, 0, Math.max(0, radius - 5)).stroke({ color: token.color, width: 1, alpha: .18 });
          node.addChild(g);
          const facing = new Graphics().poly([-5, radius - 5, 0, radius + 2, 5, radius - 5]).fill(token.color);
          facing.rotation = token.rotation * Math.PI / 180; node.addChild(facing);
          node.addChild(label(token.name.slice(0, 1).toUpperCase(), 0, 0, radius * 1.13, '#e9eef0'));
          if (hp.hp !== null && hp.maxHp !== null) {
            const ratio = Math.max(0, Math.min(1, hp.hp / Math.max(1, hp.maxHp)));
            const bar = new Graphics().roundRect(-radius, radius + 9, radius * 2, 5, 2.5).fill('#3a4949');
            if (ratio > 0) bar.roundRect(-radius, radius + 9, ratio * radius * 2, 5, Math.min(2.5, ratio * radius)).fill(hp.hp < hp.maxHp * .3 ? '#d77e6c' : '#6bc799');
            node.addChild(bar);
          }
          node.addChild(label(token.name, 0, radius + 27, 13, '#dce5e9', '#142029'));
          return node;
        } };
      }));
      const fog = !gm && scene.visionEnabled;
      const fogKey = JSON.stringify([scene.id, self.id, self.role, scene.activeLevelId, scene.width, scene.height, fog, scene.globalLightEnabled,
        input.vision.map(v => [v.id, v.x, v.y, v.radius, v.lightPerceptionRadius, v.full, this.regionId(v.region)]),
        lights.map(l => [l.id, l.x, l.y, l.enabled, l.dim, regions.has(l.id) ? this.regionId(regions.get(l.id)!) : null])]);
      if (fogKey !== this.fogKey) {
        this.fogKey = fogKey; this.fogLayer.removeChildren().forEach(dispose); this.fogLayer.visible = fog;
        if (fog) {
          this.fogLayer.addChild(new Graphics().rect(0, 0, scene.width, scene.height).fill('#0b1118'));
          for (const term of observerTerms({ ...scene, lights }, input.vision, input.lightVisibility)) {
            const shape = analyticRegion(term, scene.width, scene.height, { color: '#ffffff', erase: true });
            if (shape) this.fogLayer.addChild(shape);
          }
        }
        this.diagnostics.sceneBuilds++;
      }
      const annotationKey = JSON.stringify(input.annotation ?? null);
      if (annotationKey !== this.annotationKey) {
        this.annotationKey = annotationKey; this.annotationLayer.removeChildren().forEach(dispose); this.annotationLabel = null;
        const a = input.annotation;
        if (a) {
          const line = new Graphics(); dashed(line, a.start, a.end, '#e4c576', 3, 8, 5); this.annotationLayer.addChild(line);
          if (a.kind === 'ruler') { this.annotationLabel = label(a.label ?? '', (a.start.x + a.end.x) / 2, (a.start.y + a.end.y) / 2 - 15, 16, '#ffffff', '#18232b'); this.annotationLayer.addChild(this.annotationLabel); }
        }
      }
      if (this.annotationLabel) this.annotationLabel.scale.set(1 / viewport.scale);
      this.requestRender();
    } catch (error) { this.fail(error); }
  }

  private updateBackground(scene: Scene) {
    const key = JSON.stringify([scene.id, scene.background, scene.width, scene.height, scene.grid.type, scene.grid.size]);
    if (key === this.backgroundKey) return;
    this.backgroundKey = key; this.background.removeChildren().forEach(dispose);
    this.background.addChild(new Graphics().rect(0, 0, scene.width, scene.height).fill(scene.background.startsWith('#') ? scene.background : '#18232b'));
    if (scene.background.startsWith('/assets/')) {
      void Assets.load<Texture>(scene.background).then(texture => {
        if (this.disposed || this.backgroundKey !== key) return;
        const sprite = new Sprite(texture); sprite.width = scene.width; sprite.height = scene.height;
        this.background.addChildAt(sprite, 1); this.requestRender();
      }).catch(error => { if (!this.disposed && this.backgroundKey === key) this.fail(error); });
    }
    if (scene.grid.type === 'square' && scene.grid.size > 0) {
      const grid = new Graphics();
      for (let x = 0; x <= scene.width; x += scene.grid.size) grid.moveTo(x, 0).lineTo(x, scene.height);
      for (let y = 0; y <= scene.height; y += scene.grid.size) grid.moveTo(0, y).lineTo(scene.width, y);
      grid.stroke({ color: '#6b858e', width: 1, alpha: .23 }); this.background.addChild(grid);
    }
    this.diagnostics.sceneBuilds++;
  }

  private buildWall(wall: Wall, input: PixiSceneInput) {
    const selected = input.selection?.kind === 'wall' && input.selection.id === wall.id;
    const door = wall.kind !== 'wall', asset = input.scene.background.startsWith('/assets');
    const color = selected ? '#f4d88b' : door ? wall.state === 'open' ? '#72b9ac' : '#d7b777' : '#c3ced2';
    const width = door ? 7 : selected || input.tool === 'wall' || input.tool === 'door' || !asset ? 4 : 1.5;
    const node = new Container(), g = new Graphics();
    if (wall.state === 'open') dashed(g, wall.a, wall.b, color, width);
    else g.moveTo(wall.a.x, wall.a.y).lineTo(wall.b.x, wall.b.y).stroke({ color, width });
    g.alpha = door || selected || !asset || input.tool === 'wall' ? 1 : .28;
    node.addChild(g);
    if (selected) {
      g.circle(wall.a.x, wall.a.y, 5).fill(color).circle(wall.b.x, wall.b.y, 5).fill(color);
      if (effectiveWallDirection(wall) !== 'both') this.addDirection(node, wall);
    }
    return node;
  }
  private addDirection(node: Container, wall: Wall) {
    const length = Math.hypot(wall.b.x - wall.a.x, wall.b.y - wall.a.y); if (!(length > 0)) return;
    const dx = (wall.b.x - wall.a.x) / length, dy = (wall.b.y - wall.a.y) / length;
    const side = effectiveWallDirection(wall) === 'left' ? 1 : -1, nx = dy * side, ny = -dx * side;
    const g = new Graphics().poly([wall.a.x, wall.a.y, wall.b.x, wall.b.y, wall.b.x + nx * 20, wall.b.y + ny * 20,
      wall.a.x + nx * 20, wall.a.y + ny * 20]).fill({ color: '#f4d88b', alpha: .28 }).stroke({ color: '#f4d88b', width: 1, alpha: .65 });
    const x = (wall.a.x + wall.b.x) / 2, y = (wall.a.y + wall.b.y) / 2;
    g.moveTo(x - dx * 14, y - dy * 14).lineTo(x + dx * 14, y + dy * 14)
      .moveTo(x + dx * 8 + dy * 4, y + dy * 8 - dx * 4).lineTo(x + dx * 14, y + dy * 14)
      .lineTo(x + dx * 8 - dy * 4, y + dy * 8 + dx * 4).stroke({ color: '#fff7db', width: 2 });
    node.addChild(g, label('A', wall.a.x - dx * 13, wall.a.y - dy * 13, 12, '#fff7db', '#17232c'),
      label('B', wall.b.x + dx * 13, wall.b.y + dy * 13, 12, '#fff7db', '#17232c'));
  }

  destroy() {
    if (this.disposed) return; this.disposed = true;
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    const renderer = this.renderer;
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.contextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.contextRestored);
    }
    this.stage.destroy({ children: true, context: true }); this.fogFilter.destroy(); this.retained.clear(); this.latest = null;
    if (renderer && this.diagnostics.contextAvailable) renderer.destroy(true);
    this.renderer = null; this.canvas = null; this.diagnostics = { ...this.diagnostics, status: 'destroyed', contextAvailable: false }; this.emit();
  }
}
