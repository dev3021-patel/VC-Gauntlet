import type { Camera, Size } from './viewport'
import { MOVEMENT_BLOCK_SIZE, movementBlockTerrain, MOVEMENT_WORLD, WORLD } from './terrain'

export { WORLD } from './terrain'

/** Pixel art stays inside the exact solid block; no invisible collision fringe. */
const TREE_SPRITES = [
  [
    '..gGG...',
    '.gGhGGg.',
    'gGGLGGg.',
    '.gGGDGg.',
    '..gGg...',
    '...lT...',
    '...TT...',
    '..ssss..',
  ],
  [
    '.gGg....',
    'gGhGGg..',
    'gGLGGLg.',
    '.gGGgDg.',
    '..gGg...',
    '...lT...',
    '...TT...',
    '..sss...',
  ],
  [
    '...gGG..',
    '..gGGhG.',
    '.gGLGGg.',
    '..gGDgg.',
    '...gGg..',
    '...lT...',
    '...TT...',
    '...sss..',
  ],
] as const

const TREE_COLORS: Record<string, string> = {
  g: '#1b4a30',
  G: '#2f7a42',
  L: '#5aaa58',
  h: '#9ed56a',
  D: '#17442c',
  l: '#c4894e',
  T: '#7a4e2c',
  s: '#2a3828',
}

const BARRICADE_COLORS: Record<string, string> = {
  m: '#f4f0e4',
  w: '#e8c078',
  d: '#a56b32',
  x: '#2a140c',
  p: '#3e2412',
  s: '#243028',
}

/** Organic canopy, trunk, and ground shadow. Empty cells stay grass so the silhouette is not a square. */
export function treeOverlay(blockX: number, blockY: number): (string | null)[][] {
  const sprite = TREE_SPRITES[(blockX + blockY * 2) % TREE_SPRITES.length]
  return sprite.map((row) => [...row].map((cell) => TREE_COLORS[cell] ?? null))
}

/**
 * Spiked crossed-log barricade. Horizontal neighbors share the binding logs
 * so a pair reads as one barrier; outer ends keep posts.
 */
export function barricadeOverlay(blockX: number, blockY: number): (string | null)[][] {
  const left = movementBlockTerrain(blockX - 1, blockY) === 'barricade'
  const right = movementBlockTerrain(blockX + 1, blockY) === 'barricade'
  const rows = Array.from({ length: MOVEMENT_BLOCK_SIZE }, () => Array<string | null>(MOVEMENT_BLOCK_SIZE).fill(null))
  const paint = (x: number, y: number, color: string) => {
    if (x >= 0 && x < MOVEMENT_BLOCK_SIZE && y >= 0 && y < MOVEMENT_BLOCK_SIZE) rows[y][x] = color
  }

  // Two-pixel-thick X. Neighboring cells meet on the open edge instead of growing a post.
  for (let i = 0; i < 6; i += 1) {
    paint(i + 1, i + 1, BARRICADE_COLORS.x)
    paint(i + 2, i + 1, BARRICADE_COLORS.x)
    paint(6 - i, i + 1, BARRICADE_COLORS.x)
    paint(5 - i, i + 1, BARRICADE_COLORS.x)
  }
  for (const spike of [1, 6]) {
    paint(spike, 0, BARRICADE_COLORS.m)
    paint(spike, 1, BARRICADE_COLORS.w)
  }
  paint(3, 6, BARRICADE_COLORS.w)
  paint(4, 6, BARRICADE_COLORS.d)
  if (right) paint(7, 3, BARRICADE_COLORS.x)
  if (left) paint(0, 3, BARRICADE_COLORS.x)
  if (!left) for (let y = 1; y <= 6; y += 1) paint(0, y, BARRICADE_COLORS.p)
  if (!right) for (let y = 1; y <= 6; y += 1) paint(7, y, BARRICADE_COLORS.p)
  for (let x = 1; x <= 6; x += 1) paint(x, 7, BARRICADE_COLORS.s)
  return rows
}

/** Base grass color painted under every non-water block; reused by presentation effects that must match it. */
export function grassColor(blockX: number, blockY: number) {
  return blockY % (MOVEMENT_WORLD.height / 2) > 26 ? '#7c8852' : '#63945c'
}

export const GRASS_SPECK_COLOR = '#86ad6b'

