/* Subway Founders: Chile. Cabinet mappings are preserved from the challenge starter. */
const CABINET_KEYS = {
  P1_U: ['w'],
  P1_D: ['s'],
  P1_L: ['a'],
  P1_R: ['d'],
  P1_1: ['u'],
  P1_2: ['i'],
  P1_3: ['o'],
  P1_4: ['j'],
  P1_5: ['k'],
  P1_6: ['l'],
  P2_U: ['ArrowUp'],
  P2_D: ['ArrowDown'],
  P2_L: ['ArrowLeft'],
  P2_R: ['ArrowRight'],
  P2_1: ['r'],
  P2_2: ['t'],
  P2_3: ['y'],
  P2_4: ['f'],
  P2_5: ['g'],
  P2_6: ['h'],
  START1: ['Enter'],
  START2: ['2'],
};

/* Deterministic simulation. Read state for rendering; change it only through advance.
   elapsedSeconds is capped at 0.25 per call so a suspended tab cannot fast-forward a run. */
const RunRules = (() => {
  const {floor, max, min, sign, abs} = Math;
  const STEP = 1 / 120;
  const START_SPEED = 40;
  const ACCELERATION = 1;
  const RAMP_SECONDS = 30;
  const LATE_ACCELERATION = 0.28;
  const ROW_GAP = 52;
  const HORIZON = 260;
  const LANE_SPEED = 7.5;
  const GRAVITY = 28;
  const JUMP_SPEED = 11;
  const SLIDE_TIME = 0.72;
  const TOKEN_REWARD = 250000;
  const TRAIL_SIZE = 256;
  const MOTION_FIELDS = ['distance', 'laneX', 'jump', 'slide'];
  const CHASER_FIELDS = ['laneX', 'jump', 'slide', 'z'];
  const internals = new WeakMap();

  function regionAt(distance) {
    return [3,0,1,2,4][floor(distance / 600) % 5];
  }

  function followRoute(state, run, closing = 0) {
    const pose = state.chaser;
    pose.z = -pose.gap * (1 - closing);
    const distance = state.distance + pose.z;
    let index = run.chaseCursor;
    let next = (index + 1) % TRAIL_SIZE;
    while (next !== run.trailHead && run.trail[next].distance <= distance) {
      index = next;
      next = (index + 1) % TRAIL_SIZE;
    }
    run.chaseCursor = index;
    const before = run.trail[index];
    const after = next === run.trailHead ? before : run.trail[next];
    const span = after.distance - before.distance;
    const t = span > 0 ? max(0, min(1, (distance - before.distance) / span)) : 0;
    pose.laneX = before.laneX + (after.laneX - before.laneX) * t;
    pose.jump = before.jump + (after.jump - before.jump) * t;
    pose.slide = before.slide;
  }

  function recordRoute(state, run) {
    const gap = 11 + (state.boost - 1) * 6 - state.chaser.gap;
    state.chaser.gap += state.recovery > 0 ? state.distance - run.previous.distance : sign(gap) * min(abs(gap), STEP * 8);
    const head = run.trailHead;
    const point = run.trail[head];
    for (const key of MOTION_FIELDS) point[key] = state[key];
    run.trailHead = (head + 1) % TRAIL_SIZE;
    if (run.chaseCursor === head) run.chaseCursor = run.trailHead;
    followRoute(state, run);
  }

  function remember(state, run) {
    for (const key of MOTION_FIELDS) run.previous[key] = state[key];
    for (const key of CHASER_FIELDS) run.previous.chaser[key] = state.chaser[key];
  }

  /* Reuses a read-only view. Its values remain valid until the next sample call. */
  function sample(state) {
    if (state.phase !== 'running') return state;
    const run = internals.get(state);
    const t = max(0, min(1, run.accumulator / STEP));
    const view = run.view;
    Object.assign(view, state);
    for (const key of MOTION_FIELDS) view[key] = run.previous[key] + (state[key] - run.previous[key]) * t;
    view.region = regionAt(view.distance);
    view.chaser = run.viewChaser;
    Object.assign(view.chaser, state.chaser);
    for (const key of CHASER_FIELDS) view.chaser[key] = run.previous.chaser[key] + (state.chaser[key] - run.previous.chaser[key]) * t;
    const offset = state.distance - view.distance;
    view.objects = run.viewObjects;
    view.objects.length = 0;
    for (let i = 0; i < state.objects.length; i++) {
      const object = run.objectViews[i] || (run.objectViews[i] = {});
      Object.assign(object, state.objects[i]);
      object.z += offset;
      view.objects.push(object);
    }
    return view;
  }

  function random(run) {
    let value = run.random;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    run.random = value >>> 0;
    return run.random / 4294967296;
  }

  function addObject(state, run, type, lane, worldZ, variant) {
    state.objects.push({
      id: run.nextId++, type, lane, z: worldZ - state.distance,
      length: type === 'train' ? 16 : type === 'coin' ? 0.6 : 1.8,
      variant,
    });
  }

  function fillRoad(state, run) {
    const types = ['train', 'barrier', 'gate'];
    while (run.nextRow <= state.distance + HORIZON) {
      const freeLane = floor(random(run) * 3) - 1;
      for (let lane = -1; lane <= 1; lane++) {
        if (lane === freeLane) continue;
        const type = types[floor(random(run) * types.length)];
        addObject(state, run, type, lane, run.nextRow, floor(random(run) * 3));
      }
      if (run.nextRow >= run.nextScooter) {
        const offset = run.nextRow === 110 ? 56 + (run.seed >>> 4) % 3 * 12 : 24;
        if (!state.scooter) addObject(state, run, 'scooter', freeLane, run.nextRow - offset, 0);
        run.nextScooter = run.nextRow + ROW_GAP * (14 + (Math.imul(run.seed ^ run.nextId, 1597334677) >>> 0) % 9);
      }
      for (let offset = -12; offset <= 12; offset += 6) {
        addObject(state, run, 'coin', freeLane, run.nextRow + offset, 0);
      }
      run.nextRow += ROW_GAP;
    }
  }

  function reset(state, seed, phase, attempt) {
    const run = {
      seed, attempt, random: seed || 1, tick: 0, captureTicks: 0,
      accumulator: 0, jumpVelocity: 0, nextRow: 110, nextId: 1,
      nextScooter: 110,
      trailHead: 0, chaseCursor: 0,
      trail: Array.from({length: TRAIL_SIZE}, (_, i) => ({distance: (i - TRAIL_SIZE + 1) * .2, laneX: 0, jump: 0, slide: 0})),
      previous: {chaser: {}}, view: {}, viewChaser: {}, viewObjects: [], objectViews: [],
    };
    Object.assign(state, {
      phase, time: 0, distance: 0, speed: START_SPEED, score: 0,
      tokens: 0, lane: 0, laneX: 0, jump: 0, slide: 0,
      region: regionAt(0), objects: [], captureTime: 0, scooter: false, recovery: 0, boost: 1,
      chaser: {gap: 11, z: -11, laneX: 0, jump: 0, slide: 0},
    });
    internals.set(state, run);
    remember(state, run);
    fillRoad(state, run);
    return state;
  }

  function create(seed = 1) {
    return reset({}, Number.isFinite(seed) ? seed >>> 0 || 1 : 1, 'title', 0);
  }

  function begin(state, events) {
    const run = internals.get(state);
    if (state.phase === 'result') {
      const nextSeed = (run.seed + 0x9e3779b9) >>> 0 || 1;
      reset(state, nextSeed, 'running', run.attempt + 1);
    } else {
      state.phase = 'running';
    }
    events.push('start');
  }

  function setPaused(state, events, paused) {
    state.phase = paused ? 'paused' : 'running';
    const run = internals.get(state);
    run.accumulator = 0;
    remember(state, run);
    events.push(paused ? 'pause' : 'resume');
  }

  function command(state, action, events) {
    if (action === 'blur') {
      if (state.phase === 'running') setPaused(state, events, true);
      return;
    }
    if (action === 'start' || action === 'jump') {
      if (state.phase === 'title' || state.phase === 'result') {
        begin(state, events);
        return;
      }
      if (state.phase === 'paused') {
        setPaused(state, events, false);
        return;
      }
      if (action === 'start' && state.phase === 'running') {
        setPaused(state, events, true);
        return;
      }
    }
    if (state.phase !== 'running') return;
    const run = internals.get(state);
    if (action === 'left') state.lane = max(-1, state.lane - 1);
    if (action === 'right') state.lane = min(1, state.lane + 1);
    if (action === 'jump' && state.jump === 0 && run.jumpVelocity === 0) {
      state.slide = 0;
      run.jumpVelocity = JUMP_SPEED;
      events.push('jump');
    }
    if (action === 'slide' && state.slide === 0) {
      run.jumpVelocity = state.jump > 0 ? -JUMP_SPEED * 2 : 0;
      state.slide = SLIDE_TIME;
      events.push('slide');
    }
  }

  function moveRunner(state, run) {
    const difference = state.lane - state.laneX;
    state.laneX += sign(difference) * min(abs(difference), LANE_SPEED * STEP);
    state.slide = max(0, state.slide - STEP);
    if (state.jump > 0 || run.jumpVelocity > 0) {
      state.jump = max(0, state.jump + run.jumpVelocity * STEP - GRAVITY * STEP * STEP / 2);
      run.jumpVelocity -= GRAVITY * STEP;
      if (state.jump === 0) run.jumpVelocity = 0;
    }
  }

  function contact(state, object, beforeZ) {
    const halfDepth = object.length / 2 + 0.65;
    return beforeZ + halfDepth >= 0 && object.z - halfDepth <= 0 &&
      abs(state.laneX - object.lane) < (object.type === 'coin' || object.type === 'scooter' ? 0.5 : 0.66);
  }

  function moveObjects(state, travel, events) {
    for (const object of state.objects) {
      const beforeZ = object.z;
      object.z -= travel;
      if (state.phase !== 'running' || !contact(state, object, beforeZ)) continue;
      if (object.type === 'coin' || object.type === 'scooter') {
        if (state.jump < 2.4) {
          object.z = -1000;
          if (object.type === 'coin') state.tokens += TOKEN_REWARD;
          else state.scooter = true;
          events.push(object.type);
        }
        continue;
      }
      const clears = object.type === 'barrier' && state.jump >= 1 ||
        object.type === 'gate' && state.slide > 0;
      if (!clears && state.phase === 'running') {
        if (state.scooter) {
          state.scooter = false;
          state.recovery = 1.2;
          events.push('shield');
        } else if (state.recovery === 0) {
          state.phase = 'captured';
          events.push('crash');
        }
      }
    }
    let retained = 0;
    for (const object of state.objects) if (object.z + object.length / 2 > -26) state.objects[retained++] = object;
    state.objects.length = retained;
  }

  function step(state, run, events) {
    if (state.phase === 'captured') {
      state.captureTime = ++run.captureTicks * STEP;
      const progress = min(1, state.captureTime / .8);
      followRoute(state, run, progress * progress * (3 - 2 * progress));
      if (run.captureTicks >= 96) state.phase = 'result';
      return;
    }
    remember(state, run);
    const previousSpeed = state.speed;
    const previousBoost = state.boost;
    state.recovery = max(0, state.recovery - STEP);
    const boostTarget = state.scooter ? 2 : 1;
    state.boost += sign(boostTarget - state.boost) * min(abs(boostTarget - state.boost), STEP * 2);
    state.time = ++run.tick * STEP;
    state.speed = START_SPEED + min(state.time, RAMP_SECONDS) * ACCELERATION + max(0, state.time - RAMP_SECONDS) * LATE_ACCELERATION;
    const travel = (previousSpeed * previousBoost + state.speed * state.boost) * STEP / 2;
    state.distance += travel;
    moveRunner(state, run);
    moveObjects(state, travel, events);
    recordRoute(state, run);
    state.score = floor(state.distance) + state.tokens / TOKEN_REWARD * 25;
    const region = regionAt(state.distance);
    if (region !== state.region) {
      state.region = region;
      events.push('region');
    }
    fillRoad(state, run);
  }

  function advance(state, elapsedSeconds, commands = []) {
    const events = [];
    for (const action of commands) command(state, action, events);
    const run = internals.get(state);
    if (state.phase !== 'running' && state.phase !== 'captured') return events;
    run.accumulator += Number.isFinite(elapsedSeconds) ? max(0, min(0.25, elapsedSeconds)) : 0;
    while (run.accumulator + 1e-10 >= STEP) {
      run.accumulator -= STEP;
      step(state, run, events);
      if (state.phase === 'result') {
        run.accumulator = 0;
        break;
      }
    }
    return events;
  }

  return { create, advance, sample };
})();

