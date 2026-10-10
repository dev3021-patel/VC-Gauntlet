import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  constrainCamera,
  fitWorld,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
  type Size,
} from './viewport'

const viewport: Size = { width: 1000, height: 700 }
const camera: Camera = { centerX: 128, centerY: 128, zoom: 2 }

describe('viewport transforms', () => {
  it('round-trips between world and screen coordinates', () => {
    const worldPoint = { x: 43.5, y: 211.25 }
    const screenPoint = worldToScreen(worldPoint, camera, viewport)

    expect(screenToWorld(screenPoint, camera, viewport)).toEqual(worldPoint)
  })

  it('keeps the pointer world position anchored while zooming', () => {
    const anchor = { x: 237, y: 511 }
    const before = screenToWorld(anchor, camera, viewport)
    const zoomed = zoomAt(camera, 7.5, anchor, viewport)
    const after = screenToWorld(anchor, zoomed, viewport)

    expect(after.x).toBeCloseTo(before.x, 10)
    expect(after.y).toBeCloseTo(before.y, 10)
  })

  it('clamps zoom to the configured bounds', () => {
    expect(zoomAt(camera, 0.01, { x: 500, y: 350 }, viewport).zoom).toBe(DEFAULT_LIMITS.minZoom)
    expect(zoomAt(camera, 100, { x: 500, y: 350 }, viewport).zoom).toBe(DEFAULT_LIMITS.maxZoom)
  })

  it('fits and centers the complete world with padding', () => {
    const fitted = fitWorld({ width: 256, height: 256 }, viewport, 50)

    expect(fitted.centerX).toBe(128)
    expect(fitted.centerY).toBe(128)
    expect(fitted.zoom).toBeCloseTo(600 / 256)
  })

  it('constrains panning while allowing a fixed screen-space overscroll', () => {
    const world = { width: 256, height: 256 }
    const closeViewport = { width: 500, height: 400 }
    const constrained = constrainCamera(
      { centerX: -10_000, centerY: 10_000, zoom: 4 },
      world,
      closeViewport,
    )

    expect(constrained.centerX).toBe(40.5)
    expect(constrained.centerY).toBe(228)
  })

  it('keeps a small world recoverable at minimum zoom', () => {
    const constrained = constrainCamera(
      { centerX: 99_999, centerY: -99_999, zoom: DEFAULT_LIMITS.minZoom },
      { width: 256, height: 256 },
      viewport,
    )

    expect(Number.isFinite(constrained.centerX)).toBe(true)
    expect(Number.isFinite(constrained.centerY)).toBe(true)
    expect(constrained.centerX).toBeLessThan(2_000)
    expect(constrained.centerY).toBeGreaterThan(-2_000)
  })

  it('renders square grid units uniformly without axis stretching across window resizes', () => {
    const world = { width: 256, height: 256 }
    const aspectRatios: Size[] = [
      { width: 1920, height: 1080 }, // 16:9
      { width: 1080, height: 1920 }, // 9:16 portrait
      { width: 800, height: 800 },   // 1:1 square
      { width: 2560, height: 1440 }, // wide
      { width: 375, height: 667 },   // mobile
    ]

    for (const view of aspectRatios) {
      const fitted = fitWorld(world, view)
      // A 1x1 grid cell world coordinates transform to screen with equal width and height
      const p1 = worldToScreen({ x: 10, y: 10 }, fitted, view)
      const p2 = worldToScreen({ x: 11, y: 11 }, fitted, view)
      const cellWidth = p2.x - p1.x
      const cellHeight = p2.y - p1.y
      expect(cellWidth).toBeCloseTo(cellHeight, 10)
      expect(cellWidth).toBeCloseTo(fitted.zoom, 10)
    }
  })
})
