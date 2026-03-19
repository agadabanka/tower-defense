/**
 * Tower Defense — TypeScript IL game spec using @engine SDK.
 *
 * Enemies follow a winding path from spawn to base. The player (or AI)
 * places towers on buildable tiles to eliminate waves of increasingly
 * difficult enemies. Gold is earned from kills and spent on towers.
 *
 * AI auto-places towers near path bends for maximum coverage.
 */

import { defineGame } from '@engine/core';
import { consumeAction } from '@engine/input';
import {
  clearCanvas, drawRoundedRect, drawCircle,
  drawLabel, drawGameOver, drawTextCell,
} from '@engine/render';
import { drawTouchOverlay } from '@engine/touch';
import {
  aStar, generateTDMap, createWaveManager, tickWave,
  spawnEnemy, moveEnemy, findTargetsInRange, towerAttack,
} from '@engine/pathfinding';

// ── Constants ───────────────────────────────────────────────────────

const W = 640;
const H = 480;
const GRID_W = 20;
const GRID_H = 15;
const CELL = 32;

const TOWER_COST = 25;
const TOWER_RANGE = 3;
const TOWER_DAMAGE = 10;
const TOWER_FIRE_RATE = 1000;

const AI_INTERVAL = 600;
const WAVE_DELAY = 4.0;
const SPAWN_INTERVAL = 0.8;
const ENEMIES_BASE = 5;

const HUD_X = GRID_W * CELL + 4;
const HUD_W = W - HUD_X;

// Tile types from generateTDMap: 0 = buildable, 1 = path, 2 = spawn, 3 = base
const TILE_BUILDABLE = 0;
const TILE_PATH = 1;
const TILE_SPAWN = 2;
const TILE_BASE = 3;

const TILE_COLORS = {
  [TILE_BUILDABLE]: '#4a7c59',
  [TILE_PATH]:      '#8B7355',
  [TILE_SPAWN]:     '#cc6633',
  [TILE_BASE]:      '#cc3333',
};

// ── Game Definition ─────────────────────────────────────────────────

const game = defineGame({
  display: {
    type: 'custom',
    width: GRID_W,
    height: GRID_H,
    cellSize: CELL,
    canvasWidth: W,
    canvasHeight: H,
    offsetX: 0,
    offsetY: 0,
    background: '#2a2a2a',
  },
  input: {
    up:      { keys: ['ArrowUp', 'w'] },
    down:    { keys: ['ArrowDown', 's'] },
    left:    { keys: ['ArrowLeft', 'a'] },
    right:   { keys: ['ArrowRight', 'd'] },
    select:  { keys: [' ', 'Enter'] },
    restart: { keys: ['r', 'R'] },
  },
});

// ── Resources ───────────────────────────────────────────────────────

game.resource('state', {
  score: 0,
  gameOver: false,
  gold: 100,
  lives: 20,
  message: 'Place towers!',
  towerCost: TOWER_COST,
});

game.resource('map', {
  grid: [],
  path: [],
  width: GRID_W,
  height: GRID_H,
  cellSize: CELL,
  initialized: false,
});

game.resource('towers', { list: [] });
game.resource('enemies', { list: [] });
game.resource('wave', { manager: null });
game.resource('_cursor', { r: 7, c: 10 });
game.resource('_aiTimer', { elapsed: 0 });
game.resource('_projectiles', { list: [] });
game.resource('_waveDelay', { timer: 0, waiting: false, allSpawned: false });

// ── Helpers ─────────────────────────────────────────────────────────

function hasTowerAt(towers, r, c) {
  return towers.list.some(t => t.r === r && t.c === c);
}

function cellIdx(r, c) { return r * GRID_W + c; }

/** Score a position for AI tower placement — higher near path bends. */
function scorePlacement(grid, path, r, c) {
  if (grid[cellIdx(r, c)] !== TILE_BUILDABLE) return -1;

  let score = 0;
  // Count path cells within tower range
  for (const p of path) {
    const dr = Math.abs(p.r - r);
    const dc = Math.abs(p.c - c);
    const dist = Math.sqrt(dr * dr + dc * dc);
    if (dist <= TOWER_RANGE) {
      score += (TOWER_RANGE - dist + 1);
    }
  }

  // Bonus for proximity to path bends
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const curr = path[i];
    const next = path[i + 1];
    const isBend = (prev.r !== next.r) && (prev.c !== next.c);
    if (isBend) {
      const dist = Math.sqrt((curr.r - r) ** 2 + (curr.c - c) ** 2);
      if (dist <= TOWER_RANGE + 1) {
        score += 5;
      }
    }
  }

  return score;
}