function createPresentation(ctx) {
  const {max, PI, cos, sin, min, abs, floor} = Math;
  const W = 800;

  const H = 600;

  const INK = '#17243c';

  const CREAM = '#fff4d9';

  function nativePath(g, path, color) {
    g.fillStyle = color;
    g.fill(new Path2D(path));
  }

  const WHITE = '#fff';

  const ORANGE = '#fb842d';

  const THEMES = [
    {name: 'SANTIAGO', sky: ['#749bb3', '#f3c394'], ground: '#5c5b56', shoulder: '#a19a88', ridge: '#7d879a', leaves: '#526d44', kind: 'city'},
    {name: 'ARAUCANÍA', sky: ['#668b9d', '#cad8cf'], ground: '#414e4c', shoulder: '#58674c', ridge: '#587c83', leaves: '#285543', facades: ['#9e6a45', '#c7a778', '#647f72'], kind: 'forest'},
    {name: 'LOS LAGOS', sky: ['#5d8fa6', '#d4ddd2'], ground: '#465653', shoulder: '#7d8c69', ridge: '#597f8a', leaves: '#326447', facades: ['#c2874d', '#478d98', '#a9523e'], kind: 'lake'},
    {name:'ATACAMA',ground:'#8e7059',kind:'desert'},
    {name:'PUNTA ARENAS',ground:'#829b9e',kind:'polar'}
  ];

  const TRAIN_COLORS = ['#c62d33','#dedbc9','#c9d1cf'];

  const DESTINATIONS = ['PLAZA MAIPÚ','SAN PABLO','LOS LEONES'];



  const scenery = [];

  const cached = [];

  let clock = 0;

  let attractDistance = 28;

  let disposed = false;

  function canvas(width, height, paint) {
    const image = document.createElement('canvas');
    image.width = width;
    image.height = height;
    paint(image.getContext('2d'), width, height);
    cached.push(image);
    return image;
  }

  function rect(g, x, y, width, height, color) {
    g.fillStyle = color;
    g.fillRect(x, y, width, height);
  }

  function round(g, x, y, w, h, r, color) {
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(x, y, w, h, r);
    g.fill();
  }

  function trace(g, points) {
    g.beginPath();
    g.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) g.lineTo(points[i][0], points[i][1]);
  }

  function poly(g, points, color, stroke) {
    g.fillStyle = color;
    trace(g, points);
    g.closePath();
    g.fill();
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  }

  function ellipse(g, x, y, rx, ry, color) {
    g.fillStyle = color;
    g.beginPath();
    g.ellipse(x, y, max(0.1, rx), max(0.1, ry), 0, 0, PI * 2);
    g.fill();
  }

  function text(g, value, x, y, size, color, weight = 800, align = 'center') {
    g.font = `${weight} ${size}px Arial, sans-serif`;
    g.textAlign = align;
    g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(value, x, y);
  }

  function line(g, x1, y1, x2, y2, width, color) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
  }

  function star(g, x, y, outer, inner, points, color) {
    const vertices = [];
    for (let i = 0; i < points * 2; i++) {
      const a = i * PI / points - PI / 2;
      const r = i % 2 ? inner : outer;
      vertices.push([x + cos(a) * r, y + sin(a) * r]);
    }
    poly(g, vertices, color);
  }

  function depthOpacity(z) {
  const t = max(0, min(1, (260 - z) / 40));
  return t * t * (3 - 2 * t);
}

  function project(x, z, height = 0) {
    const scale = 900 / max(4, z + 32);
    return {x: 400 + x * 4 * scale, y: 154 + (10 - height) * scale, scale};
  }

  function billboard(image, x, z, width, height, lift = 0) {
    const p = project(x, z, lift), w = width * p.scale, h = height * p.scale;
    const opacity = min(1, max(.25, 1.2 - z / 370));
    ctx.save(); ctx.globalAlpha *= opacity * depthOpacity(z);
    ellipse(ctx, p.x + w * .15, p.y + 1, w * .4, max(1, p.scale * .16), 'rgba(16,32,31,.20)');
    ctx.drawImage(image, p.x - w / 2, p.y - h, w, h);
    ctx.restore();
  }

  function worldRandom(seed) {
    let value = seed >>> 0 || 1;
    return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
  }

  function worldGrain(g, x, y, w, h, seed, count, colors) {
    const random = worldRandom(seed);
    for (let i = 0; i < count; i++) {
      rect(g, x + random() * w, y + random() * h, .5 + random() * 2, .5 + random() * 1.4, colors[i % colors.length]);
    }
  }

  function worldWindow(g, x, y, timber, seed) {
    round(g, x - 4, y - 5, 32, 47, 2, timber ? '#d4c49e' : '#e4d0ae');
    round(g, x - 1, y - 1, 26, 39, 1, '#253c45');
    const glass = actorShade(g, x, y, 25, 36, ['#375c6c', '#6f969b', '#203d4c']);
    rect(g, x + 1, y + 1, 22, 34, glass);
    poly(g, [[x + 2, y + 1], [x + 14, y + 1], [x + 4, y + 34], [x + 2, y + 34]], 'rgba(225,239,229,.22)');
    rect(g, x - 2, y - 1, 28, 5, '#344c4e');
    line(g, x + 12, y + 1, x + 12, y + 36, 2, '#c5c5ae');
    line(g, x + 1, y + 17, x + 23, y + 17, 2, '#b8bda8');
    line(g, x - 5, y + 41, x + 29, y + 41, 4, '#7f7666');
    line(g, x - 5, y + 39, x + 29, y + 39, 2, '#f0d7ad');
    if (seed % 3 === 1) { rect(g, x + 14, y + 20, 7, 13, 'rgba(229,183,112,.55)'); }
  }

  const worldBallast = canvas(384, 384, g => {
    rect(g, 0, 0, 384, 384, '#565b59');
    const random = worldRandom(28191);
    for (let i = 0; i < 13500; i++) {
      const x = random() * 384, y = random() * 384, r = .5 + random() * 1.5;
      g.fillStyle = ['#424a48', '#717772', '#898c82', '#4e5856', '#a09d8f'][i % 5];
      g.beginPath(); g.ellipse(x, y, r, r * .7, random() * 3, 0, PI * 2); g.fill();
      if (i % 4 === 0) { rect(g, x - r * .5, y - r * .4, r, .6, 'rgba(235,224,197,.35)'); }
    }
  });

  function mountain(g, color, top, snow) {
    const ridge = [[-40, 275], [26, top + 79], [81, top + 49], [123, top + 68], [174, top + 24], [222, top + 57], [271, top + 29], [310, top + 4], [356, top + 44], [401, top + 69], [450, top + 26], [520, top + 63], [565, top + 24], [602, top], [642, top + 43], [701, top + 72], [755, top + 30], [840, 275]];
    poly(g, ridge, color);
    poly(g, [[174, top + 24], [134, 245], [218, 245], [222, top + 57]], 'rgba(25,46,65,.075)');
    poly(g, [[310, top + 4], [279, 138 + top * .35], [220, 268], [356, 251], [356, top + 44]], 'rgba(235,210,178,.10)');
    poly(g, [[602, top], [577, top + 81], [522, 269], [675, 268], [642, top + 43]], 'rgba(18,49,67,.10)');
    if (snow) {
      poly(g, [[269, top + 41], [310, top + 4], [356, top + 44], [333, top + 37], [320, top + 45], [309, top + 32], [296, top + 40], [292, top + 31]], '#eadfcd');
      poly(g, [[565, top + 35], [602, top], [650, top + 48], [618, top + 29], [602, top + 36], [588, top + 25]], '#f0e4d2');
      line(g, 310, top + 6, 321, top + 34, 2, 'rgba(151,165,177,.6)');
    }
  }

  function makeBackground(theme, chiloe) {
    return canvas(W, H, g => {
      const sky = actorShade(g, 0, 0, 0, 315, [theme.sky[0], theme.sky[1], '#e2ddd0'], [0, .65, 1]);
      rect(g, 0, 0, W, H, sky);
      const sun = g.createRadialGradient(648, 70, 8, 648, 70, 190);
      sun.addColorStop(0, 'rgba(255,237,187,.65)'); sun.addColorStop(.35, 'rgba(255,220,165,.24)'); sun.addColorStop(1, 'rgba(255,220,165,0)');
      rect(g, 400, 0, 400, 300, sun);
      ellipse(g, 648, 70, theme.kind === 'city' ? 22 : 13, theme.kind === 'city' ? 22 : 13, '#fff0ce');
      const random = worldRandom(chiloe ? 489 : theme.kind === 'city' ? 132 : 208);
      for (let i = 0; i < 29; i++) {
        const x = random() * 950 - 70, y = 22 + random() * 92;
        ellipse(g, x, y, 30 + random() * 90, 3 + random() * 8, i % 3 ? 'rgba(238,242,225,.15)' : 'rgba(247,238,214,.34)');
      }
      mountain(g, '#a9b7bd', 89, false);
      mountain(g, theme.ridge, theme.kind === 'city' ? 102 : 129, theme.kind === 'city');
      if (theme.kind !== 'city' && !chiloe) {
        const volcano = actorShade(g, 340, 90, 300, 150, ['#718e96', '#87a1a4', '#52757f', '#426875'], [0, .48, .49, 1]);
        nativePath(g, 'M307 249 478 64 670 249Z', volcano);
        nativePath(g, 'M423 121 478 64 537 123 513 113 504 124 485 109 469 121 449 108Z', '#e7e6d9');
        nativePath(g, 'M478 64 485 110 504 124 513 113 537 123Z', '#c5d1cf');
        for (let i = 0; i < 6; i++) line(g, 479 + i * 3, 122 + i * 4, 466 + i * 19, 210 + i * 4, 1, 'rgba(36,69,78,.14)');
      }
      if (theme.kind === 'city') {
        for (let i = 0; i < 27; i++) {
          const x = i * 32 - 17, h = 20 + (i * 37) % 61;
          const facade = actorShade(g, x, 0, 29, 0, ['#9b9e9b', '#a9aaa3', '#858f91', '#839195'], [0, .65, .66, 1]);
          rect(g, x, 239 - h, 27, h, facade);
          g.fillStyle = '#c3c1ae';
          for (let yy = 244 - h; yy < 235; yy += 8) for (let xx = x + 3; xx < x + 22; xx += 7) g.fillRect(xx, yy, 4, 3);
        }
        nativePath(g, 'M561 235 570 83 588 77 600 235Z', '#5c8293');
        nativePath(g, 'M570 83 578 80 582 235 565 235Z', '#9ab2b4');
        for (let i = 0; i < 27; i++) line(g, 569, 94 + i * 5, 591 + i * .16, 94 + i * 5, .6, 'rgba(215,227,219,.45)');
        line(g, 578, 82, 581, 233, 2, '#cfdbcf');
      } else {
        for (let layer = 0; layer < 3; layer++) {
          g.fillStyle = ['#698d81', '#527965', '#3e6252'][layer];
          for (let i = 0; i < 25; i++) ellipse(g, i * 36 - 25, 244 - layer * 8 - random() * 13, 27 + random() * 20, 24 + random() * 17, g.fillStyle);
        }
      }
      const land = actorShade(g, 0, 244, 0, (H)-(244), [theme.shoulder, theme.kind === 'city' ? '#837f70' : '#394e3e']);
      rect(g, 0, 244, W, 356, land);
      worldGrain(g, 0, 248, W, 352, 946, 2500, ['rgba(15,33,35,.07)', 'rgba(245,224,181,.10)']);
      if (theme.kind === 'lake') {
        const water = actorShade(g, 0, 225, 0, (H)-(225), ['#88afb0', '#4b8a96', '#24677a'], [0, .35, 1]);
        rect(g, 0, 241, W, 359, water);
        for (let i = 0; i < 130; i++) {
          const y = 245 + random() * 355, x = random() * W;
          line(g, x, y, x + 7 + random() * (y - 220) * .25, y, .5 + (y - 230) * .003, i % 4 ? 'rgba(205,226,212,.17)' : 'rgba(28,67,82,.22)');
        }
        if (!chiloe) {
          const shore = [project(-5.8, 280), project(5.8, 280), project(5.8, -12), project(-5.8, -12)];
          poly(g, shore.map(p => [p.x, p.y]), land);
          g.save(); g.clip();
          worldGrain(g, 0, 190, W, 410, 913, 2100, ['rgba(24,49,39,.09)', 'rgba(216,214,168,.12)']);
          g.restore();
          for (const side of [-1, 1]) {
            const a = project(side * 5.8, 280), b = project(side * 5.8, -12);
            line(g, a.x, a.y, b.x, b.y, 3, '#6a7a68');
            line(g, a.x + side * 3, a.y, b.x + side * 3, b.y, 1, 'rgba(208,225,205,.55)');
          }
        }
      }
      if (theme.kind === 'city') {
        const bank = [project(-5.8, 280), project(-5.8, -12)];
        poly(g, [[0, 239], [bank[0].x, bank[0].y], [bank[1].x, bank[1].y], [0, 600]], '#496e7b');
        g.save(); g.clip();
        for (let i = 0; i < 65; i++) {
          const y = 280 + i * 5;
          line(g, 0, y, 260 - i * 2.9, y - 18, .8, i % 3 ? 'rgba(189,210,202,.25)' : 'rgba(29,66,79,.32)');
        }
        g.restore();
        line(g, bank[0].x, bank[0].y, bank[1].x, bank[1].y, 8, '#7c817a');
        line(g, bank[0].x + 4, bank[0].y, bank[1].x + 4, bank[1].y, 2, '#c3b99b');
      }
      const haze = actorShade(g, 0, 169, 0, 121, [theme.kind === 'city' ? 'rgba(242,211,170,.36)' : 'rgba(194,214,207,.3)', 'rgba(218,222,208,0)']);
      rect(g, 0, 169, W, 130, haze);
    });
  }

  function makeBuilding(color, kind, index) {
    return canvas(220, 300, g => {
      nativePath(g, 'M20 92 166 70 202 99 202 280 20 280Z', '#483f36');
      const wall = actorShade(g, 20, 80, 157, 150, [color, color, '#72583f'], [0, .7, 1]);
      rect(g, 20, 88, 151, 192, wall);
      if (kind !== 'lake') { rect(g, 20, 279, 184, 21, '#747462'); }
      worldGrain(g, 22, 91, 147, 185, 311 + index * 9, 1200, ['rgba(34,35,30,.07)', 'rgba(255,236,199,.13)']);
      rect(g, 162, 88, 9, 191, 'rgba(23,38,40,.16)');
      for (let y = 96; y < 278; y += 10) {
        line(g, 22, y, 169, y, 1.2, 'rgba(35,36,29,.33)');
        line(g, 23, y + 1.5, 169, y + 1.5, .7, 'rgba(238,209,158,.2)');
      }
      nativePath(g, 'M6 100 94 23 183 100Z', '#8e4c3c');
      nativePath(g, 'M94 23 126 18 211 91 183 100Z', '#533d38');
      for (let row = 0; row < 6; row++) line(g, 20 + row * 11, 88 - row * 10, 169 - row * 11, 88 - row * 10, 1, '#ae6951');
      line(g, 7, 101, 182, 101, 5, '#d8b984');
      line(g, 8, 105, 180, 105, 3, 'rgba(27,34,32,.46)');
      line(g, 95, 24, 182, 98, 2, '#c18c64');
      for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) worldWindow(g, 36 + col * 46, 117 + row * 68, true, row + col + index);
      round(g, 75, 220, 35, 60, 2, '#293d40');
      round(g, 81, 225, 22, 32, 1, '#778b7f');
      nativePath(g, 'M82 227 94 227 82 250Z', 'rgba(240,218,174,.35)');
      line(g, 107, 227, 107, 275, 2, '#b6a17b');
      ellipse(g, 102, 263, 1.8, 1.8, '#e8c37f');
      line(g, 72, 280, 112, 280, 5, '#c3b599');
      if (index % 2 === 0) {
        nativePath(g, 'M24 215 162 215 169 222 31 222Z', '#344747');
        line(g, 28, 190, 165, 190, 2, '#364b49');
        for (let i = 0; i < 14; i++) line(g, 29 + i * 10, 191, 29 + i * 10, 215, 2, '#263c3e');
        for (let x = 35; x < 164; x += 42) {
          round(g, x, 212, 26, 8, 2, '#6e513a');
          for (let leaf = 0; leaf < 5; leaf++) ellipse(g, x + 3 + leaf * 5, 208 - leaf % 2 * 3, 5, 7, leaf % 2 ? '#698548' : '#3d6140');
          ellipse(g, x + 10, 206, 3, 3, '#d79771');
        }
      }
      if (kind === 'lake') for (let i = 0; i < 5; i++) {
        rect(g, 30 + i * 36, 280, 8, 20, '#4a4538');
        rect(g, 31 + i * 36, 280, 2, 20, '#a3936b');
      }
      line(g, 177, 105, 177, 279, 3, '#4f5550');
      line(g, 178, 106, 178, 276, 1, '#c5b58f');
    });
  }

  function makeTree(araucaria, color) {
    return canvas(220, 330, g => {
      const random = worldRandom(araucaria ? 874 : 321);
      const bark = actorShade(g, 100, 0, 19, 0, ['#655b46', '#9b8461', '#3f4b3d'], [0, .35, 1]);
      rect(g, 101, 67, 16, 260, bark);
      for (let i = 0; i < 65; i++) line(g, 102 + random() * 14, 70 + i * 4, 105 + random() * 12, 72 + i * 4, .7, 'rgba(26,42,32,.5)');
      if (araucaria) {
        for (let level = 5; level >= 0; level--) {
          const y = 36 + level * 39, spread = 81 - level * 5;
          line(g, 110, y + 26, 110 - spread, y + 4, 7, '#465440');
          line(g, 110, y + 26, 110 + spread, y + 4, 7, '#3d4c3c');
          for (let j = -4; j <= 4; j++) {
            const x = 110 + j * spread / 4, crownY = y + abs(j) * 1.5;
            ellipse(g, x, crownY + 5, 16, 10, '#244637');
            for (let needle = 0; needle < 6; needle++) {
              const a = needle / 5 * PI - PI;
              line(g, x, crownY + 4, x + cos(a) * 17, crownY + sin(a) * 16, 2.5, needle % 2 ? color : '#557658');
            }
          }
        }
      } else {
        for (let i = 0; i < 65; i++) {
          const a = random() * PI * 2, r = Math.sqrt(random()) * 74;
          const x = 110 + cos(a) * r, y = 90 + sin(a) * r * .76;
          ellipse(g, x, y, 13 + random() * 18, 17 + random() * 21, i % 3 ? color : '#607f4b');
          if (i % 3 === 0) ellipse(g, x - 5, y - 7, 9, 7, 'rgba(185,193,121,.22)');
        }
      }
    });
  }





  function paintClaude(g){
  const accent = '#c96442';
 rect(g, 0,0,160,240, '#f3eee3');
 rect(g, 0,0,160,13, accent);
 g.save();g.translate(80,70);g.fillStyle=accent;g.beginPath();for(let i=0;i<32;i++){let a=i*PI/16,r=i%2?13:34;g.lineTo(cos(a)*r,sin(a)*r)}g.closePath();g.fill();g.restore();
 g.fillStyle='#29251f';g.textAlign='center';g.font='bold 30px Georgia,serif';g.fillText('Keep',80,139);g.fillText('thinking.',80,177);
 rect(g, 20,194,120,1, accent);
 g.fillStyle='#29251f';g.font='bold 23px Georgia,serif';g.fillText('Claude',80,222);
}