export function createTerrainCanvas() {
  const terrain = document.createElement('canvas')
  terrain.width = WORLD.width
  terrain.height = WORLD.height
  const context = terrain.getContext('2d')
  if (!context) return terrain
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    context.fillStyle = color
    context.fillRect(x, y, w, h)
  }
  for (let y = 0; y < MOVEMENT_WORLD.height; y += 1) {
    for (let x = 0; x < MOVEMENT_WORLD.width; x += 1) {
      const kind = movementBlockTerrain(x, y)
      const px = x * MOVEMENT_BLOCK_SIZE, py = y * MOVEMENT_BLOCK_SIZE
      rect(px, py, 8, 8, kind === 'water' ? '#123e50' : grassColor(x, y))
      if (kind === 'land') {
        rect(px + (x * 3 + y) % 7, py + (y * 3 + x) % 7, 1, 1, GRASS_SPECK_COLOR)
      } else if (kind === 'water') {
        rect(px + 2, py + (y % 3) + 2, 4, 1, '#276479')
      } else if (kind === 'bridge') {
        rect(px, py, 8, 8, '#b59260')
        for (let plank = 0; plank < 8; plank += 2) rect(px + plank, py, 1, 8, '#755437')
        if (movementBlockTerrain(x, y - 1) !== 'bridge') rect(px, py, 8, 1, '#e2c491')
        if (movementBlockTerrain(x, y + 1) !== 'bridge') rect(px, py + 7, 8, 1, '#e2c491')
      } else if (kind === 'courtyard') {
        rect(px, py, 8, 8, '#9a9882')
        rect(px, py, 8, 1, '#777b71')
        rect(px + (y % 2) * 4, py, 1, 8, '#777b71')
      } else if (kind === 'wall') {
        rect(px, py, 8, 8, '#39464b')
        rect(px, py, 7, 6, '#9ca9ad')
        rect(px + 1, py + 3, 6, 1, '#63747a')
        rect(px + 3, py, 1, 3, '#63747a')
        rect(px, py, 2, 2, '#d4d9cc')
        rect(px + 5, py, 2, 2, '#d4d9cc')
      } else if (kind === 'tree' || kind === 'barricade') {
        const overlay = kind === 'tree' ? treeOverlay(x, y) : barricadeOverlay(x, y)
        for (let row = 0; row < overlay.length; row += 1) {
          for (let col = 0; col < overlay[row].length; col += 1) {
            const color = overlay[row][col]
            if (color) rect(px + col, py + row, 1, 1, color)
          }
        }
      }
    }
  }
  return terrain
}

/** Below this zoom the atomic grid is too dense to read, so it is hidden rather than coarsened. */
export const MIN_GRID_ZOOM = 1.5

/** The grid always marks atomic movement cells; returns null when zoomed out too far to show it. */
export function getGridStep(zoom: number): number | null {
  return zoom >= MIN_GRID_ZOOM ? MOVEMENT_BLOCK_SIZE : null
}

/** The backing-store density the map is painted at; a change requires a repaint. */
export function mapPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 3)
}

/** Paints the static map (backdrop, terrain, shadow, grid). Returns whether anything was painted. */
export function drawMap(
  canvas: HTMLCanvasElement,
  terrain: HTMLCanvasElement,
  camera: Camera,
  viewport: Size,
) {
  const context = canvas.getContext('2d')
  if (!context || viewport.width <= 0 || viewport.height <= 0) return false

  const dpr = mapPixelRatio()
  const targetWidth = Math.round(viewport.width * dpr)
  const targetHeight = Math.round(viewport.height * dpr)
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0)
  const backdrop = context.createRadialGradient(
    viewport.width * 0.48,
    viewport.height * 0.42,
    30,
    viewport.width * 0.48,
    viewport.height * 0.42,
    Math.max(viewport.width, viewport.height) * 0.8,
  )
  backdrop.addColorStop(0, '#133128')
  backdrop.addColorStop(1, '#050b09')
  context.fillStyle = backdrop
  context.fillRect(0, 0, viewport.width, viewport.height)

  context.save()
  context.translate(
    viewport.width / 2 - camera.centerX * camera.zoom,
    viewport.height / 2 - camera.centerY * camera.zoom,
  )
  context.scale(camera.zoom, camera.zoom)
  context.imageSmoothingEnabled = false

  context.shadowColor = 'rgba(0, 0, 0, 0.72)'
  context.shadowBlur = 24 / camera.zoom
  context.shadowOffsetY = 10 / camera.zoom
  context.drawImage(terrain, 0, 0)
  context.shadowColor = 'transparent'

  const gridStep = getGridStep(camera.zoom)
  if (gridStep !== null) {
    context.beginPath()
    for (let x = 0; x <= WORLD.width; x += gridStep) {
      context.moveTo(x, 0)
      context.lineTo(x, WORLD.height)
    }
    for (let y = 0; y <= WORLD.height; y += gridStep) {
      context.moveTo(0, y)
      context.lineTo(WORLD.width, y)
    }
    context.strokeStyle = 'rgba(5, 18, 14, 0.32)'
    context.lineWidth = 1 / camera.zoom
    context.stroke()
  }

  context.strokeStyle = '#d9ff9a'
  context.lineWidth = 2 / camera.zoom
  context.strokeRect(0, 0, WORLD.width, WORLD.height)

  context.restore()
  return true
}
