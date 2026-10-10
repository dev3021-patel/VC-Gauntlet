export type Point = Readonly<{ x: number; y: number }>
export type Size = Readonly<{ width: number; height: number }>
export type Camera = Readonly<{ centerX: number; centerY: number; zoom: number }>
export type WorldBounds = Readonly<{ width: number; height: number }>

export type ViewportLimits = Readonly<{
  minZoom: number
  maxZoom: number
  overscrollPx: number
}>

export const DEFAULT_LIMITS: ViewportLimits = {
  minZoom: 0.35,
  maxZoom: 32,
  overscrollPx: 88,
}

export function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value))
}

export function worldToScreen(point: Point, camera: Camera, viewport: Size): Point {
  return {
    x: (point.x - camera.centerX) * camera.zoom + viewport.width / 2,
    y: (point.y - camera.centerY) * camera.zoom + viewport.height / 2,
  }
}

export function screenToWorld(point: Point, camera: Camera, viewport: Size): Point {
  return {
    x: camera.centerX + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.centerY + (point.y - viewport.height / 2) / camera.zoom,
  }
}

export function zoomAt(
  camera: Camera,
  targetZoom: number,
  anchor: Point,
  viewport: Size,
  limits: ViewportLimits = DEFAULT_LIMITS,
): Camera {
  const anchorWorld = screenToWorld(anchor, camera, viewport)
  const zoom = clamp(targetZoom, limits.minZoom, limits.maxZoom)

  return {
    centerX: anchorWorld.x - (anchor.x - viewport.width / 2) / zoom,
    centerY: anchorWorld.y - (anchor.y - viewport.height / 2) / zoom,
    zoom,
  }
}

export function fitWorld(
  world: WorldBounds,
  viewport: Size,
  padding = 40,
  limits: ViewportLimits = DEFAULT_LIMITS,
): Camera {
  const usableWidth = Math.max(1, viewport.width - padding * 2)
  const usableHeight = Math.max(1, viewport.height - padding * 2)
  const zoom = clamp(
    Math.min(usableWidth / world.width, usableHeight / world.height),
    limits.minZoom,
    limits.maxZoom,
  )

  return {
    centerX: world.width / 2,
    centerY: world.height / 2,
    zoom,
  }
}

function constrainAxis(
  center: number,
  worldLength: number,
  viewportLength: number,
  zoom: number,
  overscrollPx: number,
) {
  const visibleHalf = viewportLength / (2 * zoom)
  const overscroll = overscrollPx / zoom
  const leadingLimit = visibleHalf - overscroll
  const trailingLimit = worldLength - visibleHalf + overscroll

  return clamp(center, Math.min(leadingLimit, trailingLimit), Math.max(leadingLimit, trailingLimit))
}

export function constrainCamera(
  camera: Camera,
  world: WorldBounds,
  viewport: Size,
  limits: ViewportLimits = DEFAULT_LIMITS,
): Camera {
  const zoom = clamp(camera.zoom, limits.minZoom, limits.maxZoom)

  return {
    centerX: constrainAxis(camera.centerX, world.width, viewport.width, zoom, limits.overscrollPx),
    centerY: constrainAxis(camera.centerY, world.height, viewport.height, zoom, limits.overscrollPx),
    zoom,
  }
}

export function panBy(camera: Camera, deltaScreen: Point): Camera {
  return {
    ...camera,
    centerX: camera.centerX - deltaScreen.x / camera.zoom,
    centerY: camera.centerY - deltaScreen.y / camera.zoom,
  }
}