function paintFintual(g){
  const blue = '#1847d7';
  rect(g, 0,0,160,240, '#f8f9f7');
  text(g, 'fintual', 80, 28, 24, blue);
  ['Invertir', 'es así de', 'simple.'].forEach((label, i) => text(g, label, 80, 65 + i * 26, 25, '#183baf'));
  g.fillStyle='#dbe7ff';g.beginPath();g.arc(80,171,37,0,7);g.fill();
  g.fillStyle='#315de6';g.beginPath();g.ellipse(80,183,30,9,0,0,7);g.fill();
  g.fillStyle=WHITE;g.beginPath();g.ellipse(80,180,30,9,0,0,7);g.fill();
  g.fillStyle='#315de6';g.beginPath();g.ellipse(80,176,30,9,0,0,7);g.fill();
  g.strokeStyle=blue;g.lineWidth=4;g.beginPath();g.moveTo(80,171);g.lineTo(80,143);g.moveTo(80,159);g.quadraticCurveTo(65,158,65,148);g.quadraticCurveTo(79,148,80,159);g.moveTo(80,153);g.quadraticCurveTo(91,140,98,145);g.quadraticCurveTo(96,155,80,159);g.stroke();
  text(g, 'FONDOS DE INVERSIÓN', 80, 225, 9, blue);
}


function paintPlatanus(g){
  const yellow = '#f9d600';
 rect(g, 0,0,160,240, '#101c39');
 rect(g, 0,0,160,9, yellow);
 text(g, 'platanus', 80, 39, 23, WHITE);
 text(g, 'ventures', 80, 57, 12, yellow, 700);
 rect(g, 16,75,128,2, yellow);
 text(g,'TU IDEA.',80,112,25,WHITE);
 text(g,'TU STARTUP.',80,143,21,WHITE);
 text(g,'CONSTRÚYELA',80,177,15,yellow);
 text(g,'EN GRANDE.',80,196,15,yellow);
 text(g, 'platan.us', 80, 226, 12, WHITE, 700);
}


function paintRobot(g) {
 rect(g, 0,0,160,240, '#f78a35');
 text(g,'FOUNDERS',80,38,23,INK);text(g,'WANTED',80,72,28,INK);
 round(g,38,119,84,65,8,INK);round(g,51,138,58,26,4,'#f78a35');
 for(const x of [65,95])round(g,x,145,7,12,2,INK);
 line(g,80,119,80,103,4,INK);ellipse(g,80,99,5,5,INK);
 text(g,'BUILD IN CHILE',80,220,13,INK);
}

const posters = [paintClaude,paintFintual,paintPlatanus,paintRobot].map(paint => canvas(320,480,g => { g.scale(2,2); paint(g); }));

function paintBiome(g, polar) {
  const sky = actorShade(g, 0, 0, 0, 300, [polar ? '#759db3' : '#829ba3', polar ? '#e2e8df' : '#f5d9a5']);
  rect(g, 0, 0, 800, 600, sky);
  ellipse(g, 650, 72, polar ? 19 : 30, polar ? 19 : 30, '#fff0cb');
  if (polar) for (let i = 0; i < 7; i++) ellipse(g, i * 143, 50 + i % 3 * 22, 73, 10, '#dae3de');
  for (let j = 0; j < 2; j++) {
    const a = [[0, 252]];
    for (let i = 0; i < 11; i++) a.push([i * 80, 206 + j * 24 - abs(sin(i * 2.3 + j)) * (polar ? 105 : 62)]);
    a.push([800, 260]);
    poly(g, a, polar ? ['#91aab2', '#668694'][j] : ['#bd987f', '#a5775c'][j]);
    if (polar) for (let i = 1; i < 10; i++) {
      const x = i * 80, y = a[i + 1][1];
      if (y < a[i][1] && y < a[i + 2][1]) poly(g, [[x - 24, y + 32], [x, y], [x + 25, y + 24], [x, y + 19]], '#e8e9dd');
    }
  }
  rect(g, 0, 244, 800, 356, polar ? '#598a9b' : '#c9a172');
  nativePath(g, 'M0 310 150 268 310 310 270 600 0 600Z', polar ? '#d3ddd5' : '#d9b47f');
  nativePath(g, 'M500 270 670 256 800 280 800 600 540 600 595 350Z', polar ? '#e4e9df' : '#b88a5e');
  if (!polar) ellipse(g, 403, 263, 225, 13, '#e9d8b5');
  for (let i = 0; i < 35; i++) {
    const x = i * 137 % 800, y = 274 + i * 53 % 326;
    line(g, x, y, x + 12 + i % 7 * 6, y + (polar ? 0 : 3), 1, polar ? '#90b1b7' : '#e2c294');
  }
}