// ── Map Init System ─────────────────────────────────────────────────

game.system('mapInit', function mapInitSystem(world, _dt) {
  const map = world.getResource('map');
  if (map.initialized) return;
  map.initialized = true;

  const result = generateTDMap(GRID_W, GRID_H);
  map.grid = result.grid;
  map.path = result.path;

  // Initialize wave manager
  const wave = world.getResource('wave');
  wave.manager = createWaveManager({
    spawnInterval: SPAWN_INTERVAL,
    enemiesPerWave: ENEMIES_BASE,
    waveDelay: WAVE_DELAY,
  });

  // Start first wave
  wave.manager.waveNumber = 1;
  wave.manager.enemies = 0;
  wave.manager.spawnTimer = 0;

  const wd = world.getResource('_waveDelay');
  wd.waiting = false;
  wd.allSpawned = false;
});

// ── Player Input System ─────────────────────────────────────────────

game.system('playerInput', function playerInputSystem(world, _dt) {
  const gm = world.getResource('gameMode');
  if (!gm || gm.mode !== 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const input = world.getResource('input');
  const cursor = world.getResource('_cursor');
  const map = world.getResource('map');
  const towers = world.getResource('towers');

  if (consumeAction(input, 'up') && cursor.r > 0) cursor.r--;
  if (consumeAction(input, 'down') && cursor.r < GRID_H - 1) cursor.r++;
  if (consumeAction(input, 'left') && cursor.c > 0) cursor.c--;
  if (consumeAction(input, 'right') && cursor.c < GRID_W - 1) cursor.c++;

  if (consumeAction(input, 'select')) {
    const tile = map.grid[cellIdx(cursor.r, cursor.c)];
    if (tile === TILE_BUILDABLE && !hasTowerAt(towers, cursor.r, cursor.c)) {
      if (state.gold >= state.towerCost) {
        state.gold -= state.towerCost;
        towers.list.push({
          r: cursor.r,
          c: cursor.c,
          x: cursor.c,
          y: cursor.r,
          range: TOWER_RANGE,
          damage: TOWER_DAMAGE,
          fireRate: TOWER_FIRE_RATE,
          fireTimer: 0,
          level: 1,
        });
        state.message = 'Tower placed!';
        state.score += 5;
      } else {
        state.message = 'Not enough gold!';
      }
    } else if (tile !== TILE_BUILDABLE) {
      state.message = 'Cannot build here!';
    }
  }
});

// ── AI System ───────────────────────────────────────────────────────

game.system('ai', function aiSystem(world, dt) {
  const gm = world.getResource('gameMode');
  if (gm && gm.mode === 'playerVsAi') return;

  const state = world.getResource('state');
  if (state.gameOver) return;

  const timer = world.getResource('_aiTimer');
  timer.elapsed += dt;
  if (timer.elapsed < AI_INTERVAL) return;
  timer.elapsed = 0;

  const map = world.getResource('map');
  const towers = world.getResource('towers');
  const cursor = world.getResource('_cursor');

  if (state.gold < state.towerCost) return;

  // Find best placement
  let bestScore = -1;
  let bestR = -1;
  let bestC = -1;

  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (hasTowerAt(towers, r, c)) continue;
      const s = scorePlacement(map.grid, map.path, r, c);
      if (s > bestScore) {
        bestScore = s;
        bestR = r;
        bestC = c;
      }
    }
  }

  if (bestScore > 0 && bestR >= 0) {
    cursor.r = bestR;
    cursor.c = bestC;
    state.gold -= state.towerCost;
    towers.list.push({
      r: bestR,
      c: bestC,
      x: bestC,
      y: bestR,
      range: TOWER_RANGE,
      damage: TOWER_DAMAGE,
      fireRate: TOWER_FIRE_RATE,
      fireTimer: 0,
      level: 1,
    });
    state.message = `AI placed tower at (${bestR},${bestC})`;
    state.score += 5;
  }
});

// ── Wave System ─────────────────────────────────────────────────────

