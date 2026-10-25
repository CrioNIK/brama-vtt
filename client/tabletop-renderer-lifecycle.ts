export interface MapRenderer<Input extends { viewport: { width: number; height: number } }> {
  init(): Promise<void>; update(input: Input): void; resize(width: number, height: number): void; destroy(): void;
}

/** Keep only the latest committed input while initialization is pending; cleanup is idempotent. */
export function startMapRenderer<Input extends { viewport: { width: number; height: number } }>(
  renderer: MapRenderer<Input>, onError: (error: unknown) => void,
) {
  let active = true, initialized = false, latest: Input | null = null;
  const fail = (error: unknown) => { initialized = false; if (active) { renderer.destroy(); onError(error); } };
  const flush = () => {
    if (!active || !initialized || !latest) return;
    try { renderer.resize(latest.viewport.width, latest.viewport.height); renderer.update(latest); } catch (error) { fail(error); }
  };
  const ready = (async () => {
    try {
      await renderer.init();
      if (!active) { renderer.destroy(); return; }
      initialized = true; flush();
    } catch (error) { if (active) fail(error); }
  })();
  return { ready,
    update(input: Input) { if (!active) return; latest = input; flush(); },
    destroy() { if (!active) return; active = false; initialized = false; latest = null; renderer.destroy(); },
  };
}