function paintNature(g, kind, frame = 0) {
  const d = [0, 7, 0, -7][frame % 4], ink = '#28373a';
  g.save(); g.lineCap = 'round'; g.translate(0, kind === 2 ? 14 : kind ? 18 : 0);
  if (!kind) {
    for (const [x, y, X, Y] of [[98, 223, 98, 45], [62, 112, 62, 150], [62, 150, 98, 150], [141, 82, 141, 129], [141, 129, 98, 129]]) {
      line(g, x, y, X, Y, 29, '#38594b');
      line(g, x - 3, y, X - 3, Y, 19, '#73916a');
    }
    for (let i = 0; i < 8; i++) line(g, 89, 66 + i * 20, 101, 62 + i * 20, 2, '#c5c29a');
  } else if (kind === 2) {
    for (const s of [-1, 1]) {
      poly(g, [[100 + s * 30, 119], [100 + s * 55, 160 + d * s], [100 + s * 33, 156]], ink);
      ellipse(g, 100 + s * 21, 216 + d * s / 4, 18, 6, '#b98d67');
    }
    ellipse(g, 100, 151, 41, 62, ink);
    ellipse(g, 101, 155, 29, 48, '#f1ebd7');
    ellipse(g, 100, 88, 30, 29, ink);
    ellipse(g, 103, 93, 22, 22, '#f1ebd7');
    ellipse(g, 104, 84, 22, 21, ink);
    nativePath(g, 'M76 125 99 138 123 124 125 137 99 152 75 138Z', ink);
    nativePath(g, 'M124 88 145 96 123 101Z', '#bda17a');
    ellipse(g, 113, 86, 3, 3, WHITE);
  } else {
    const c = kind === 1 ? '#d2b184' : '#ad7952', cream = '#eae0c8';
    for (let i = 0; i < 4; i++) {
      const x = [65, 80, 120, 133][i], z = i % 2 ? d : -d;
      line(g, x, 153, x + z, 216, 7, i % 2 ? c : '#806e58');
      line(g, x + z - 2, 218, x + z + 6, 218, 4, ink);
    }
    line(g, 57, 141, 44, 128, 8, c);
    ellipse(g, 98, 141, 43, 26, c);
    ellipse(g, 98, 153, 32, 13, cream);
    line(g, 128, 141, 146, 62, kind === 1 ? 18 : 22, c);
    line(g, 135, 132, 153, 69, 7, cream);
    line(g, 141, 49, 138, 27, 7, c);
    line(g, 154, 47, 159, 27, 7, c);
    ellipse(g, 151, 57, 20, 13, c);
    ellipse(g, 164, 61, 10, 7, cream);
    ellipse(g, 151, 54, 3, 3, ink);
    ellipse(g, 172, 60, 3, 4, ink);
  }
  g.restore();
}


  const backgrounds = THEMES.map((t,i) => i<3 ? makeBackground(t, false) : canvas(W,H,g=>paintBiome(g,i===4)));

  const chiloeBackground = makeBackground(THEMES[2], true);

  const buildings = THEMES.slice(0,3).map((t, region) => region ? t.facades.map((c, i) => makeBuilding(c, t.kind, i)) : []);

  const trees = THEMES.slice(0,3).map(t => makeTree(t.kind === 'forest', t.leaves));

  const nature = Array.from({length:4},(_,kind)=>Array.from({length:kind?4:1},(_,frame)=>canvas(200,240,g=>paintNature(g,kind,frame))));

  function santiagoBuilding(type) {
    return canvas(220, 300, g => {
      const colors = ['#d7ac7b','#cc9a73','#dcc29b','#be9a89','#c7b7a3','#a56850','#d5ae80','#b4a78b','#cbb69a','#c8c4b0','#8b9993','#bdad8c'];
      const top = [116,112,87,75,76,105,148,137,30,55,91,101][type];
      const left = type === 8 || type === 9 ? 13 : 20, right = type >= 10 ? 202 : 190;
      const wall = colors[type];
      poly(g, [[left,top],[right-20,top],[right,top+13],[right,280],[left,280]], '#716c5d');
      rect(g, left, top, right-left-20, 280-top, wall);
      rect(g, left, 280, right-left, 20, '#77776a');
      worldGrain(g,left+2,top+3,right-left-24,274-top,613+type,450,['rgba(45,38,31,.09)','rgba(255,235,196,.13)']);
      const roof = (points, color) => poly(g, points, color);
      const window = (x,y,w,h,arched=false) => {
        if (arched) { round(g,x,y,w,h,[min(w/2,12),min(w/2,12),0,0],'#d9c7a5'); round(g,x+3,y+3,w-6,h-5,[min(w/2,9),min(w/2,9),0,0],'#38545a'); }
        else { rect(g, x-3,y-3,w+6,h+6, '#e3d0ae'); rect(g, x,y,w,h, '#38545a'); }
        line(g,x+w/2,y+2,x+w/2,y+h,2,'#bcb7a2'); line(g,x,y+h*.55,x+w,y+h*.55,2,'#bcb7a2');
      };
      const door = (x,w=30) => { round(g,x,223,w,57,3,'#35494a'); line(g,x+w/2,226,x+w/2,278,2,'#a48d6e'); };
      const cornice = y => { rect(g, left-3,y,right-left-14,7, '#e6d2ad'); line(g,left-3,y+8,right-17,y+8,2,'#786b59'); };
      const railing = (x,y,w) => {
        const color = '#34494a';
        line(g,x,y,x+w,y,3,color); line(g,x,y+20,x+w,y+20,4,color);
        for(let k=0;k<=w;k+=9) line(g,x+k,y,x+k,y+20,2,color);
      };
      if (type === 0 || type === 6 || type === 7) roof([[left-8,top],[96,top-25],[right-16,top],[right-10,top+6],[left-8,top+6]],'#994f3d');
      else if (type === 4) { roof([[left,top],[40,top-34],[151,top-34],[right-20,top]],'#58666a'); for(let x=48;x<150;x+=40) { roof([[x-5,top-13],[x+8,top-27],[x+21,top-13]],'#7e7770'); window(x,top-18,15,17); } }
      else if (type === 10) { roof([[left,top],[52,top-34],[155,top-34],[right,top]],'#465d5c'); for(let x=48;x<160;x+=22) line(g,x,top-32,x+8,top,3,'#b4c4b6'); }
      else if (type === 11) { roof([[left,top],[44,top-20],[166,top-20],[right,top]],'#6a7770'); rect(g, 69,top-41,68,19, '#a1b5a8'); roof([[62,top-41],[103,top-54],[144,top-41]],'#485c58'); for(let x=75;x<136;x+=14) line(g,x,top-40,x,top-22,2,'#435b5a'); }
      else cornice(top-7);
      if(type === 3) { rect(g, 133,top-12,38,145, '#a57d71'); roof([[127,top-12],[152,top-47],[177,top-12]],'#536368'); window(141,top+10,20,40,true); }
      if(type === 8) { roof([[135,top],[175,top+12],[175,280],[135,280]],'#aa9980'); for(let y=top+22;y<200;y+=38) { window(28,y,25,25); window(78,y,25,25); window(140,y,21,25); } }
      else if(type === 9) { for(let y=top+24;y<210;y+=38) { round(g,23,y,145,19,8,'#425e60'); for(let x=35;x<160;x+=25) line(g,x,y,x,y+19,2,'#c4c8b9'); } }
      else if(type === 10) { for(let x=28;x<175;x+=36) window(x,top+13,27,107,true); }
      else if(type === 11) { for(let x=25;x<175;x+=32) window(x,top+42,27,105,true); }
      else if(type === 1) { for(let x=28;x<170;x+=36) window(x,top+24,23,42,true); round(g,69,180,54,100,[25,25,0,0],'#e7caa3'); round(g,76,187,40,93,[20,20,0,0],'#364a48'); line(g,96,191,96,278,2,'#ac9b7b'); }
      else { const floors = type === 6 || type === 7 ? 1 : 2; for(let row=0;row<floors;row++) for(let col=0;col<3;col++) window(35+col*47,min(185,top+25+row*59),25,35,type===0 || type===3 || type===4); }
      if(type === 0) { cornice(top+7); railing(28,top+65,134); }
      if(type === 6) { rect(g, 22,top+9,146,6, '#eee0ba'); }
      if(type === 5) for(let y=top+5;y<278;y+=11) { line(g,left,y,170,y,1,'rgba(240,199,164,.35)'); for(let x=left+(y%22?10:0);x<170;x+=25) line(g,x,y,x,y+10,1,'rgba(83,53,45,.25)'); }
      if(type !== 1 && type < 10) door(type===7?128:82,type===7?38:30);
      if(type===2) { railing(24,top+75,145); rect(g, 23,210,150,10, '#a34f3f'); for(let x=23;x<170;x+=24) { rect(g, x,210,12,10, '#e2cba5'); } window(29,228,40,48); window(125,228,39,48); }
      if(type===7) { rect(g, 26,213,91,67, '#4e6663'); for(let x=34;x<113;x+=20) line(g,x,216,x,277,2,'#b4b7a2'); line(g,24,212,119,212,5,'#d8c6a6'); }
      if(type===10 || type===11) { for(let x=25;x<180;x+=35) { line(g,x,top+8,x,279,4,'#c9c5a8'); } line(g,20,top+125,190,top+125,4,'#52655e'); }
      line(g,right-20,top+8,right-20,278,2,'rgba(48,57,51,.5)');
    });
  }

  const santiagoBuildings = Array.from({length: 12}, (_, i) => santiagoBuilding(i));

  function neighborhoodProp(forest) {
    return canvas(180, 240, g => {
      if (forest) {
        for (let i = 0; i < 5; i++) ellipse(g, 25 + i * 31, 222 - i % 2 * 8, 20, 12 + i % 3 * 3, i % 2 ? '#5b6c60' : '#7b8770');
        for (let side = -1; side <= 1; side += 2) for (let leaf = 0; leaf < 6; leaf++) {
          const x = 90 + side * (leaf * 8 + 6), y = 209 - sin(leaf / 5 * PI) * 40;
          line(g, 90, 231, x, y, 2, '#8e9d64');
          line(g, x - side * 5, y - 6, x + side * 9, y + 2, 4, '#416b49');
        }
        line(g, 15, 205, 168, 205, 7, '#84694d');
        for (const x of [26, 144]) line(g, x, 188, x, 237, 8, '#584e3c');
      } else {
        line(g, 108, 7, 108, 238, 10, '#6e6250');
        line(g, 81, 32, 139, 32, 7, '#5a5951');
        for (const x of [86, 130]) { round(g, x, 19, 7, 17, 2, '#9fa99d'); }
        g.strokeStyle = '#485358'; g.lineWidth = 1.3;
        for (const y of [24, 35]) { g.beginPath(); g.moveTo(0, y + 15); g.quadraticCurveTo(55, y + 28, 108, y); g.quadraticCurveTo(145, y + 19, 180, y + 7); g.stroke(); }
        round(g, 17, 178, 63, 60, 2, '#8b9d85'); round(g, 24, 188, 48, 34, 1, '#304e54');
        nativePath(g, 'M12 180 39 164 82 177 84 184 12 184Z', '#be754a');
        line(g, 18, 227, 79, 227, 5, '#c9b77f');
      }
    });
  }

  const neighborhoodProps = [neighborhoodProp(false), neighborhoodProp(true)];

  function actorShade(g, x, y, width, height, colors, stops) {
    const gradient = g.createLinearGradient(x, y, x + width, y + height);
    colors.forEach((color, i) => gradient.addColorStop(stops ? stops[i] : i / (colors.length - 1), color));
    return gradient;
  }

  function actorLimb(g, points, width, colors) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    trace(g, points);
    g.strokeStyle = colors[0]; g.lineWidth = width + 3; g.stroke();
    g.strokeStyle = actorShade(g, points[0][0] - width / 2, 0, width, 0, colors); g.lineWidth = width; g.stroke();
    g.strokeStyle = 'rgba(255,240,210,.13)'; g.lineWidth = max(1, width * .12);
    trace(g, points.map(p => [p[0] - width * .23, p[1]]));
    g.stroke();
  }

  function actorShoe(g, x, y, width, tilt, light) {
    g.save(); g.translate(x, y); g.rotate(tilt);
    ellipse(g, 0, 4, width * .56, 10, '#142330');
    round(g, -width / 2, -8, width, 17, 7, actorShade(g, -width / 2, -6, width, 11, light ? ['#fff5dc', '#c9d1ca', '#7d9197'] : ['#627c8e', '#22384a', '#101d2a']));
    round(g, -width / 2 + 2, 5, width - 4, 5, 2, light ? '#f3efe1' : '#8e9d9b');
    line(g, -width * .3, -4, width * .22, -4, 1.5, light ? '#81979e' : '#819299');
    line(g, -width * .3, 0, width * .25, 0, 1.5, light ? '#9da8a6' : '#3c596b');
    g.restore();
  }

  function banana(g,x,y,size) {
    g.save();g.translate(x,y);g.scale(size,size);g.rotate(-.35);
    g.beginPath();g.moveTo(-16,-10);g.bezierCurveTo(-18,13,8,23,21,-5);g.bezierCurveTo(9,9,-8,7,-16,-10);
    g.fillStyle='#ffd936';g.fill();g.strokeStyle='#b47c20';g.lineWidth=1.5;g.stroke();
    g.beginPath();g.moveTo(-13,-4);g.quadraticCurveTo(-2,17,17,0);g.strokeStyle='#fff08b';g.lineWidth=2.5;g.stroke();
    line(g,-16,-10,-17,-14,3,'#705535');line(g,20,-5,23,-7,3,'#705535');g.restore();
  }

  const ACTOR_FRAMES = 24;

  function actorPaintRunner(g, frame, sliding, riding = false) {
    const phase = frame / ACTOR_FRAMES * PI * 2;
    const stride = riding ? 0 : sin(phase);
    const air = frame < 0;
    if (sliding) {
      actorLimb(g, [[112, 91], [145, 115], [155, 138]], 20, ['#142f48', '#456984', '#233e58']);
      actorShoe(g, 154, 138, 27, -.12, true);
      actorLimb(g, [[109, 92], [81, 123], [42, 136]], 23, ['#17334c', '#4d738a', '#243e58']);
      actorShoe(g, 39, 137, 33, -.1, true);
      g.save(); g.translate(103, 81); g.rotate(-.32);
      round(g, -34, -39, 69, 67, 22, actorShade(g, -35, -30, 70, 60, ['#fff3d5', '#c9bc9b', '#827e73']));
      round(g, -24, -31, 49, 43, 10, actorShade(g, -24, -31, 49, 43, ['#589c9c', '#21616d', '#163e51']));
      round(g, -19, -25, 39, 28, 6, '#397d83'); banana(g,0,-13,.8);
      g.restore();
      actorLimb(g, [[80, 65], [52, 89], [40, 113]], 18, ['#837f72', '#e5d8b8', '#b3aa90']);
      ellipse(g, 38, 115, 9, 10, '#cfac88');
      ellipse(g, 77, 43, 29, 30, actorShade(g, 51, 18, 53, 44, [CREAM, '#e7d6ad', '#9f9c8b']));
      round(g, 50, 15, 55, 17, 8, '#bc4f34');
      round(g, 52, 12, 50, 15, 8, actorShade(g, 52, 12, 50, 13, ['#f4a36a', '#df7247', '#9f3c2d']));
      return;
    }
    const legs = [-1, 1].map(side => {
      const swing = stride * side;
      const lift = air ? 23 : max(0, swing) * 25;
      return {side, swing, hip: [90 + side * 14, 153], knee: [90 + side * 18 + swing * 5, 186 - lift * .46], foot: [90 + side * 18 - swing * 9, 225 - lift]};
    });
    legs.sort((a, b) => a.foot[1] - b.foot[1]);
    for (const leg of legs) {
      actorLimb(g, [leg.hip, leg.knee, leg.foot], 23, ['#162f46', '#4d6a80', '#253f57']);
      line(g, leg.knee[0] - 6, leg.knee[1] - 3, leg.knee[0] + 6, leg.knee[1] + 1, 1, '#71909b');
      actorShoe(g, leg.foot[0], leg.foot[1], 31, leg.swing * .12, true);
    }
    for (const side of [-1, 1]) {
      const swing = stride * side;
      const handY = riding ? 129 : 146 - swing * 17;
      actorLimb(g, [[90 + side * 31, 93], [90 + side * (43 + swing * 4), 119 - swing * 7], [90 + side * (35 - swing * 7), handY]], 19, ['#827d70', '#f3e7c9', '#b6ad94']);
      ellipse(g, 90 + side * (35 - swing * 7), handY + 1, 9, 10, actorShade(g, 80, 130, 20, 20, ['#f4cd9e', '#bd9477']));
    }
    g.save(); g.translate(stride * 1.8, abs(stride) * -1.5);
    g.beginPath(); g.moveTo(65, 81); g.bezierCurveTo(40, 91, 46, 125, 56, 143); g.bezierCurveTo(75, 151, 110, 151, 126, 142); g.bezierCurveTo(137, 117, 137, 91, 115, 81); g.closePath();
    g.fillStyle = actorShade(g, 46, 81, 90, 60, ['#fff5d7', '#e4d8b7', '#a59e8a']); g.fill();
    line(g, 60, 136, 122, 136, 2, '#a2947c');
    line(g, 55, 112, 62, 130, 2, '#c1b69a'); line(g, 125, 111, 120, 132, 2, '#898e83');
    ellipse(g, 90, 82, 28, 18, '#b7af98');
    line(g, 65, 83, 61, 132, 7, '#203e4d'); line(g, 116, 83, 122, 132, 7, '#183746');
    round(g, 63, 86, 55, 54, 13, actorShade(g, 63, 86, 55, 50, ['#6bada4', '#327b80', '#143e52']));
    round(g, 68, 104, 45, 29, 7, actorShade(g, 68, 103, 45, 24, ['#62a398', '#2d6e76', '#205264']));
    line(g, 71, 110, 108, 110, 1.5, '#aac5ac');
    line(g, 111, 109, 111, 118, 2, '#dbbc74');
    banana(g,91,117,.9);
    for (let i = 0; i < 7; i++) line(g, 68 + i * 7, 94, 71 + i * 7, 94, .7, '#a3c2ac');
    ellipse(g, 90, 57, 29, 32, actorShade(g, 62, 31, 59, 48, ['#fff6dd', '#ecdfbd', '#aca991']));
    g.beginPath(); g.ellipse(90, 56, 23, 29, 0, .2, 2.7); g.strokeStyle = '#c9bda0'; g.lineWidth = 2; g.stroke();
    round(g, 61, 27, 58, 18, 9, '#a74331');
    round(g, 64, 22, 52, 18, 9, actorShade(g, 64, 22, 52, 16, ['#f4ad73', '#df7348', '#a24432']));
    line(g, 77, 25, 78, 35, 1, '#f3b783'); line(g, 102, 25, 104, 35, 1, '#b84f34');
    nativePath(g, 'M64 40 117 40 127 47 78 49Z', '#9e4433');
    line(g, 79, 47, 122, 46, 1, '#d98b5d');
    g.restore();
  }

  function actorPaintGuard(g, frame, human = false) {
    const stride = sin(frame / ACTOR_FRAMES * PI * 2);
    const legs = [-1, 1].map(side => ({side, swing: stride * side}));
    legs.sort((a, b) => b.swing - a.swing);
    for (const leg of legs) {
      const lift = max(0, leg.swing) * 22;
      const foot = [115 + leg.side * 25 - leg.swing * 7, 262 - lift];
      actorLimb(g, [[115 + leg.side * 21, 179], [115 + leg.side * 29 + leg.swing * 5, 222 - lift * .45], foot], 33, human ? ['#182329', '#454d4b', '#293236'] : ['#0d2035', '#304e6b', '#192f47']);
      actorShoe(g, foot[0], foot[1], 42, leg.swing * .11, false);
    }
    for (const side of [-1, 1]) {
      const swing = stride * side;
      const hand = [115 + side * (76 - swing * 4), human && side === 1 ? 140 - swing * 7 : 174 - swing * 15];
      actorLimb(g, [[115 + side * 58, 103], [115 + side * (76 + swing * 3), 141 - swing * 5], hand], 32, human ? ['#202c30', '#515955', '#303b3c'] : ['#10263e', '#3b5875', '#1d344f']);
      ellipse(g, hand[0], hand[1] + 2, 14, 16, actorShade(g, hand[0] - 14, hand[1] - 12, 28, 27, human ? ['#d5b291', '#b08a6c', '#765d50'] : ['#d6c7a4', '#8c9694', '#4b626e']));
      line(g, hand[0] - 8, hand[1] + 4, hand[0] + 7, hand[1] + 5, 1, human ? '#795f50' : '#374c5d');
      if (human && side === 1) {
        g.save(); g.translate(hand[0] + 1, hand[1] - 5); g.rotate(-.26 + swing * .04);
        nativePath(g, 'M-2 -20 29 -20 29 -11 15 -11 12 5 3 5 6 -11 -2 -11Z', '#101a21');
        line(g, 0, -18, 27, -18, 2, '#87928e');
        round(g, 5, -8, 7, 12, 1, '#293439');
        g.strokeStyle = '#172329'; g.lineWidth = 2; g.strokeRect(13, -10, 9, 8);
        line(g, 27, -21, 27, -18, 2, '#263740');
        ellipse(g, 7, 0, 6, 4, '#b28e70'); g.restore();
      }
    }
    g.save(); g.translate(stride * 1.5, -abs(stride) * 1.4);
    g.beginPath(); g.moveTo(73, 81); g.bezierCurveTo(34, 89, 40, 140, 49, 164); g.quadraticCurveTo(57, 181, 79, 188); g.quadraticCurveTo(116, 193, 151, 187); g.quadraticCurveTo(177, 180, 181, 163); g.bezierCurveTo(190, 122, 188, 88, 157, 81); g.closePath();
    g.fillStyle = actorShade(g, 40, 85, 146, 90, human ? ['#56605b', '#364340', '#1d2a2d'] : ['#48647d', '#2b4563', '#122740']); g.fill();
    nativePath(g, 'M69 93 115 108 160 93 154 168 78 170Z', 'rgba(81,112,142,.2)');
    line(g, 115, 106, 115, 170, 1.5, '#142d47');
    line(g, 63, 171, 107, 179, 1.4, '#62768a'); line(g, 124, 179, 169, 171, 1.3, '#233b54');
    line(g, 75, 181, 83, 188, 2, '#0d233b'); line(g, 150, 182, 143, 189, 2, '#0d233b');
    round(g, 72, 184, 86, 12, 4, '#11253d');
    for (const side of [-1, 1]) {
      const pocketX = side < 0 ? 71 : 126;
      round(g, pocketX - 2, 194, 38, 30, 4, '#132c45');
      for (let note = 0; note < 3; note++) {
        g.save(); g.translate(pocketX + 6 + note * 7, 205); g.rotate((note - 1) * .12);
        rect(g, -8, -25 - note % 2 * 4, 20, 31, actorShade(g, -8, -28, 19, 26, ['#c1d88b', '#83ac52', '#477845']));
        g.strokeStyle = '#3f6d3d'; g.lineWidth = 1.4; g.strokeRect(-5, -21 - note % 2 * 4, 14, 23);
        ellipse(g, 2, -9, 3, 5, '#6d994a'); g.restore();
      }
      g.beginPath(); g.moveTo(pocketX - 2, 208); g.lineTo(pocketX + 36, 208); g.lineTo(pocketX + 32, 224); g.quadraticCurveTo(pocketX + 18, 231, pocketX + 2, 224); g.closePath();
      g.fillStyle = actorShade(g, pocketX, 209, 35, 17, ['#345472', '#1d3751', '#152e47']); g.fill();
      line(g, pocketX + 2, 212, pocketX + 30, 212, 1, '#62788b');
    }
    if (human) {
      ellipse(g, 115, 53, 48, 45, actorShade(g, 68, 10, 96, 80, ['#505956', '#2c393b', '#14242a']));
      nativePath(g, 'M82 65 72 92 103 101 127 99 158 92 148 63Z', '#273537');
      round(g, 100, 70, 30, 17, 5, '#ad896c');
      ellipse(g, 115, 54, 29, 30, '#313a37');
      line(g, 114, 14, 114, 68, 1.5, '#64716a');
      line(g, 83, 76, 96, 91, 2, '#6a756d'); line(g, 147, 76, 134, 91, 2, '#17292e');
    } else {
      round(g, 72, 19, 88, 69, 18, actorShade(g, 72, 19, 88, 56, ['#f2e4c4', '#b6b7a7', '#5c7280']));
      nativePath(g, 'M73 34 90 8 144 8 162 33 149 42 81 42Z', '#728895');
      nativePath(g, 'M74 32 90 8 103 8 89 38Z', '#a3b4b4');
      nativePath(g, 'M145 9 161 33 150 40 139 15Z', '#405b6c');
      round(g, 70, 50, 93, 33, 11, '#899d9f');
      round(g, 78, 55, 77, 25, 8, actorShade(g, 78, 55, 77, 20, ['#334f61', '#122f42', '#071c2b']));
      round(g, 94, 62, 45, 9, 4, '#235a6a');
      round(g, 99, 64, 35, 5, 2, '#83f5ed');
      line(g, 82, 54, 150, 54, 1, '#d2d6c5');
      round(g, 62, 36, 13, 26, 5, actorShade(g, 62, 36, 13, 23, ['#f4bc74', '#d8813b', '#8b592f']));
      round(g, 158, 36, 13, 26, 5, '#b66b36');
      for (let i = 0; i < 3; i++) line(g, 146, 43 + i * 3, 152, 43 + i * 3, .8, '#4f6a78');
    }
    g.restore();
  }

  function actorAnimation(frames, width, height, paint) {
    const columns = min(frames, 6);
    const image = canvas(columns * width, Math.ceil(frames / columns) * height, g => {
      for (let frame = 0; frame < frames; frame++) {
        g.save(); g.translate(frame % columns * width, floor(frame / columns) * height);
        g.beginPath(); g.rect(0, 0, width, height); g.clip();
        paint(g, frame); g.restore();
      }
    });
    return (frame, x, y, w, h) => ctx.drawImage(image, frame % columns * width, floor(frame / columns) * height, width, height, x, y, w, h);
  }

  const runners = actorAnimation(ACTOR_FRAMES, 180, 240, (g, frame) => actorPaintRunner(g, frame, false));

  const slidingRunner = actorAnimation(1, 180, 150, g => actorPaintRunner(g, 2, true));

  const guards = actorAnimation(ACTOR_FRAMES, 230, 280, actorPaintGuard);

  const chaseThieves = actorAnimation(ACTOR_FRAMES, 230, 280, (g, frame) => actorPaintGuard(g, frame, true));

  const actorJumpRunner = actorAnimation(1, 180, 240, g => actorPaintRunner(g, -1, false));

  const scooterRider = actorAnimation(1, 180, 270, g => {
    round(g,79,237,22,29,7,'#192a33');
    round(g,65,225,50,14,5,'#ffda24');
    line(g,126,234,126,130,9,'#ffda24');
    line(g,52,128,131,128,7,'#1b2c33');
    actorPaintRunner(g,0,false,true);
    round(g,72,239,36,5,2,'#f1bc19');
  });

  const scooterImage = canvas(180,180,g => {
    for(const x of [35,139]) {
      ellipse(g,x,154,17,17,'#192a33');ellipse(g,x,154,10,10,'#899794');ellipse(g,x,154,5,5,'#243840');
    }
    line(g,130,143,139,154,10,'#899794');
    round(g,30,137,103,12,5,'#ffd629');round(g,40,138,79,6,2,'#25363b');
    line(g,130,141,114,30,12,'#ffdc24');line(g,130,141,114,30,3,'#fff18b');
    line(g,91,28,140,28,9,'#192b32');round(g,109,17,20,11,3,'#273e45');
    ellipse(g,132,145,4,4,'#ff7440');
    g.save();g.translate(119,86);g.rotate(-PI/2-.14);text(g,'whoosh',0,0,11,'#1c3037');g.restore();
  });

  const billImage = canvas(60, 32, g => {
    round(g, 0, 0, 60, 32, 3, actorShade(g, 0, 0, 60, 32, ['#bdd48b', '#8db467', '#648e4c']));
    g.strokeStyle = '#456b3f'; g.lineWidth = 1.3; g.strokeRect(4, 4, 52, 24); g.strokeRect(7, 7, 46, 18);
    ellipse(g, 30, 16, 7, 10, '#729b53'); text(g, 'F', 30, 17, 12, '#c8db9c');
    for (const x of [11, 49]) { text(g, '10', x, 16, 7, '#436d40'); ellipse(g, x, 8, 2, 1, '#a8ca7b'); }
  });

  let actorPreviousLane = 0;

  let actorPreviousJump = 0;

  let actorPreviousTime = 0;

  let actorLastClock = 0;

  let actorLandingAt = -10;

  let actorLean = 0;

  function makeTrainFront(variant) {
  return canvas(360, 490, g => {
    g.scale(2, 2);
    const paint = TRAIN_COLORS[variant];
    const metal = actorShade(g, 0, 0, 180, 0, ['#6e7779', paint, variant === 0 ? '#e04845' : '#f3f0e5', '#637175'], [0, .18, .53, 1]);
    round(g, 5, 3, 170, 236, [30, 30, 13, 13], '#15252d');
    round(g, 8, 6, 164, 224, [28, 28, 11, 11], metal);
    round(g, 15, 12, 150, 151, [25, 25, 16, 16], '#18272f');
    round(g, 34, 22, 112, 23, 4, '#0a151a');
    text(g, DESTINATIONS[variant], 90, 34, 11, '#efc66b', 600);
    const glass = actorShade(g, 18, 48, 127, 102, ['#6d979e', '#244854', '#102731'], [0, .4, 1]);
    round(g, 22, 52, 136, 97, [14, 14, 8, 8], glass);
    nativePath(g, 'M27 57 54 55 148 112 148 126Z', 'rgba(229,241,233,.22)');
    nativePath(g, 'M78 54 92 54 146 86 146 98Z', 'rgba(229,241,233,.12)');
    line(g, 90, 53, 90, 148, variant === 1 ? 5 : 2, '#1b3038');
    for (const x of [43, 112]) line(g, x, 139, x + 27, 119, 3, '#101e25');
    round(g, 18, 164, 144, 43, 8, variant === 0 ? '#bd262d' : '#ca3135');
    for (const x of [76, 90, 104]) poly(g, [[x-7,179],[x,173],[x+7,179],[x,185]], '#f3eee3');
    text(g, ['NS16','NS93','AS14'][variant], 90, 199, 8, '#f5e8d7', 600);
    for (const x of [31, 149]) {
      round(g, x - 10, 184, 20, 11, 4, '#2a373c');
      round(g, x - 8, 186, 16, 6, 3, '#fff5ce');
      line(g, x - 7, 185, x + 7, 185, 1, WHITE);
    }
    line(g, 19, 211, 160, 211, 2, '#d8d6c9');
    round(g, 13, 215, 154, 16, 4, '#26373e');
    round(g, 70, 228, 40, 12, 3, '#111e25');
    for (let x = 40; x < 144; x += 8) line(g, x, 218, x, 226, 2, '#15252d');
    line(g, 12, 48, 12, 204, 2, 'rgba(255,255,245,.28)');
  });
}

  const trainFronts = TRAIN_COLORS.map((_, i) => makeTrainFront(i));

  const sleeperRow = canvas(768,48,g => {
    const s=64;
    for(const lane of [-1,0,1]) {
      const x=384+lane*4*s,a=x-.43*4*s,b=x+.43*4*s,y=16;
      line(g,a+s*.1,y+s*.17,b+s*.1,y+s*.17,s*.28,'rgba(21,32,30,.42)');
      line(g,a,y,b,y,s*.24,'#514737');line(g,a,y-s*.07,b,y-s*.07,s*.05,'#9a805d');
      line(g,a+s*.15,y+s*.06,b-s*.2,y+s*.06,s*.025,'#736247');
      for(const side of [-1,1]) {
        const fx=x+side*.31*4*s;
        round(g,fx-s*.13,y-s*.12,s*.26,s*.2,s*.025,'#343e3e');
        ellipse(g,fx+s*.11,y-s*.04,s*.035,s*.035,'#b5b4a1');
      }
    }
  });

  for (let i = 0; i < 18; i++) for (const side of [-1, 1]) scenery.push({slot: i, side, z: 0});

  const corners = [project(-1.72, 280), project(1.72, 280), project(1.72, -12), project(-1.72, -12)].map(p => [p.x, p.y]);

  const trackWash = ['rgba(129,167,156,.4)', 'rgba(220,183,132,.4)'].map(color => actorShade(ctx, 0, 180, 0, 420, [color, 'rgba(43,50,48,0)', 'rgba(18,33,34,.12)']));

  function drawTerrain(distance,region) {
    const wood=region===2&&distance%600>300;
    const colors=region===3?['#d4b382','#bb9667','#c6a174']:region===4?['#d7e2dc','#c1d1cd','#cfddd6']:region===0?['#c4baa5','#a99e87','#a19680']:region===1?['#8c8a6b','#5a704c','#657b50']:wood?['#b89a70','#957b59','#a58a63']:['#b0ad8e','#7f9067','#8c9a73'];
    const outer=region===2?4.5:9, phase=distance%25, anchor=floor(distance/25);
    for(let i=13;i>=0;i--) {
      const z=max(-28,i*25-phase-25),far=min(280,i*25-phase);
      if(far<=z)continue;
      for(const side of [-1,1]) for(let band=0;band<2;band++) {
        const x=side*(band?2.4:1.78),end=side*(band?outer:2.4),h=band?.04:.12;
        const a=project(x,z,h),b=project(end,z,h),c=project(end,far,h),d=project(x,far,h);
        poly(ctx,[[a.x,a.y],[b.x,b.y],[c.x,c.y],[d.x,d.y]],colors[band?1+(anchor+i)%2:0]);
        if(i>0)line(ctx,d.x,d.y,c.x,c.y,max(.4,d.scale*.035),region===0?'#897f6d':wood?'#68543e':'rgba(34,58,37,.18)');
      }
    }
    for(const side of [-1,1]) for(const [x,color]of [[1.78,'#ded0ac'],[2.4,region===0?'#817a68':'#637255']]) {
      const a=project(side*x,-28,.12),b=project(side*x,280,.12);
      line(ctx,a.x,a.y,b.x,b.y,x===1.78?3:1,color);
    }
  }

  function drawTrack(distance, theme) {
    poly(ctx, corners, theme.ground);
    ctx.save();
    trace(ctx, corners);
    ctx.closePath(); ctx.clip();
    for (let i = 48; i >= 0; i--) {
      const z = i * 6 - distance % 6 - 12, a = project(-1.8, z), b = project(1.8, z), far = project(1.8, z + 6);
      const h = max(1, a.y - far.y + 1);
      ctx.drawImage(worldBallast, 0, i % 6 * 64, 384, 64, a.x, far.y, b.x - a.x, h);
    }
    const wash = trackWash[+(theme.kind === 'city')];
    rect(ctx, 0, 174, W, 426, wash); ctx.restore();
    for(let i=45;i>=0;i--) {
      const p=project(0,i*6-distance%6-12),s=p.scale;
      ctx.drawImage(sleeperRow,400-6*s,p.y-.25*s,12*s,.75*s);
    }
    for (const lane of [-1, 0, 1]) {
      for (const offset of [-.31, .31]) for (const [width, color] of [[.052, '#303e41'], [.035, '#6d858b'], [.018, '#bacbc7'], [.006, '#eef0d9']]) {
        const x = lane + offset, pts = [project(x - width, 280), project(x + width, 280), project(x + width, -12), project(x - width, -12)];
        poly(ctx, pts.map(p => [p.x, p.y]), color);
      }
    }
    for (const side of [-1, 1]) {
      const a = project(side * 1.76, 280), b = project(side * 1.76, -12);
      line(ctx, a.x, a.y, b.x, b.y, 3, theme.kind === 'city' ? '#c7b99c' : '#5b6c56');
    }
  }

  function drawPost(x, z, index) {
  const base=project(x,z), top=project(x,z,7.6), s=base.scale, w=s*3.2, h=s*4.8, rim=s*.08;
  ctx.save();ctx.globalAlpha*=depthOpacity(z);
  for (const side of [-1,1]) {
    const px=base.x+side*w*.3;
    line(ctx,px,base.y,px,top.y+h,s*.075,'#3b4d52');
    line(ctx,px-s*.025,base.y,px-s*.025,top.y+h,s*.022,'#a6b4ae');
    ellipse(ctx,px,base.y,s*.15,s*.035,'#364a4f');
  }
  poly(ctx,[[top.x+w/2,top.y-rim],[top.x+w/2+rim*2,top.y+rim],[top.x+w/2+rim*2,top.y+h+rim*2],[top.x+w/2,top.y+h+rim]],'#263b42');
  round(ctx,top.x-w/2-rim,top.y-rim,w+rim*2,h+rim*2,rim,'#637679');
  ctx.drawImage(posters[index%4],top.x-w/2,top.y,w,h);
  line(ctx,top.x-w/2,top.y-rim,top.x+w/2,top.y-rim,max(.5,rim*.5),'#d2d8c9');
  poly(ctx,[[top.x-w/2,top.y],[top.x-w*.16,top.y],[top.x-w/2,top.y+h*.57]],'rgba(240,249,243,.045)');
  ctx.restore();
}

  function drawBridge(z) {
    ctx.save(); ctx.globalAlpha *= depthOpacity(z);
    const a = project(-3.6, z, 5.8);
    const b = project(3.6, z, 5.8);
    const s = a.scale;
    line(ctx, a.x, a.y, b.x, b.y, s * .24, '#355e5d');
    line(ctx, a.x, a.y - s * .7, b.x, b.y - s * .7, s * .18, '#456f68');
    for (let i = 0; i < 10; i++) {
      const x = a.x + (b.x - a.x) * i / 10;
      const nx = a.x + (b.x - a.x) * (i + 1) / 10;
      line(ctx, x, a.y, nx, a.y - s * .7, s * .09, '#4c7770');
    }
    for (const side of [-1, 1]) {
      const foot = project(side * 2.15, z);
      line(ctx, foot.x, foot.y, foot.x, a.y, s * .34, '#9d9980');
    }
    ctx.restore();
  }

  function drawScenery(distance, region, theme) {
    for (const entry of scenery) entry.z = (entry.slot * 25 + entry.side * 6 - distance % 450 + 450) % 450 - 28;
    scenery.sort((a, b) => b.z - a.z);
    const local = distance % 600;
    const isChiloe = region === 2 && local > 300;
    for (const entry of scenery) {
      if (entry.z > 280 || entry.z < -28) continue;
      const i = entry.slot, side = entry.side, variation = (i + (side > 0 ? 1 : 0)) % 3;
      const x = side * (2.9 + i % 2 * .22);
      if (region > 2) {
        const kind=region===3?(i%4===0?1:0):(i%4===0?3:2);
        const frame=kind?floor(clock*4+i)%4:0;
        const h=kind===0?6+i%3:kind===2?3.4:5.8;
        billboard(nature[kind][frame],side*(2.9+i%3*.5),entry.z,h*.83,h);
        if(region===4&&i%4===2)billboard(buildings[2][variation],side*5.5,entry.z+8,7,9);
      } else if (region === 0) {
        const anchor = Math.round((distance + entry.z - side * 6 + 28) / 25);
        const band = max(0, min(2, floor(((distance + entry.z) % 600 + 600) % 600 / 200)));
        const block = Math.imul(anchor * 2 + (side > 0 ? 1 : 0), 1597334677);
        const building = ((block ^ (block >>> 15)) >>> 0) % 12;
        const height = band === 1 ? 14 : band === 2 ? 16 : 15;
        billboard(santiagoBuildings[(building + 3) % 12], side * 5.5, entry.z + 11, 8.5, height * 1.12);
        billboard(santiagoBuildings[building], x, entry.z, 8.5, height);
        if (band === 1 && i % 3 === 0) billboard(neighborhoodProps[0], side * 2.4, entry.z - 4, 4.9, 9.4);
      } else if (region === 1) {
        const village = local + entry.z >= 300;
        if (village && i % 3 !== 2 || !village && i % 7 === 0) billboard(buildings[1][variation], x, entry.z, 6.7 + i % 2, 8.8 + i % 2);
        else billboard(trees[i % 4 === 0 ? 2 : 1], side * (2.72 + i % 3 * .35), entry.z, 5.9 + i % 2, 10 + i % 3 * .7);
        billboard(trees[1], side * (4.8 + i % 2), entry.z + 9, 8, 13 + i % 3);
        if (i % 2 === 0) billboard(neighborhoodProps[1], side * 2.3, entry.z - 5, 5.1, 3.7);
      } else if (isChiloe || i % 3 === 0) {
        billboard(buildings[region][variation], x, entry.z, 6.8 + i % 2 * .5, 9.2 + i % 3 * .4);
      } else {
        billboard(trees[region], side * (2.55 + i % 3 * .45) + sin(clock * .7 + i) * .025, entry.z, 6.4, 10);
        if (i % 3 === 1) billboard(trees[region], side * 4.7, entry.z + 9, 8, 12);
      }
      if (i % 4 === 1) drawPost(side * 1.98, entry.z - 5, floor(i / 4) * 2 + (side > 0 ? 1 : 0));
    }
    if (region === 0) {
      const z = (225 - distance % 340 + 368) % 340 - 28;
      if (z > -28 && z < 260) drawBridge(z);
    }
  }

  function drawTrain(object) {
  const variant = object.variant % 3, near = -28, height = 5.1;
  const frontZ = object.z - object.length / 2, backZ = object.z + object.length / 2;
  if (backZ <= near) return;
  const point = (x, z, h = 0) => project(x, z, h);
  const sideX = object.lane >= 0 ? object.lane - .39 : object.lane + .39;
  const depth = t => frontZ + object.length * t;
  const face = (t0, t1, h0, h1, color) => {
    const z0 = max(near, depth(t0)), z1 = depth(t1);
    if (z1 <= near) return;
    const points = [point(sideX,z0,h0),point(sideX,z1,h0),point(sideX,z1,h1),point(sideX,z0,h1)];
    poly(ctx, points.map(p => [p.x, p.y]), color);
  };
  const clippedFront = max(near, frontZ);
  const left = point(object.lane - .39, clippedFront), right = point(object.lane + .39, clippedFront);
  const a = point(object.lane - .39, clippedFront, height), b = point(object.lane + .39, clippedFront, height);
  const c = point(object.lane + .39, backZ, height), d = point(object.lane - .39, backZ, height);
  ctx.save();
  ctx.translate(0, sin(clock * 21 + object.id) * min(.4, left.scale * .012));
  face(0,1,0,height,TRAIN_COLORS[variant]);
  face(0,1,0,.65,'#24353b');
  face(0,1,.7,2.65,variant === 0 ? '#ad2930' : '#c8ccca');
  face(0,1,2.55,2.82,variant === 0 ? '#ebe6d9' : '#c42b34');
  face(0,1,4.65,4.78,'#e0e2d9');
  for (let i = 0; i < 8; i++) {
    const t = (i + .12) / 8, end = t + .09, door = i % 3 === 1;
    if (door) {
      face(t-.007,end+.007,.83,4.55,'#8a9695');
      face(t,end,1,4.48,'#d4d7ce');
      face(t+.041,t+.046,1,4.48,'#3e5359');
    }
    face(t+.005,end-.005,3,4.35,'#163440');
    face(t+.009,end-.009,3.98,4.29,'#688a91');
    face(t+.014,t+.027,3.07,4.3,'rgba(209,231,224,.22)');
    if (i === 0 || i === 6) {
      face(t,end,.12,.43,'#14232a'); face(t+.02,end-.02,.18,.37,'#627271');
    }
  }
  poly(ctx, [[a.x,a.y],[b.x,b.y],[c.x,c.y],[d.x,d.y]], '#a5aeaa');
  for (let i = 1; i < 6; i++) {
    const z = depth(i / 6);
    if (z < near) continue;
    const p = point(object.lane - .33,z,5.12), q = point(object.lane + .33,z,5.12);
    line(ctx,p.x,p.y,q.x,q.y,max(.5,p.scale*.055),i%2 ? '#647579' : '#d8dcd2');
  }
  if (frontZ >= near && right.x > 0 && left.x < W && left.y > 0 && a.y < H) {
    ctx.drawImage(trainFronts[variant],left.x,a.y,right.x-left.x,left.y-a.y);
  }
  ctx.restore();
}

  function drawBarrier(object) {
  const p = project(object.lane, object.z), s = p.scale, w = s * 3.1, h = s;
  ellipse(ctx,p.x+s*.2,p.y+s*.1,w*.56,s*.16,'rgba(13,25,30,.28)');
  for (const side of [-1,1]) {
    poly(ctx,[[p.x+side*w*.36-s*.13,p.y-s*.42],[p.x+side*w*.36+s*.1,p.y-s*.42],[p.x+side*w*.36+s*.34,p.y+s*.14],[p.x+side*w*.36-s*.25,p.y+s*.14]],'#43555b');
    line(ctx,p.x+side*w*.36,p.y-s*.28,p.x+side*w*.36+s*.2,p.y+s*.07,s*.05,'#91a09b');
  }
  const steel = actorShade(ctx, 0, p.y-h, 0, h, ['#f1bf61', '#e7a132', '#b46e27'], [0, .2, 1]);
  round(ctx,p.x-w/2,p.y-h,w,h*.74,s*.05,steel);
  ctx.save();ctx.beginPath();ctx.rect(p.x-w/2+s*.06,p.y-h+s*.06,w-s*.12,h*.61);ctx.clip();
  for (let i=-3;i<5;i++) poly(ctx,[[p.x+i*s*.8,p.y-h],[p.x+i*s*.8+s*.32,p.y-h],[p.x+i*s*.8+s*.82,p.y-h*.25],[p.x+i*s*.8+s*.5,p.y-h*.25]],'#26373a');
  ctx.restore();
  line(ctx,p.x-w/2,p.y-h,p.x+w/2,p.y-h,s*.045,'#ffe3a0');
  for (const side of [-1,1]) ellipse(ctx,p.x+side*w*.44,p.y-h*.64,s*.045,s*.045,'#ebedda');
  round(ctx,p.x-s*.27,p.y-h*.98,s*.54,s*.61,s*.05,'#eff0df');
  text(ctx,'↑',p.x,p.y-h*.68,max(7,s*.49),'#293f44');
}

  function drawGate(object) {
  const p = project(object.lane,object.z), s = p.scale, w = s*3.3;
  ellipse(ctx,p.x,p.y,w*.58,s*.18,'rgba(17,33,36,.21)');
  for (const side of [-1,1]) {
    round(ctx,p.x+side*w/2-s*.12,p.y-s*4.2,s*.24,s*4.2,s*.04,'#576f73');
    line(ctx,p.x+side*w/2-s*.06,p.y-s*4.1,p.x+side*w/2-s*.06,p.y,s*.035,'#bfcbc0');
    round(ctx,p.x+side*w/2-s*.3,p.y-s*.12,s*.6,s*.2,s*.04,'#33484f');
  }
  round(ctx,p.x-w/2-s*.16,p.y-s*4.2,w+s*.32,s*1.85,s*.08,'#283f48');
  line(ctx,p.x-w/2,p.y-s*4.1,p.x+w/2,p.y-s*4.1,s*.045,'#9bacab');
  for (const side of [-1,1]) for (let i=0;i<3;i++) {
    const x = p.x+side*w*.33+s*(i*.18-.2);
    line(ctx,x,p.y-s*3.85,x+s*.32,p.y-s*2.62,s*.1,'#edb541');
  }
  line(ctx,p.x-w/2,p.y-s*2.37,p.x+w/2,p.y-s*2.37,s*.12,'#f1ba51');
  text(ctx,'↓',p.x,p.y-s*3.23,max(8,s*1.12),'#fff0cb');
}

  const coinFace = canvas(128,128,g => {
    g.translate(64,64);
    const r=64,gold = actorShade(g, -r, -r, r*2, r*2, ['#fff0a5', '#e7a536', '#fff0a5', '#bd791f', '#e5b84f'], [0, .24, .5, .7, 1]);
    ellipse(g,0,0,r,r,gold);ellipse(g,0,0,r*.83,r*.83,'#b97c26');
    ellipse(g,-r*.025,-r*.025,r*.75,r*.75,'#eac363');ellipse(g,0,0,r*.64,r*.64,gold);
    text(g,'T',r*.025,r*.065,r*1.27,'#a56e25');text(g,'T',-r*.035,r*.015,r*1.27,'#fff1b1');
  });

  function drawCoin(object) {
    const p = project(object.lane, object.z, .95);
    const r = p.scale * .48;
    const angle = clock * 3.4 + object.id * .3;
    const width = max(.055, abs(cos(angle)));
    const edge = sin(angle) * r * .18;
    ctx.save(); ctx.translate(p.x, p.y);
    const halo = ctx.createRadialGradient(0, 0, r * .5, 0, 0, r * 1.6);
    halo.addColorStop(0, 'rgba(255,195,65,.09)'); halo.addColorStop(1, 'rgba(255,195,65,0)');
    ellipse(ctx, 0, 0, r * 1.6, r * 1.6, halo);
    ctx.save(); ctx.scale(width, 1);
    ellipse(ctx, edge / width, 0, r, r, '#8d5922');
    for (let i = 0; i < 16; i++) {
      const a = i * PI / 8;
      const y = sin(a) * r * .94;
      line(ctx, cos(a) * r * .94, y, cos(a) * r * .94 + edge / width, y, max(.5, r * .045), '#d6aa55');
    }
    ctx.drawImage(coinFace,-r,-r,r*2,r*2);
    ctx.restore();
    const glint = Math.pow(max(0, sin(angle + .5)), 12) * .6;
    line(ctx, -r * width * .55, -r * .7, r * width * .15, -r * .76, max(.5, r * .065), `rgba(255,248,207,${glint})`);
    ctx.restore();
  }

  function drawScooter(object) {
    const p=project(object.lane,object.z), s=p.scale;
    ellipse(ctx,p.x,p.y,s*1.3,s*.18,'rgba(255,215,45,.24)');
    const bob=sin(clock*3+object.id)*s*.08;
    ctx.drawImage(scooterImage,p.x-s*1.5,p.y-s*3.1+bob,s*3,s*3);
  }

  const obstaclePainters = {train: drawTrain, barrier: drawBarrier, gate: drawGate, coin: drawCoin, scooter: drawScooter};

  const sortedObjects = [];

  const objectFront = object => object.type === 'train' ? object.z - object.length / 2 : object.z;

  const objectOrder = (a, b) => objectFront(b) - objectFront(a);

  function drawObjects(objects) {
  sortedObjects.length = 0;
  for (const object of objects) {
    if (object.z < 280 && object.z + object.length / 2 > -28) sortedObjects.push(object);
  }
  sortedObjects.sort(objectOrder);
  for (const object of sortedObjects) {
    ctx.save(); ctx.globalAlpha *= depthOpacity(object.z);
    obstaclePainters[object.type](object);
    ctx.restore();
  }
}

  function drawCharacters(state) {
    const dt = max(0, min(.1, clock - actorLastClock));
    const moving = state.phase === 'running' || state.phase === 'title';
    const lane = state.laneX || 0;
    if ((state.time || 0) < actorPreviousTime) {
      actorPreviousLane = lane; actorPreviousJump = 0; actorLean = 0; actorLandingAt = -10;
    }
    const frame = floor(clock * (1.7 + min(40, state.speed || 20) * .02) * ACTOR_FRAMES) % ACTOR_FRAMES;
    const velocity = dt > 0 ? (lane - actorPreviousLane) / dt : 0;
    const leanTarget = moving ? max(-.14, min(.14, velocity * .022)) : 0;
    actorLean += (leanTarget - actorLean) * (1 - Math.exp(-13 * dt));
    if (actorPreviousJump > .05 && state.jump === 0) actorLandingAt = clock;
    const landing = max(0, 1 - (clock - actorLandingAt) / .18);
    const squash = landing * sin(landing * PI / 2) * .1;
    const p = project(lane, 0);
    const height = max(0, state.jump || 0) * p.scale;
    ellipse(ctx, p.x + 7, p.y + 3, 24 - min(10, height * .08), 7, `rgba(14,30,43,${.27 - min(.16, height * .0015)})`);
    ellipse(ctx, p.x - 2, p.y + 1, 14 - min(6, height * .05), 3, 'rgba(11,25,36,.2)');
    const sliding = state.slide > 0;
    const riding = !!state.scooter;
    const runner = sliding ? slidingRunner : riding ? scooterRider : height > 1 ? actorJumpRunner : runners;
    const runnerHeight = sliding ? 56 : riding ? 135 : 118;
    const bob = moving && height === 0 && !sliding && !riding ? -abs(sin(clock * 13)) * 1.8 : 0;
    const captureTilt = state.phase === 'captured' || state.phase === 'result' ? -.12 * min(1, state.captureTime / .8) : 0;
    ctx.save(); ctx.translate(p.x, p.y - height + bob); ctx.rotate(actorLean + captureTilt);
    ctx.scale(1 + squash * .65, 1 - squash);
    if(riding && sliding) ctx.drawImage(scooterImage,-24,-36,48,48);
    ctx.globalAlpha = state.recovery > 0 ? .55+.45*abs(sin(clock*22)) : 1;
    runner(sliding || riding || height > 1 ? 0 : frame, -44, -runnerHeight, 88, runnerHeight); ctx.restore();
    const pursuit = state.chaser || {z: -11, laneX: lane, jump: 0, slide: 0};
    const guardGround = project(pursuit.laneX, pursuit.z);
    const guardScale = guardGround.scale / (900 / 21);
    const guardX = guardGround.x;
    const guardY = guardGround.y - pursuit.jump * guardGround.scale;
    const guardHeight = 178 * guardScale * (pursuit.slide > 0 ? .55 : 1);
    const guardBob = moving && pursuit.jump === 0 ? -abs(sin(clock * 13 + .5)) * 2 : 0;
    ellipse(ctx, guardX + 6, guardGround.y - 1, 43 * guardScale, 9 * guardScale, 'rgba(9,23,35,.29)');
    ctx.save(); ctx.translate(guardX, guardY + guardBob); ctx.rotate(pursuit.slide > 0 ? -.2 : 0);
    (state.region === 0 ? chaseThieves : guards)((frame + ACTOR_FRAMES / 4) % ACTOR_FRAMES, -72 * guardScale, -guardHeight, 144 * guardScale, guardHeight); ctx.restore();
    for (let i = 0; i < 16; i++) {
      const side = i % 2 ? 1 : -1;
      const t = (clock * .73 + floor(i / 2) / 8) % 1;
      const x = guardX + side * (24 + 29 * t) * guardScale + sin(t * 10 + i) * 5 * t;
      const y = guardY - guardHeight * .28 + (11 * t + 50 * t * t) * guardScale;
      const flip = cos(t * PI * 4 + i * .7);
      ctx.save(); ctx.translate(x, y); ctx.rotate(side * (.12 + t * .8) + sin(t * 6 + i) * .4);
      ctx.scale(max(.07, abs(flip)), .82 + sin(t * 8 + i) * .13);
      ctx.globalAlpha = min(1, (1 - t) / .2);
      ctx.drawImage(billImage, -11.5, -6, 23, 12); ctx.restore();
    }
    actorPreviousLane = lane; actorPreviousJump = state.jump || 0;
    actorPreviousTime = state.time || 0; actorLastClock = clock;
  }

  const fxParticles = Array.from({length: 48}, () => ({life: 0, x: 0, y: 0, vx: 0, vy: 0, size: 0}));

  let fxCursor = 0;

  let fxImpact = 0;

  let fxReward = 0;

  let fxPreviousBackground = null;

  let fxBackgroundKey = 6;

  let fxBlend = 0;

  const fxVignette = canvas(W, H, g => {
    const shade = g.createRadialGradient(400, 280, 170, 400, 300, 520);
    shade.addColorStop(0, 'rgba(5,17,27,0)');
    shade.addColorStop(1, 'rgba(5,17,27,.24)');
    rect(g, 0, 0, W, H, shade);
  });

  function fxAdvance(state, dt, events) {
    if(events.includes('shield')) fxImpact=.14;
    if (events.includes('start')) {
      for (const particle of fxParticles) particle.life = 0;
      fxImpact = 0;
      fxReward = 0;
    }
    if (events.includes('crash')) fxImpact = .32;
    for (const event of events) {
      if (event !== 'coin') continue;
      fxReward = .45;
      const p = project(state.laneX || 0, 0, 2.2 + (state.jump || 0));
      for (let i = 0; i < 7; i++) {
        const particle = fxParticles[fxCursor++ % fxParticles.length];
        const angle = (fxCursor * 2.39996) % (PI * 2);
        Object.assign(particle, {life: .38, x: p.x, y: p.y, vx: cos(angle) * 70, vy: sin(angle) * 55 - 20, size: 2 + i % 3});
      }
    }
    fxImpact = max(0, fxImpact - dt);
    fxReward = max(0, fxReward - dt);
    for (const particle of fxParticles) {
      if (particle.life <= 0) continue;
      particle.life = max(0, particle.life - dt);
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vy += 130 * dt;
    }
  }

  function fxDraw(state) {
    for (const particle of fxParticles) {
      if (particle.life <= 0) continue;
      ctx.globalAlpha = min(1, particle.life * 4);
      round(ctx, particle.x, particle.y, particle.size, particle.size * .55, 1, '#ffe6a2');
    }
    ctx.globalAlpha = 1;
    if (fxReward > 0) {
      const p = project(state.laneX || 0, 0, 3.6 + (state.jump || 0));
      ctx.save();
      ctx.globalAlpha = min(1, fxReward * 5);
      ctx.shadowColor = '#462e16'; ctx.shadowBlur = 5;
      text(ctx, '+250.000', p.x + 29, p.y - 15 - (1 - fxReward / .45) * 22, 18, '#ffe9a6');
      ctx.restore();
    }
    if (fxImpact > 0) {
      rect(ctx, 0, 0, W, H, `rgba(213,83,43,${fxImpact * .25})`);
    }
  }

  const UI_INK = '#142638', UI_GOLD = '#f0bf73';

  const hudPlaces = [
      ['CENTRO HISTÓRICO', 'BARRIO RESIDENCIAL', 'CENTRO COMERCIAL'],
      ['BOSQUE DE ARAUCARIAS', 'PUEBLO DEL SUR'],
      ['PUERTO VARAS', 'CHILOÉ'],
      ['SALAR DE ATACAMA','VALLE DE LOS CACTUS'],
      ['ESTRECHO DE MAGALLANES','ISLA MAGDALENA']
    ];

  const numberFormat = new Intl.NumberFormat('es-CL');

  const hudNumbers = {};

  function hudValue(value, x, y, width, size, color = CREAM) {
    value = floor(value);
    let entry = hudNumbers[x];
    if (!entry || entry.value !== value) {
      const label = numberFormat.format(value);
      ctx.font = `800 ${size}px monospace`;
      const fitted = min(size, size * width / max(1, ctx.measureText(label).width));
      entry = hudNumbers[x] = {value, label, font: `800 ${fitted}px monospace`};
    }
    ctx.font = entry.font;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
    ctx.fillText(entry.label, x, y);
  }

  const renderHudPanels = canvas(W, 112, g => {
    round(g, 16, 16, 768, 64, 8, UI_INK);
    text(g, 'DISTANCIA', 32, 28, 16, UI_GOLD, 700, 'left');
    text(g, 'm', 188, 47, 16, CREAM, 700, 'left');
    text(g, 'TOKENS', 576, 28, 16, UI_GOLD, 700, 'left');
    text(g, 'MEJOR', 576, 68, 16, UI_GOLD, 700, 'left');
    round(g, 80, 88, 640, 24, 4, UI_INK);
    text(g, 'A/D MOVER  W/U SALTAR  S BAJAR/DESLIZAR  ENTER PAUSA', 400, 100, 16, CREAM, 600);
  });

  function drawHud(state, bestScore) {
    const distance = state.distance;
    const region = state.region;
    const local = distance % 600;
    const place = hudPlaces[region][min(hudPlaces[region].length - 1, floor(local / (region ? 300 : 200)))];
    ctx.drawImage(renderHudPanels, 0, 0, W, 80, 0, 0, W, 80);
    hudValue(distance, 32, 47, 150, 22);
    text(ctx, `VELOCIDAD ${(state.speed * state.boost / 20).toFixed(1)}x`, 32, 68, 16, UI_GOLD, 700, 'left');
    text(ctx, THEMES[region].name, 400, 32, 20, CREAM);
    text(ctx, place, 400, 50, 16, CREAM, 700);
    rect(ctx, 246, 67, 308, 2, 'rgba(255,244,217,.25)');
    rect(ctx, 246, 67, max(3, local / 600 * 308), 2, UI_GOLD);
    hudValue(state.tokens, 576, 47, 192, 22);
    hudValue(bestScore, 636, 68, 132, 16, CREAM);
    if (state.scooter || state.recovery > 0) {
      round(ctx, 240, 88, 320, 28, 4, UI_INK);
      text(ctx, state.scooter ? 'WHOOSH ×2 · PROTEGE 1 CHOQUE' : '¡SIGUE CORRIENDO!', 400, 102, 16, UI_GOLD);
    }
    ctx.drawImage(renderHudPanels, 0, 88, W, 24, 0, 565, W, 24);
  }

  function menuPanel(y, height) {
    round(ctx, 200, y, 400, height, 8, UI_INK);
  }

  function actionButton(label, y) {
    round(ctx, 270, y, 260, 36, 4, UI_GOLD);
    text(ctx, label, 400, y + 18, 16, UI_INK);
  }

  function drawMenu(state) {
    const phase = state.phase;
    if (phase === 'running') return;
    if (phase === 'captured') {
      menuPanel(235, 58);
      text(ctx, '¡TE ALCANZÓ!', 400, 264, 25, CREAM);
      return;
    }
    rect(ctx, 0, 0, W, H, 'rgba(16,35,49,.3)');
    if (phase === 'title') {
      menuPanel(150, 280);
      text(ctx, 'ATACAMA  →  PUNTA ARENAS', 400, 177, 16, UI_GOLD);
      text(ctx, 'SUBWAY', 400, 218, 46, CREAM, 900);
      text(ctx, 'FOUNDERS', 400, 260, 46, CREAM, 900);
      text(ctx, 'A / D  MOVER   ·   W / U  SALTO   ·   S  BAJAR', 400, 303, 16, CREAM);
      text(ctx, 'WHOOSH ×2 VELOCIDAD, PROTEGE 1 CHOQUE', 400, 326, 16, CREAM);
      actionButton('ENTER  PARA CORRER', 369);
    } else if (phase === 'paused') {
      menuPanel(200, 170);
      text(ctx, 'PAUSA', 400, 247, 36, CREAM);
      actionButton('ENTER  PARA SEGUIR', 310);
    } else if (phase === 'result') {
      menuPanel(160, 265);
      text(ctx, 'FIN DEL VIAJE', 400, 195, 25, CREAM);
      text(ctx, numberFormat.format(floor(state.score)), 400, 242, 38, UI_GOLD);
      text(ctx, 'PUNTOS', 400, 270, 16, CREAM);
      text(ctx, `${numberFormat.format(floor(state.distance))} m RECORRIDOS`, 400, 302, 16, CREAM);
      text(ctx, `${numberFormat.format(floor(state.tokens))} TOKENS`, 400, 328, 16, CREAM);
      actionButton('ENTER  OTRA CARRERA', 365);
    }
  }

  function draw(state, elapsedSeconds, bestScore, events = []) {
    if (disposed) return;
    const active = state.phase !== 'paused' && state.phase !== 'result';
    const dt = active ? max(0, min(.1, elapsedSeconds || 0)) : 0;
    clock += dt;
    if (state.phase === 'title') attractDistance += dt * 9;
    const distance = state.phase === 'title' ? attractDistance : state.distance || 0;
    const region = state.region || 0;
    const theme = THEMES[region];
    const chiloe = region === 2 && distance % 600 > 300;
    const key = region * 2 + (chiloe ? 1 : 0);
    const background = chiloe ? chiloeBackground : backgrounds[region];
    if (key !== fxBackgroundKey) {
      const previousRegion = floor(fxBackgroundKey / 2);
      fxPreviousBackground = fxBackgroundKey % 2 ? chiloeBackground : backgrounds[previousRegion];
      fxBackgroundKey = key;
      fxBlend = .7;
    }
    fxBlend = max(0, fxBlend - dt);
    fxAdvance(state, dt, events);
    ctx.drawImage(background, 0, 0);
    if (fxBlend > 0 && fxPreviousBackground) {
      ctx.globalAlpha = fxBlend / .7;
      ctx.drawImage(fxPreviousBackground, 0, 0);
      ctx.globalAlpha = 1;
    }
    ctx.save();
    const shake = fxImpact * 8;
    ctx.translate(sin(clock * 63) * shake, cos(clock * 57) * shake * .5);
    drawTerrain(distance,region);
    drawTrack(distance, theme);
    drawScenery(distance, region, theme);
    drawObjects(state.objects || []);
    drawCharacters(state);
    ctx.restore();
    if(region===4)for(let i=0;i<28;i++)ellipse(ctx,(i*137+clock*23)%W,(i*83+clock*47)%H,1,1,'rgba(245,251,247,.65)');
    fxDraw(state);
    ctx.drawImage(fxVignette, 0, 0);
    drawHud(state, bestScore);
    drawMenu(state);
  }

  function dispose() {
    disposed = true;
    for (const image of cached) { image.width = 1; image.height = 1; }
    cached.length = 0;
    sortedObjects.length = 0;
    scenery.length = 0;
  }

  return {draw, dispose};
}

