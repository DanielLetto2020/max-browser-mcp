(function () {
  if (globalThis.MaxCursorMotion) return;
  globalThis.MaxCursorMotion = (() => {
    const TUNE = {
      baseMs: 80,
      perBitMs: 70,
      targetPx: 24,
      minMs: 140,
      maxMs: 380,
      releaseMs: 380,
      arc: 0.1,
      arcMaxPx: 30,
      elbow: { x: 0.6, y: 0.8 },
      overshoot: 0.03,
      overshootMaxPx: 4,
      mainEnds: 0.8,
      fixStarts: 0.66,
      steps: 16,
      leanDeg: 9,
      leanAtPxPerMs: 1.8,
    };
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const smoothstep5 = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (10 - 15 * t + 6 * t * t));
    const translateCss = pt => `translate(${pt.x.toFixed(2)}px, ${pt.y.toFixed(2)}px)`;

    function planTrip(from, to) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const dist = Math.max(Math.hypot(dx, dy), 1e-6);
      const rawMs = TUNE.baseMs + TUNE.perBitMs * Math.log2(dist / TUNE.targetPx + 1);
      const durationMs = dist < 0.5 ? 0 : Math.round(clamp(rawMs, TUNE.minMs, TUNE.maxMs));
      const overshoot = Math.min(TUNE.overshoot * dist, TUNE.overshootMaxPx);
      const side = dx * TUNE.elbow.y - dy * TUNE.elbow.x > 0 ? -1 : 1;
      const arc = side * Math.min(TUNE.arc * dist, TUNE.arcMaxPx);
      const points = Array.from({ length: TUNE.steps + 1 }, (_, i) => {
        const s = i / TUNE.steps;
        const fix = overshoot * smoothstep5((s - TUNE.fixStarts) / (1 - TUNE.fixStarts));
        const along = ((dist + overshoot) * smoothstep5(s / TUNE.mainEnds) - fix) / dist;
        const perp = (arc * Math.sin(Math.PI * clamp(along, 0, 1))) / dist;
        return { x: from.x + dx * along - dy * perp, y: from.y + dy * along + dx * perp };
      });
      return {
        durationMs,
        releaseMs: Math.min(durationMs, TUNE.releaseMs),
        points,
        keyframes: points.map(pt => ({ transform: translateCss(pt) })),
      };
    }

    const anims = new WeakMap();
    function play(el, keyframes, durationMs) {
      anims.get(el)?.cancel();
      const anim = el.animate(keyframes, durationMs);
      anims.set(el, anim);
      return anim;
    }
    function placeCursor(el, pt) {
      anims.get(el)?.cancel();
      el.style.transform = translateCss(pt);
    }

    return {
      moveCursor(el, to, onDone = () => {}, hooks = []) {
        const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const from = reduced ? to : (() => {
          const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
          return { x: m.m41, y: m.m42 };
        })();
        const trip = planTrip(from, to);
        placeCursor(el, to);
        if (trip.durationMs === 0) {
          onDone();
          return Promise.resolve();
        }
        play(el, trip.keyframes, trip.durationMs).onfinish = onDone;
        hooks.forEach(fn => fn(trip));
        return new Promise(resolve => setTimeout(resolve, trip.releaseMs));
      },
      placeCursor,
      lean(arrowEl) {
        return ({ points, durationMs }) => {
          const last = points.length - 1;
          play(
            arrowEl,
            points.map((_, i) => {
              const prev = points[Math.max(i - 1, 0)];
              const next = points[Math.min(i + 1, last)];
              const diagVel = i % last === 0 ? 0 : ((next.x - prev.x - (next.y - prev.y)) * Math.SQRT1_2 * last) / (2 * durationMs);
              return { transform: `rotate(${(TUNE.leanDeg * Math.tanh(diagVel / TUNE.leanAtPxPerMs)).toFixed(2)}deg)` };
            }),
            durationMs
          );
        };
      },
    };
  })();
})();
