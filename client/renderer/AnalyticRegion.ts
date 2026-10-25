import { Color, Container, Graphics, Mesh, MeshGeometry, Shader } from 'pixi.js';
import { termBounds, type VisibilityTerm } from './visibility';

const vertex = `precision highp float;
in vec2 aPosition;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vScenePosition;
void main() {
  vScenePosition = aPosition;
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
}`;
const fragment = `precision highp float;
in vec2 vScenePosition;
uniform vec3 uDisk0;
uniform vec3 uDisk1;
uniform vec3 uDisk2;
uniform vec3 uDisk3;
uniform vec4 uPaint;
uniform vec4 uGradient;
out vec4 finalColor;
bool outsideDisk(vec3 disk) {
  vec2 delta = vScenePosition - disk.xy;
  return disk.z >= 0.0 && dot(delta, delta) > disk.z * disk.z;
}
void main() {
  if (outsideDisk(uDisk0) || outsideDisk(uDisk1) || outsideDisk(uDisk2) || outsideDisk(uDisk3)) discard;
  float alpha = uPaint.a;
  if (uGradient.z > 0.0) {
    float distanceRatio = length(vScenePosition - uGradient.xy) / uGradient.z;
    if (distanceRatio > 1.0) discard;
    float bright = clamp(uGradient.w, 0.0, 1.0);
    alpha = distanceRatio <= bright && bright > 0.0
      ? mix(0.25, 0.20, distanceRatio / bright)
      : mix(0.20, 0.0, (distanceRatio - bright) / max(0.000001, 1.0 - bright));
  }
  finalColor = vec4(uPaint.rgb * alpha, alpha);
}`;

export interface RegionPaint { color: string; alpha?: number; erase?: boolean; overwrite?: boolean; gradient?: { x: number; y: number; dim: number; bright: number } }

/** Polygon intersections use the GPU stencil; circular edges use fragment equations. */
export function analyticRegion(term: VisibilityTerm, width: number, height: number, paint: RegionPaint): Container | null {
  const bounds = termBounds(term, width, height);
  if (!bounds) return null;
  if (term.disks.length > 4) throw new Error('Visibility term exceeds the supported analytic disk count');
  const { left, top, right, bottom } = bounds;
  const geometry = new MeshGeometry({ positions: new Float32Array([left, top, right, top, right, bottom, left, bottom]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
  geometry.batchMode = 'no-batch';
  const color = new Color(paint.color).toNumber();
  const disks = Array.from({ length: 4 }, (_, index) => {
    const disk = term.disks[index];
    return { value: disk && Number.isFinite(disk.radius) ? [disk.x, disk.y, disk.radius] : [0, 0, -1], type: 'vec3<f32>' as const };
  });
  const gradient = paint.gradient;
  const shader = Shader.from({ gl: { vertex, fragment, preferredFragmentPrecision: 'highp' }, resources: { analyticUniforms: {
    uDisk0: disks[0], uDisk1: disks[1], uDisk2: disks[2], uDisk3: disks[3],
    uPaint: { value: [(color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255, paint.alpha ?? 1], type: 'vec4<f32>' },
    uGradient: { value: gradient ? [gradient.x, gradient.y, gradient.dim, gradient.bright / gradient.dim] : [0, 0, 0, 0], type: 'vec4<f32>' },
  } } });
  const mesh = new Mesh({ geometry, shader });
  mesh.blendMode = paint.overwrite ? 'none' : paint.erase ? 'erase' : 'normal';
  if (paint.overwrite) mesh.state.blendMode = 'none';
  mesh.on('destroyed', () => { geometry.destroy(); shader.destroy(); });
  const root = new Container();
  let parent = root;
  for (const points of term.polygons) {
    const group = new Container();
    const mask = new Graphics().poly(points.flatMap(point => [point.x, point.y])).fill(0xffffff);
    parent.addChild(group, mask);
    group.mask = mask;
    parent = group;
  }
  parent.addChild(mesh);
  return root;
}