/* Cabinet input owns browser listeners for one scene lifetime. Commands fire once per press. */
function createCabinetInput(target, documentTarget, onGesture) {
  const keyToCode = new Map();
  const held = new Set();
  const queue = [];
  const actions = { P1_L: 'left', P1_R: 'right', P1_U: 'jump', P1_D: 'slide', P1_1: 'jump', START1: 'start' };
  const normalize = key => key.length === 1 ? key.toLowerCase() : key;
  for (const [code, keys] of Object.entries(CABINET_KEYS)) {
    for (const key of keys) keyToCode.set(normalize(key), code);
  }
  function keydown(event) {
    const code = keyToCode.get(normalize(event.key));
    if (!code) return;
    event.preventDefault();
    if (event.repeat || held.has(code)) return;
    held.add(code);
    onGesture();
    if (actions[code]) queue.push(actions[code]);
  }
  function keyup(event) {
    const code = keyToCode.get(normalize(event.key));
    if (code) {
      event.preventDefault();
      held.delete(code);
    }
  }
  function clear() {
    held.clear();
    queue.length = 0;
  }
  function blur() {
    clear();
    queue.push('blur');
  }
  function visibility() {
    if (documentTarget.hidden) blur();
  }
  target.addEventListener('keydown', keydown);
  target.addEventListener('keyup', keyup);
  target.addEventListener('blur', blur);
  documentTarget.addEventListener('visibilitychange', visibility);
  return {
    drain() { return queue.splice(0); },
    clear,
    dispose() {
      clear();
      target.removeEventListener('keydown', keydown);
      target.removeEventListener('keyup', keyup);
      target.removeEventListener('blur', blur);
      documentTarget.removeEventListener('visibilitychange', visibility);
    },
  };
}

