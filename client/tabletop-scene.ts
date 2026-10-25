import type { Scene, Member } from '../shared/model';
import { effectiveLightPerceptionRadius, effectiveVisionRadius, inLevel, sceneSourceRadius, tokenExternalRadius } from '../shared/geometry';
import type { ObserverRegion, LightRegion } from './renderer/visibility';
import { TabletopGeometryCache } from './tabletop-geometry';

/** Committed scene positions only: visual drag previews never become vision sources. */
export function tabletopRegions(scene: Scene, self: Member, cache: TabletopGeometryCache): { vision: ObserverRegion[]; lightVisibility: LightRegion[] } {
  const geometry = cache.forScene(scene, self), maxRadius = sceneSourceRadius(scene);
  const rayRadius = (x: number, y: number) => 2 * (Math.hypot(scene.width, scene.height) + Math.hypot(x, y));
  const vision = self.role !== 'gm' && scene.visionEnabled ? scene.tokens
    .filter(token => token.levelId === scene.activeLevelId && token.owners.includes(self.id) && token.visionEnabled !== false)
    .map(token => {
      const lightPerceptionRadius = effectiveLightPerceptionRadius(token, scene.grid.size);
      return { id: token.id, x: token.x, y: token.y, radius: effectiveVisionRadius(token, scene.grid.size), lightPerceptionRadius,
        full: token.visionUnlimited || (scene.globalLightEnabled && lightPerceptionRadius === Infinity),
        region: geometry.region({ origin: token, radius: maxRadius, rayRadius: rayRadius(token.x, token.y), channel: 'sight',
          externalRadius: tokenExternalRadius(token, scene.grid.size) }) };
    }) : [];
  const lightVisibility = scene.lights.filter(light => inLevel(light, scene.activeLevelId) && light.enabled && light.dim > 0)
    .map(light => ({ id: light.id, region: geometry.region({ origin: light, radius: Math.min(light.dim, maxRadius),
      rayRadius: rayRadius(light.x, light.y), channel: 'light' }) }));
  return { vision, lightVisibility };
}