game.system('waveSystem', function waveSystem(world, dt) {
  const state = world.getResource('state');
  if (state.gameOver) return;

  const wave = world.getResource('wave');
  if (!wave.manager) return;

  const map = world.getResource('map');
  const enemies = world.getResource('enemies');
  const wd = world.getResource('_waveDelay');

  // Between-wave delay
  if (wd.waiting) {
    wd.timer -= dt;
    if (wd.timer > 0) {
      state.message = `Next wave in ${Math.ceil(wd.timer / 1000)}...`;
      return;
    }
    wd.waiting = false;
    wd.allSpawned = false;

    // Start next wave
    wave.manager.waveNumber++;
    wave.manager.enemies = 0;
    wave.manager.spawnTimer = 0;
    wave.manager.enemiesPerWave = ENEMIES_BASE + Math.floor(wave.manager.waveNumber * 1.5);
    wave.manager.spawnInterval = Math.max(0.3, SPAWN_INTERVAL - wave.manager.waveNumber * 0.03);
    state.message = `Wave ${wave.manager.waveNumber} incoming!`;
  }

  if (wd.allSpawned) {
    // Wait for all enemies to be dead or reach base
    const aliveCount = enemies.list.filter(e => e.alive).length;
    if (aliveCount === 0) {
      wd.waiting = true;
      wd.timer = WAVE_DELAY * 1000;
      state.message = 'Wave cleared!';
    }
    return;
  }

  // Tick the wave to potentially spawn enemies
  const dtSec = dt / 1000;
  const result = tickWave(wave.manager, dtSec);

  if (result.shouldSpawn && map.path.length > 0) {
    const waveNum = wave.manager.waveNumber;
    const hp = 30 + waveNum * 15;
    const speed = 1.5 + waveNum * 0.1;
    const reward = 8 + Math.floor(waveNum * 2);
    const enemy = spawnEnemy(map.path, hp, speed, reward);
    enemies.list.push(enemy);
  }

  if (result.waveComplete) {
    wd.allSpawned = true;
  }
});

// ── Enemy Movement System ───────────────────────────────────────────

game.system('enemyMovement', function enemyMovementSystem(world, dt) {
  const state = world.getResource('state');
  if (state.gameOver) return;

  const map = world.getResource('map');
  const enemies = world.getResource('enemies');
  const dtSec = dt / 1000;

  for (const enemy of enemies.list) {
    if (!enemy.alive) continue;

    const reachedEnd = moveEnemy(enemy, map.path, dtSec);
    if (reachedEnd) {
      enemy.alive = false;
      state.lives--;
      state.message = `Life lost! ${state.lives} remaining`;

      if (state.lives <= 0) {
        state.gameOver = true;
        state.message = 'Base destroyed! Game Over!';
      }
    }
  }

  // Clean up dead enemies that have been off-screen for a while
  if (enemies.list.length > 50) {
    enemies.list = enemies.list.filter(e => e.alive);
  }
});

// ── Tower Firing System ─────────────────────────────────────────────

game.system('towerFiring', function towerFiringSystem(world, dt) {
  const state = world.getResource('state');
  if (state.gameOver) return;

  const towers = world.getResource('towers');
  const enemies = world.getResource('enemies');
  const projectiles = world.getResource('_projectiles');

  const aliveEnemies = enemies.list.filter(e => e.alive);
  if (aliveEnemies.length === 0) return;

  for (const tower of towers.list) {
    tower.fireTimer -= dt;
    if (tower.fireTimer > 0) continue;

    // Find targets in range
    const targets = findTargetsInRange([tower], aliveEnemies, tower.range);
    const target = targets.get(tower);
    if (!target) continue;

    tower.fireTimer = tower.fireRate;
    const result = towerAttack(tower, target, tower.damage * tower.level);

    // Create projectile visual
    projectiles.list.push({
      x1: tower.c * CELL + CELL / 2,
      y1: tower.r * CELL + CELL / 2,
      x2: target.x * CELL + CELL / 2,
      y2: target.y * CELL + CELL / 2,
      timer: 150,
      hit: result.killed,
    });

    if (result.killed) {
      state.gold += result.reward;
      state.score += result.reward * 2;
      state.message = `Enemy killed! +${result.reward}g`;
    }
  }

  // Decay projectile visuals
  projectiles.list = projectiles.list.filter(p => {
    p.timer -= dt;
    return p.timer > 0;
  });
});

// ── Render System ───────────────────────────────────────────────────