/* Scores use the platform bridge. Loading and saving never block a run. */
function createBestScore(storage) {
  const key = 'subway-founders:v1:best';
  let best = 0;
  let writes = Promise.resolve();
  const valid = score => Number.isSafeInteger(score) && score >= 0 && score <= 1000000000;
  const loaded = Promise.resolve().then(async () => {
    if (!storage || typeof storage.get !== 'function') return best;
    const result = await storage.get(key);
    const value = result && result.found && result.value;
    if (value && value.version === 1 && valid(value.bestScore)) best = Math.max(best, value.bestScore);
    return best;
  }).catch(() => best);
  return {
    get value() { return best; },
    load() { return loaded; },
    save(score) {
      if (!valid(score)) return Promise.resolve(best);
      best = Math.max(best, score);
      writes = writes.then(() => loaded).then(async () => {
        if (storage && typeof storage.set === 'function') {
          await storage.set(key, { version: 1, bestScore: best });
        }
        return best;
      }).catch(() => best);
      return writes;
    },
  };
}

/* One audio bus and a bounded set of short-lived sources survive retries. */
function createRunAudio(context) {
  if (!context) return { unlock() {}, play() {}, dispose() {} };
  const bus = context.createGain();
  bus.gain.value = 0.12;
  bus.connect(context.destination);
  const sources = new Set();
  const tones = { coin: [880, 1320], jump: [220, 440], slide: [170, 110], crash: [110, 45], start: [330, 660], region: [523, 784], scooter: [660,990], shield: [330,170] };
  const buffers = new Map();
  for (const [event, frequencies] of Object.entries(tones)) {
    const length = event === 'crash' ? 0.28 : 0.12;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * length), context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / context.sampleRate;
      const frequency = frequencies[i < data.length / 2 ? 0 : 1];
      data[i] = Math.sin(t * frequency * Math.PI * 2) * Math.pow(1 - i / data.length, 2);
    }
    buffers.set(event, buffer);
  }
  return {
    unlock() {
      if (context.state === 'suspended') context.resume().catch(() => {});
    },
    play(event) {
      const buffer = buffers.get(event);
      if (!buffer || sources.size >= 8 || context.state !== 'running') return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(bus);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); };
      source.start();
    },
    dispose() {
      for (const source of sources) {
        source.onended = null;
        source.stop();
        source.disconnect();
      }
      sources.clear();
      bus.disconnect();
    },
  };
}

