import { memo, useEffect, useRef, useState } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  Sphere,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EARTH_RADIUS_KM, VERSION_ORDER, versionColor } from '../../lib/starlink'
import type { MapLayer, MapViewProps } from './StarlinkMap'
import { MapTooltip } from './StarlinkMap2D'

/**
 * The 3D view: one THREE.Points for the whole constellation over a dark
 * globe, at true altitude scale (radius 1 = the WGS-84 equatorial radius
 * the worker's geodetic heights are measured from), so the shells read
 * as the thin skin they really are rather than an exaggerated halo.
 *
 * Lazy-loaded on the 3D toggle — three.js is most of this chunk's weight and
 * most visitors never leave the flat map. Each tick rewrites one position
 * attribute in place; nothing is allocated per frame.
 */

const DEG = Math.PI / 180
const HIT_RADIUS_PX = 7
const FOCUS_MS = 700
/** Auto-rotation waits this long after the user lets go before resuming. */
const IDLE_RESUME_MS = 5_000

type GlobeProps = MapViewProps & {
  /** Off-screen: stop rendering, not just ticking. */
  visible: boolean
  /** WebGL failed to start; the parent falls back to the flat map. */
  onUnavailable: () => void
}

/** Geodetic → scene. Y is up (north), and longitude increases eastward seen from outside. */
function toScene(lon: number, lat: number, heightKm: number, out: Float32Array | number[], o: number) {
  const r = 1 + heightKm / EARTH_RADIUS_KM
  const la = lat * DEG
  const lo = lon * DEG
  const c = Math.cos(la)
  out[o] = r * c * Math.cos(lo)
  out[o + 1] = r * Math.sin(la)
  out[o + 2] = -r * c * Math.sin(lo)
}

