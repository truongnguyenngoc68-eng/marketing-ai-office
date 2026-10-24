/* Phi Phi walks the handoff itself. Visual state only; no project/API writes. */
(() => {
  const scene = document.getElementById('scene');
  if (!scene || typeof staff === 'undefined') return;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const sprite = 'assets/phi-phi-2d-v1.png';
  let trip = null, frame = null, previousProject = app.active;
  const walker = document.createElement('div');
  walker.id = 'phi-walker';
  walker.className = 'phi-walker';
  walker.hidden = true;
  walker.setAttribute('aria-hidden', 'true');
  walker.innerHTML = `
    <span class="walk-shadow"></span>
    <span class="walk-identity"></span>
    <div class="walk-facing">
      <svg class="walk-rig" viewBox="0 0 1280 1280" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <defs>
          <clipPath id="phi-walk-torso"><path clip-rule="evenodd" d="M0 0H1280V1045H0Z M292 751H565V912H292Z M786 865H973V1015H786Z"/></clipPath>
          <clipPath id="phi-walk-arm-left"><rect x="292" y="751" width="273" height="161"/></clipPath>
          <clipPath id="phi-walk-arm-right"><rect x="786" y="865" width="187" height="150"/></clipPath>
          <clipPath id="phi-walk-leg-left"><path d="M466 1008H647V1191H466Z"/></clipPath>
          <clipPath id="phi-walk-leg-right"><path d="M648 997H831V1170H648Z"/></clipPath>
        </defs>
        <g class="walk-leg walk-leg-left"><image href="${sprite}" width="1280" height="1280" clip-path="url(#phi-walk-leg-left)"/></g>
        <g class="walk-leg walk-leg-right"><image href="${sprite}" width="1280" height="1280" clip-path="url(#phi-walk-leg-right)"/></g>
        <g class="walk-upper">
          <image href="${sprite}" width="1280" height="1280" clip-path="url(#phi-walk-torso)"/>
          <g class="walk-arm walk-arm-left"><image href="${sprite}" width="1280" height="1280" clip-path="url(#phi-walk-arm-left)"/></g>
          <g class="walk-arm walk-arm-right"><image href="${sprite}" width="1280" height="1280" clip-path="url(#phi-walk-arm-right)"/></g>
        </g>
      </svg>
      <span class="walk-folder"><span></span><i></i></span>
    </div>
    <span class="walk-caption"></span>`;
  scene.append(walker);

  function findIndex(value) {
    if (Number.isInteger(value)) return value >= 0 && value < staff.length ? value : -1;
    return staff.findIndex(person => person.id === value);
  }
  function actor(index) { return scene.querySelector(`[data-actor="${index}"]`); }
  function clearStationClasses() {
    scene.querySelectorAll('.walking-away,.receiving-handoff').forEach(node => node.classList.remove('walking-away', 'receiving-handoff'));
  }
  function syncStation() {
    clearStationClasses();
    if (!trip) return;
    actor(trip.from)?.classList.add('walking-away');
    if (trip.phase === 'deliver') actor(trip.to)?.classList.add('receiving-handoff');
    const step = document.getElementById('step');
    if (step) step.disabled = true;
  }
  function hideOldCourier() {
    const old = document.getElementById('courier');
    if (old) { old.classList.remove('moving'); old.hidden = true; }
    if (typeof courierTimer !== 'undefined') clearTimeout(courierTimer);
  }
  function cancel() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    trip = null;
    walker.hidden = true;
    walker.className = 'phi-walker';
    clearStationClasses();
    const r = typeof run === 'function' ? run() : null;
    const step = document.getElementById('step');
    if (step) step.disabled = !r || r.complete || !!r.gate || r.step >= r.limit;
  }
  function foot(index) { return { x: staff[index].x, y: staff[index].y + 3.5 }; }
  function exit(index) {
    if ([0, 1, 2, 5].includes(index)) return { x: 40, y: 44 };
    if ([4, 6, 7].includes(index)) return { x: 63, y: 48 };
    if ([8, 9].includes(index)) return { x: 42, y: 61 };
    if ([10, 11].includes(index)) return { x: 60, y: 64 };
    return { x: 50, y: 52 };
  }
  function route(from, to) {
    const points = [foot(from), exit(from), { x: 50, y: 55 }, exit(to), foot(to)];
    return points.filter((point, index) => !index || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > .5);
  }
  // Physical speed is measured in floor coordinates, not in viewport pixels.
  function length(points) {
    return points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index].x, (point.y - points[index].y) * .65), 0);
  }
  function along(points, progress) {
    let remaining = length(points) * Math.max(0, Math.min(1, progress));
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1], b = points[index];
      const distance = Math.hypot(b.x - a.x, (b.y - a.y) * .65);
      if (remaining <= distance || index === points.length - 1) {
        const ratio = distance ? Math.min(1, remaining / distance) : 1;
        return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio, direction: b.x < a.x ? -1 : 1 };
      }
      remaining -= distance;
    }
    return { ...points.at(-1), direction: 1 };
  }
  function place(point) {
    walker.style.left = `${point.x}%`;
    walker.style.top = `${point.y}%`;
    walker.style.zIndex = String(20 + Math.round(point.y));
    walker.style.setProperty('--walk-facing', point.direction || 1);
  }
  function setPhase(phase) {
    if (!trip) return;
    trip.phase = phase;
    trip.elapsed = 0;
    walker.classList.toggle('is-delivering', phase === 'deliver');
    walker.classList.toggle('is-returning', phase === 'return');
    const caption = walker.querySelector('.walk-caption');
    caption.textContent = phase === 'deliver' ? `Bàn giao cho ${staff[trip.to].short}` : phase === 'return' ? 'Quay về vị trí' : `Mang tài liệu đến ${staff[trip.to].short}`;
    syncStation();
  }
  function tick(now) {
    frame = null;
    if (!trip) return;
    if (app.active !== trip.project || reduced.matches) { cancel(); return; }
    const delta = Math.min(now - trip.last, 80);
    trip.last = now;
    const paused = app.motion === false || document.hidden;
    walker.classList.toggle('is-paused', paused);
    if (!paused) {
      trip.elapsed += delta;
      if (trip.phase === 'out') {
        place(along(trip.path, trip.elapsed / trip.duration));
        if (trip.elapsed >= trip.duration) setPhase('deliver');
      } else if (trip.phase === 'deliver') {
        if (trip.elapsed >= 650) setPhase('return');
      } else {
        place(along(trip.path.slice().reverse(), trip.elapsed / trip.duration));
        if (trip.elapsed >= trip.duration) { cancel(); return; }
      }
    }
    frame = requestAnimationFrame(tick);
  }
  function start(fromValue, toValue) {
    const from = findIndex(fromValue), to = findIndex(toValue);
    cancel();
    hideOldCourier();
    if (from < 0 || to < 0 || from === to || app.motion === false || reduced.matches) return;
    const path = route(from, to);
    trip = { from, to, path, project: app.active, phase: 'out', elapsed: 0, last: performance.now(), duration: Math.max(1350, Math.min(2600, length(path) * 35)) };
    const person = staff[from];
    walker.querySelector('.walk-identity').textContent = `${person.short} · ${person.id}`;
    walker.style.setProperty('--identity-color', person.color || '#a8cbe7');
    walker.hidden = false;
    place({ ...path[0], direction: staff[to].x < person.x ? -1 : 1 });
    setPhase('out');
    frame = requestAnimationFrame(tick);
  }

  handoff = start;
  const renderBeforeWalking = render;
  render = function(...args) {
    if (app.active !== previousProject) { cancel(); previousProject = app.active; }
    const result = renderBeforeWalking.apply(this, args);
    hideOldCourier();
    syncStation();
    return result;
  };
  // Let the sender complete the trip before another simulated handoff begins.
  // Actual task completion may call handoff again; that deliberately replaces the old visual trip.
  const advanceBeforeWalking = advance;
  advance = function(...args) { if (trip) return; return advanceBeforeWalking.apply(this, args); };
  const next = document.getElementById('step');
  if (next) next.onclick = advance;
  reduced.addEventListener('change', event => { if (event.matches) cancel(); });
  window.addEventListener('tram:handoff', event => start(event.detail?.from, event.detail?.to));
  window.addEventListener('tram:accountchange', cancel);
  window.addEventListener('tram:logout', cancel);
  window.addEventListener('pagehide', cancel);
  window.TramWalking = Object.freeze({
    handoff: start,
    cancel,
    getState: () => trip ? { from: staff[trip.from].id, to: staff[trip.to].id, phase: trip.phase, projectId: trip.project, paused: app.motion === false } : null
  });
  hideOldCourier();
})();