const game = new Phaser.Game({
  type: Phaser.CANVAS,
  width: 800,
  height: 600,
  parent: 'game-root',
  backgroundColor: '#142638',
  render: { clearBeforeRender: false },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: {
    create() {
      this.cameras.main.setBackgroundColor('rgba(0,0,0,0)');
      const state = RunRules.create(Math.floor(Math.random() * 0x100000000));
      const presentation = createPresentation(this.game.canvas.getContext('2d'));
      const audio = createRunAudio(this.sound.context);
      const bestScore = createBestScore(window.platanusArcadeStorage);
      const input = createCabinetInput(window, document, () => audio.unlock());
      let drawnPhase = null;
      let drawnBest = -1;
      let paintSeconds = 0;
      const paintEvents = [];
      const step = (seconds, commands = input.drain()) => {
        const events = RunRules.advance(state, seconds, commands);
        paintSeconds += seconds;
        for (const event of events) { audio.play(event); if (!paintEvents.includes(event)) paintEvents.push(event); }
        if (events.includes('crash')) bestScore.save(state.score);
        return events;
      };
      const paint = () => {
        const frozen = state.phase === 'paused' || state.phase === 'result';
        if (!frozen || state.phase !== drawnPhase || bestScore.value !== drawnBest || paintEvents.length) {
          presentation.draw(RunRules.sample(state), paintSeconds, bestScore.value, paintEvents);
          drawnPhase = state.phase;
          drawnBest = bestScore.value;
        }
        paintSeconds = 0;
        paintEvents.length = 0;
      };
      const invalidate = () => { drawnPhase = null; };
      this.events.on('render', paint);
      this.scale.on('resize', invalidate);
      this.founders = { state, input, presentation, bestScore, step };
      const focus = () => { window.focus(); audio.unlock(); };
      this.game.canvas.addEventListener('pointerdown', focus);
      this.game.canvas.tabIndex = 0;
      this.game.canvas.setAttribute('aria-label', 'Subway Founders Chile. Enter starts. A and D change lanes. W or U jumps. S descends in air or slides on ground. Each token awards 250000.');
      this.events.once('shutdown', () => {
        input.dispose();
        presentation.dispose();
        audio.dispose();
        this.game.canvas.removeEventListener('pointerdown', focus);
        this.events.off('render', paint);
        this.scale.off('resize', invalidate);
      });
      step(0);
    },
    update(time, delta) {
      if (this.founders) this.founders.step(Math.min(delta / 1000, 0.25));
    },
  },
});