/** Dark sphere with a faint accent rim, so the limb reads against the background. */
function earthMaterial() {
  return new ShaderMaterial({
    uniforms: {
      base: { value: new Color('#0e1117') },
      rim: { value: new Color('#38bdf8') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 base;
      uniform vec3 rim;
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        float f = pow(1.0 - max(dot(vNormal, vView), 0.0), 3.0);
        gl_FragColor = vec4(base + rim * f * 0.35, 1.0);
        // Uniform colours are linear; convert like the built-in materials do.
        #include <colorspace_fragment>
      }
    `,
  })
}

function lineGeometry(segments: number[]) {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(segments, 3))
  return g
}

/** Coastline polylines as segment pairs, lifted just off the surface to avoid z-fighting. */
function coastSegments(lines: number[][][]): number[] {
  const out: number[] = []
  const a = [0, 0, 0]
  const b = [0, 0, 0]
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      toScene(line[k - 1][0], line[k - 1][1], 6, a, 0)
      toScene(line[k][0], line[k][1], 6, b, 0)
      out.push(a[0], a[1], a[2], b[0], b[1], b[2])
    }
  }
  return out
}

/** 30° graticule, sampled every 2° so it follows the curvature. */
function gridSegments(): number[] {
  const out: number[] = []
  const a = [0, 0, 0]
  const b = [0, 0, 0]
  const push = (lon1: number, lat1: number, lon2: number, lat2: number) => {
    toScene(lon1, lat1, 3, a, 0)
    toScene(lon2, lat2, 3, b, 0)
    out.push(a[0], a[1], a[2], b[0], b[1], b[2])
  }
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 2) push(lon, lat, lon + 2, lat)
  for (let lon = -180; lon < 180; lon += 30) for (let lat = -88; lat < 88; lat += 2) push(lon, lat, lon, lat + 2)
  return out
}

/** White ring with a centre dot, for the selected satellite's marker sprite. */
function ringTexture() {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 5
    ctx.beginPath()
    ctx.arc(32, 32, 24, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(32, 32, 8, 0, Math.PI * 2)
    ctx.fill()
  }
  return new CanvasTexture(c)
}

interface Globe {
  renderer: WebGLRenderer
  scene: Scene
  camera: PerspectiveCamera
  controls: OrbitControls
  earth: Mesh
  points: Points<BufferGeometry, PointsMaterial>
  marker: Points<BufferGeometry, PointsMaterial>
  track: LineSegments<BufferGeometry, LineBasicMaterial>
  coast: LineSegments<BufferGeometry, LineBasicMaterial>
  raycaster: Raycaster
  /** Camera swing toward a newly selected satellite. */
  focus: { from: Vector3; to: Vector3; start: number } | null
  interacting: boolean
  idleTimer: number | undefined
  frame: number | undefined
  height: number
}

export const StarlinkGlobe3D = memo(function StarlinkGlobe3D({
  layer,
  positions,
  shown,
  selectedIndex,
  track,
  onSelect,
  label,
  reducedMotion,
  visible,
  onUnavailable,
}: GlobeProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const globeRef = useRef<Globe | null>(null)
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // Pointer handlers and the render loop read the latest props through this.
  const latest = useRef({ layer, positions, selectedIndex, onSelect, reducedMotion })
  latest.current = { layer, positions, selectedIndex, onSelect, reducedMotion }

  /* ------------------------------ set-up / teardown ----------------------------- */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ antialias: true })
    } catch {
      onUnavailable()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor('#090b10')
    renderer.domElement.className = 'absolute inset-0 size-full'
    renderer.domElement.setAttribute('role', 'img')
    wrap.prepend(renderer.domElement)

    const scene = new Scene()
    const camera = new PerspectiveCamera(40, 2, 0.01, 100)
    // Open over the North Atlantic, with the Americas and Europe both in view.
    camera.position.copy(dirOf(-40, 25).multiplyScalar(3.4))

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.enablePan = false
    controls.minDistance = 1.25
    controls.maxDistance = 8
    controls.rotateSpeed = 0.5
    controls.zoomSpeed = 0.8
    controls.autoRotateSpeed = 0.35

    const earth = new Mesh(new SphereGeometry(1, 64, 48), earthMaterial())
    scene.add(earth)

    const grid = new LineSegments(
      lineGeometry(gridSegments()),
      new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.06 }),
    )
    scene.add(grid)

    const coast = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: '#94a3b8', transparent: true, opacity: 0.5 }),
    )
    scene.add(coast)

    const points = new Points(
      new BufferGeometry(),
      new PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true }),
    )
    scene.add(points)

    const trackLine = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ color: '#38bdf8', transparent: true, opacity: 0.7 }),
    )
    scene.add(trackLine)

    const marker = new Points(
      new BufferGeometry(),
      new PointsMaterial({
        size: 16,
        sizeAttenuation: false,
        map: ringTexture(),
        transparent: true,
        depthWrite: false,
      }),
    )
    marker.geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0], 3))
    marker.visible = false
    scene.add(marker)

    const globe: Globe = {
      renderer,
      scene,
      camera,
      controls,
      earth,
      points,
      marker,
      track: trackLine,
      coast,
      raycaster: new Raycaster(),
      focus: null,
      interacting: false,
      idleTimer: undefined,
      frame: undefined,
      height: 1,
    }
    globeRef.current = globe

    controls.addEventListener('start', () => {
      globe.interacting = true
      globe.focus = null
      window.clearTimeout(globe.idleTimer)
    })
    controls.addEventListener('end', () => {
      window.clearTimeout(globe.idleTimer)
      globe.idleTimer = window.setTimeout(() => (globe.interacting = false), IDLE_RESUME_MS)
    })

    let alive = true
    import('../../assets/coastlines-110m.json').then((m) => {
      if (!alive) return
      coast.geometry.dispose()
      coast.geometry = lineGeometry(coastSegments(m.default.lines))
    })

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width < 1 || height < 1) return
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      globe.height = height
      setSize({ w: width, h: height })
    })
    ro.observe(wrap)

    /* -------------------------------- picking -------------------------------- */
    const ndc = new Vector2()
    const pick = (clientX: number, clientY: number) => {
      const { layer: l, positions: p } = latest.current
      if (!p) return null
      const rect = renderer.domElement.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1)
      const rc = globe.raycaster
      rc.setFromCamera(ndc, camera)
      // The threshold is in world units: convert HIT_RADIUS_PX at the
      // distance of the near side of the globe.
      const dist = camera.position.length() - 1
      const worldPerPx = (2 * dist * Math.tan((camera.fov * DEG) / 2)) / rect.height
      rc.params.Points = { threshold: HIT_RADIUS_PX * worldPerPx }
      // Points behind the Earth still "hit" — the ray passes through the
      // globe — so anything farther than the Earth's surface is occluded.
      const ground = rc.intersectObject(earth, false)[0]?.distance ?? Infinity
      let best = -1
      let bestRay = Infinity
      for (const hit of rc.intersectObject(points, false)) {
        const i = hit.index
        if (i == null || hit.distance > ground || !p.ok[i]) continue
        const d = hit.distanceToRay ?? 0
        if (d < bestRay) {
          bestRay = d
          best = i
        }
      }
      return best >= 0 && l.sats[best] ? { index: best, x, y } : null
    }

    // OrbitControls owns drag; only a press that barely moved counts as a click.
    let down: { x: number; y: number } | null = null
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY })
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return
      down = null
      const hit = pick(e.clientX, e.clientY)
      if (hit) latest.current.onSelect(latest.current.layer.norads[hit.index])
    }
    let pendingMove: PointerEvent | null = null
    let moveFrame: number | undefined
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return // dragging
      pendingMove = e
      // Raycasting 11k points is a few ms; once per frame is plenty.
      moveFrame ??= requestAnimationFrame(() => {
        moveFrame = undefined
        if (!pendingMove) return
        const hit = pick(pendingMove.clientX, pendingMove.clientY)
        renderer.domElement.style.cursor = hit ? 'pointer' : ''
        setHover(hit)
      })
    }
    const onLeave = () => {
      pendingMove = null
      setHover(null)
    }
    const el = renderer.domElement
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerleave', onLeave)

    return () => {
      alive = false
      if (globe.frame != null) cancelAnimationFrame(globe.frame)
      if (moveFrame != null) cancelAnimationFrame(moveFrame)
      window.clearTimeout(globe.idleTimer)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerleave', onLeave)
      controls.dispose()
      scene.traverse((obj) => {
        const o = obj as Partial<Mesh>
        o.geometry?.dispose()
        const materials = Array.isArray(o.material) ? o.material : o.material ? [o.material] : []
        for (const m of materials) {
          const texture = (m as PointsMaterial).map
          texture?.dispose()
          m.dispose()
        }
      })
      renderer.dispose()
      // dispose() frees GPU resources but leaves the context alive until GC;
      // browsers cap live contexts (~16), so toggling 2D/3D would leak them.
      renderer.forceContextLoss()
      el.remove()
      globeRef.current = null
    }
  }, [onUnavailable])

  /* ---------------------------------- data ---------------------------------- */

  // Geometry sized to the worker's satellite set; colours fixed per version.
  useEffect(() => {
    const g = globeRef.current
    if (!g) return
    g.points.geometry.dispose()
    g.points.geometry = buildPointsGeometry(layer)
  }, [layer])

  useEffect(() => {
    const g = globeRef.current
    if (!g || !positions) return
    const attr = g.points.geometry.getAttribute('position') as BufferAttribute
    const xyz = attr.array as Float32Array
    const { lonLatH, ok } = positions
    if (xyz.length !== lonLatH.length) return
    for (let i = 0; i < ok.length; i++) {
      if (ok[i] && shown[i]) {
        toScene(lonLatH[i * 3], lonLatH[i * 3 + 1], lonLatH[i * 3 + 2], xyz, i * 3)
      } else {
        // Parked at the centre, where the Earth hides it from view and from picking.
        xyz[i * 3] = xyz[i * 3 + 1] = xyz[i * 3 + 2] = 0
      }
    }
    attr.needsUpdate = true
  }, [positions, shown])

  // Selection marker, plus a camera swing to it when the selection changes
  // (including from the table).
  const lastFocused = useRef(-1)
  useEffect(() => {
    const g = globeRef.current
    if (!g) return
    const p = positions
    if (selectedIndex < 0 || !p?.ok[selectedIndex]) {
      g.marker.visible = false
      if (selectedIndex < 0) lastFocused.current = -1
      return
    }
    const attr = g.marker.geometry.getAttribute('position') as BufferAttribute
    toScene(
      p.lonLatH[selectedIndex * 3],
      p.lonLatH[selectedIndex * 3 + 1],
      p.lonLatH[selectedIndex * 3 + 2],
      attr.array as Float32Array,
      0,
    )
    attr.needsUpdate = true
    g.marker.geometry.computeBoundingSphere()
    g.marker.visible = true

    if (lastFocused.current !== selectedIndex) {
      lastFocused.current = selectedIndex
      const to = dirOf(p.lonLatH[selectedIndex * 3], p.lonLatH[selectedIndex * 3 + 1])
      if (reducedMotion) {
        g.camera.position.copy(to.multiplyScalar(g.camera.position.length()))
        g.focus = null
      } else {
        g.focus = { from: g.camera.position.clone().normalize(), to, start: performance.now() }
      }
    }
  }, [selectedIndex, positions, reducedMotion])

  useEffect(() => {
    const g = globeRef.current
    if (!g) return
    const segs: number[] = []
    if (track) {
      const a = [0, 0, 0]
      const b = [0, 0, 0]
      for (let k = 3; k < track.length; k += 3) {
        if (Number.isNaN(track[k - 3]) || Number.isNaN(track[k])) continue
        toScene(track[k - 3], track[k - 2], track[k - 1], a, 0)
        toScene(track[k], track[k + 1], track[k + 2], b, 0)
        segs.push(a[0], a[1], a[2], b[0], b[1], b[2])
      }
    }
    g.track.geometry.dispose()
    g.track.geometry = lineGeometry(segs)
  }, [track])

  /* --------------------------------- render loop -------------------------------- */
  useEffect(() => {
    const g = globeRef.current
    if (!g || !visible) return
    const full = new Quaternion()
    const partial = new Quaternion()
    const step = () => {
      const { selectedIndex: sel, reducedMotion: still } = latest.current
      // Rotation would carry a selected satellite out of view, so it only
      // runs with nothing selected and nobody touching the globe.
      g.controls.autoRotate = !still && !g.interacting && sel < 0 && !g.focus
      if (g.focus) {
        const t = Math.min(1, (performance.now() - g.focus.start) / FOCUS_MS)
        const eased = 1 - (1 - t) ** 3
        full.setFromUnitVectors(g.focus.from, g.focus.to)
        partial.identity().slerp(full, eased)
        const dist = g.camera.position.length()
        g.camera.position.copy(g.focus.from).applyQuaternion(partial).multiplyScalar(dist)
        if (t >= 1) g.focus = null
      }
      g.controls.update()
      g.renderer.render(g.scene, g.camera)
      g.frame = requestAnimationFrame(step)
    }
    g.frame = requestAnimationFrame(step)
    return () => {
      if (g.frame != null) cancelAnimationFrame(g.frame)
      g.frame = undefined
    }
  }, [visible])

  useEffect(() => {
    globeRef.current?.renderer.domElement.setAttribute('aria-label', label)
  }, [label])

  return (
    <div
      ref={wrapRef}
      className="relative aspect-[4/3] w-full overflow-hidden rounded-lg border border-white/[0.08] bg-space sm:aspect-[2/1]"
    >
      {hover && (
        <MapTooltip
          layer={layer}
          positions={positions}
          index={hover.index}
          x={hover.x}
          y={hover.y}
          width={size.w}
          height={size.h}
        />
      )}
      <p className="pointer-events-none absolute bottom-2 left-3 text-[0.65rem] text-white/30">
        Drag to rotate · scroll to zoom · altitude to scale
      </p>
    </div>
  )
})

/** Unit vector toward a lon/lat, for camera placement. */
function dirOf(lon: number, lat: number): Vector3 {
  const v = [0, 0, 0]
  toScene(lon, lat, 0, v, 0)
  return new Vector3(v[0], v[1], v[2])
}

function buildPointsGeometry(layer: MapLayer): BufferGeometry {
  const n = layer.norads.length
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3), 3))
  const colors = new Float32Array(n * 3)
  // Color() converts the sRGB hex into three's linear working space, so the
  // dots render as the same colours as the 2D map and the charts.
  const palette = VERSION_ORDER.map((v) => new Color(versionColor(v)))
  for (let i = 0; i < n; i++) {
    const c = palette[layer.version[i]]
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  g.setAttribute('color', new BufferAttribute(colors, 3))
  // Positions change every tick; a fixed sphere enclosing every orbit keeps
  // raycasting's bounding-sphere early-out valid without recomputing it.
  g.boundingSphere = new Sphere(new Vector3(), 1.2)
  return g
}