game.system('render', function renderSystem(world, _dt) {
  const renderer = world.getResource('renderer');
  if (!renderer) return;

  const { ctx } = renderer;
  const state = world.getResource('state');
  const map = world.getResource('map');
  const towers = world.getResource('towers');
  const enemies = world.getResource('enemies');
  const wave = world.getResource('wave');
  const cursor = world.getResource('_cursor');
  const projectiles = world.getResource('_projectiles');

  clearCanvas(ctx, '#2a2a2a');

  if (!map.initialized) return;

  // ── Draw grid tiles ───────────────────────────────────────────
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const tile = map.grid[cellIdx(r, c)];
      const x = c * CELL;
      const y = r * CELL;
      const color = TILE_COLORS[tile] || '#333';

      drawRoundedRect(ctx, x + 1, y + 1, CELL - 2, CELL - 2, 2, color);

      // Subtle grid lines
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, CELL, CELL);
    }
  }

  // ── Draw path direction indicators ────────────────────────────
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  for (let i = 0; i < map.path.length - 1; i++) {
    const curr = map.path[i];
    const next = map.path[i + 1];
    const cx = curr.c * CELL + CELL / 2;
    const cy = curr.r * CELL + CELL / 2;
    const nx = next.c * CELL + CELL / 2;
    const ny = next.r * CELL + CELL / 2;
    const mx = (cx + nx) / 2;
    const my = (cy + ny) / 2;
    ctx.beginPath();
    ctx.arc(mx, my, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Draw towers ───────────────────────────────────────────────
  for (const tower of towers.list) {
    const tx = tower.c * CELL + 4;
    const ty = tower.r * CELL + 4;
    const ts = CELL - 8;

    // Tower base
    drawRoundedRect(ctx, tx, ty, ts, ts, 4, '#2196F3', {
      strokeColor: '#1565C0',
      strokeWidth: 2,
    });

    // Tower level indicator
    if (tower.level > 1) {
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${tower.level}`, tx + ts / 2, ty + ts / 2);
    } else {
      // Draw a small diamond in center
      const cx = tx + ts / 2;
      const cy = ty + ts / 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 4);
      ctx.lineTo(cx + 4, cy);
      ctx.lineTo(cx, cy + 4);
      ctx.lineTo(cx - 4, cy);
      ctx.closePath();
      ctx.fillStyle = '#BBDEFB';
      ctx.fill();
    }

    // Range circle when cursor is on this tower
    if (cursor.r === tower.r && cursor.c === tower.c) {
      ctx.beginPath();
      ctx.arc(
        tower.c * CELL + CELL / 2,
        tower.r * CELL + CELL / 2,
        tower.range * CELL,
        0, Math.PI * 2
      );
      ctx.strokeStyle = 'rgba(33,150,243,0.35)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(33,150,243,0.08)';
      ctx.fill();
    }
  }

  // ── Draw enemies ──────────────────────────────────────────────
  for (const enemy of enemies.list) {
    if (!enemy.alive) continue;

    const ex = enemy.x * CELL + CELL / 2;
    const ey = enemy.y * CELL + CELL / 2;
    const radius = CELL * 0.35;

    // Enemy body
    drawCircle(ctx, ex, ey, radius, '#E53935', {
      strokeColor: '#B71C1C',
      strokeWidth: 1.5,
    });

    // HP bar background
    const barW = CELL - 6;
    const barH = 4;
    const barX = ex - barW / 2;
    const barY = ey - radius - 7;

    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barW, barH);

    // HP bar fill
    const hpRatio = Math.max(0, enemy.hp / enemy.maxHp);
    const hpColor = hpRatio > 0.5 ? '#4CAF50' : hpRatio > 0.25 ? '#FF9800' : '#E53935';
    ctx.fillStyle = hpColor;
    ctx.fillRect(barX, barY, barW * hpRatio, barH);

    // HP bar border
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(barX, barY, barW, barH);
  }

  // ── Draw projectile lines ─────────────────────────────────────
  for (const proj of projectiles.list) {
    const alpha = Math.min(1, proj.timer / 80);
    ctx.strokeStyle = proj.hit
      ? `rgba(255,235,59,${alpha})`
      : `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = proj.hit ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(proj.x1, proj.y1);
    ctx.lineTo(proj.x2, proj.y2);
    ctx.stroke();

    // Impact flash
    if (proj.hit && proj.timer > 100) {
      drawCircle(ctx, proj.x2, proj.y2, 6, `rgba(255,235,59,${alpha * 0.6})`);
    }
  }

  // ── Draw cursor ───────────────────────────────────────────────
  if (!state.gameOver) {
    const cx = cursor.c * CELL;
    const cy = cursor.r * CELL;
    const tile = map.grid[cellIdx(cursor.r, cursor.c)];
    const canBuild = tile === TILE_BUILDABLE && !hasTowerAt(towers, cursor.r, cursor.c);

    ctx.strokeStyle = canBuild ? '#76FF03' : '#FF5252';
    ctx.lineWidth = 2;
    ctx.strokeRect(cx + 1, cy + 1, CELL - 2, CELL - 2);

    // Preview ghost tower
    if (canBuild && state.gold >= state.towerCost) {
      ctx.globalAlpha = 0.4;
      drawRoundedRect(ctx, cx + 4, cy + 4, CELL - 8, CELL - 8, 4, '#2196F3');

      // Preview range
      ctx.beginPath();
      ctx.arc(cx + CELL / 2, cy + CELL / 2, TOWER_RANGE * CELL, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(33,150,243,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ── Draw HUD ──────────────────────────────────────────────────
  // HUD background
  drawRoundedRect(ctx, HUD_X, 0, HUD_W, H, 0, '#1a1a2a');

  const hx = HUD_X + 6;
  let hy = 12;

  drawLabel(ctx, 'TOWER DEFENSE', hx, hy, { color: '#42A5F5', fontSize: 13 });
  hy += 24;

  // Wave info
  const waveNum = wave.manager ? wave.manager.waveNumber : 0;
  drawLabel(ctx, `Wave: ${waveNum}`, hx, hy, { color: '#fff', fontSize: 12 });
  hy += 20;

  // Gold
  drawLabel(ctx, `Gold: ${state.gold}`, hx, hy, { color: '#FFD700', fontSize: 12 });
  hy += 20;

  // Lives
  drawLabel(ctx, `Lives: ${state.lives}`, hx, hy, { color: '#E53935', fontSize: 12 });
  hy += 20;

  // Score
  drawLabel(ctx, `Score: ${state.score}`, hx, hy, { color: '#aaa', fontSize: 12 });
  hy += 20;

  // Tower cost
  drawLabel(ctx, `Tower: ${state.towerCost}g`, hx, hy, { color: '#90CAF9', fontSize: 11 });
  hy += 20;

  // Enemies alive
  const aliveEnemies = enemies.list.filter(e => e.alive).length;
  drawLabel(ctx, `Enemies: ${aliveEnemies}`, hx, hy, { color: '#EF9A9A', fontSize: 11 });
  hy += 20;

  // Towers placed
  drawLabel(ctx, `Towers: ${towers.list.length}`, hx, hy, { color: '#90CAF9', fontSize: 11 });
  hy += 28;

  // Divider
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.lineTo(HUD_X + HUD_W - 6, hy);
  ctx.stroke();
  hy += 12;

  // Message
  ctx.font = '11px monospace';
  ctx.fillStyle = '#7ec8e3';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const words = state.message.split(' ');
  let line = '';
  const maxW = HUD_W - 12;
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, hx, hy);
      hy += 14;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, hx, hy);
  hy += 24;

  // Legend
  drawLabel(ctx, 'Legend:', hx, hy, { color: '#888', fontSize: 10 });
  hy += 16;

  const legend = [
    { color: '#4a7c59', label: 'Buildable' },
    { color: '#8B7355', label: 'Path' },
    { color: '#2196F3', label: 'Tower' },
    { color: '#E53935', label: 'Enemy' },
  ];
  for (const item of legend) {
    drawRoundedRect(ctx, hx, hy, 10, 10, 2, item.color);
    ctx.font = '10px monospace';
    ctx.fillStyle = '#aaa';
    ctx.textAlign = 'left';
    ctx.fillText(item.label, hx + 16, hy + 1);
    hy += 16;
  }

  hy += 12;
  // Controls
  drawLabel(ctx, 'Controls:', hx, hy, { color: '#888', fontSize: 10 });
  hy += 16;
  const controls = [
    'Arrows: Move',
    'Space: Place',
    'R: Restart',
  ];
  for (const ctrl of controls) {
    ctx.font = '10px monospace';
    ctx.fillStyle = '#666';
    ctx.fillText(ctrl, hx, hy);
    hy += 14;
  }

  // ── Game Over overlay ─────────────────────────────────────────
  if (state.gameOver) {
    const won = state.lives > 0;
    drawGameOver(ctx, 0, 0, GRID_W * CELL, H, {
      title: won ? 'VICTORY!' : 'GAME OVER',
      titleColor: won ? '#4CAF50' : '#E53935',
      subtitle: `Score: ${state.score} | Wave: ${waveNum} | Press R`,
    });
  }

  drawTouchOverlay(ctx, ctx.canvas.width, ctx.canvas.height);
});

export default game;
