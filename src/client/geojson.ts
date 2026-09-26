// Pure converters from the plain-JSON API responses to valid GeoJSON
// FeatureCollections (RFC 7946). No I/O — trivially testable.
//
// The exported collections carry the LHP attribution and the data timestamp as
// GeoJSON *foreign members* (`source`, `sourceName`, `licence`, `licenceName`,
// `updated`) — RFC 7946 §6.1 allows them and CC BY 4.0 requires showing source
// and timestamp when the data is passed on (see DATA_LICENSE.md).
//
// The API's own envelope `bbox` is NOT copied: it is a fixed box around Germany
// in [west, north, east, south] order, whatever the filter. The collection's
// `bbox` is computed from the exported features instead, in the RFC 7946 §5
// order [west, south, east, north].

import type { AlertsResponse, StationsResponse } from "./types.js";

export interface GeoJsonFeature {
  type: "Feature";
  geometry: unknown;
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
  bbox?: number[];
  /** Foreign members: attribution + data timestamp (CC BY 4.0). */
  source?: string;
  sourceName?: string;
  licence?: string;
  licenceName?: string;
  updated?: string;
}

/** Copy only defined, non-null values so features stay clean. */
function prune(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Call `visit` for every [x, y, …] position nested anywhere in a GeoJSON `coordinates` value. */
function eachPosition(coords: unknown, visit: (x: number, y: number) => void): void {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    visit(coords[0], coords[1]);
    return;
  }
  for (const c of coords) eachPosition(c, visit);
}

/** Call `visit` for every position of a geometry, descending into a GeometryCollection. */
function eachGeometryPosition(geometry: unknown, visit: (x: number, y: number) => void): void {
  if (typeof geometry !== "object" || geometry === null) return;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (g.type === "GeometryCollection") {
    if (Array.isArray(g.geometries)) for (const child of g.geometries) eachGeometryPosition(child, visit);
    return;
  }
  eachPosition(g.coordinates, visit);
}

/** The RFC 7946 geometry types. */
const GEOMETRY_TYPES: ReadonlySet<string> = new Set([
  "Point",
  "MultiPoint",
  "LineString",
  "MultiLineString",
  "Polygon",
  "MultiPolygon",
  "GeometryCollection",
]);

/** A finite [lon, lat] inside ±180 / ±90. */
function isLonLat(x: unknown, y: unknown): boolean {
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) <= 180 &&
    Math.abs(y) <= 90
  );
}

/**
 * The number of positions in a `coordinates` value, or -1 if any part is not a
 * position of finite numbers with lon/lat in range (or not an array at all).
 */
function countPositions(coords: unknown): number {
  if (!Array.isArray(coords)) return -1;
  if (typeof coords[0] === "number") {
    const numbers = coords.every((n) => typeof n === "number" && Number.isFinite(n));
    return numbers && coords.length >= 2 && isLonLat(coords[0], coords[1]) ? 1 : -1;
  }
  let total = 0;
  for (const c of coords) {
    const n = countPositions(c);
    if (n < 0) return -1;
    total += n;
  }
  return total;
}

/**
 * True for a GeoJSON geometry object worth exporting: a known RFC 7946 `type`, and
 * `coordinates` holding at least one position, every one with lon/lat in range (a
 * GeometryCollection: every member valid). A string, an unknown type or a point at
 * [200, 95] would otherwise be passed through and distort the bbox.
 */
function isUsableGeometry(geometry: unknown): boolean {
  if (typeof geometry !== "object" || geometry === null || Array.isArray(geometry)) return false;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  if (typeof g.type !== "string" || !GEOMETRY_TYPES.has(g.type)) return false;
  if (g.type === "GeometryCollection") {
    return Array.isArray(g.geometries) && g.geometries.length > 0 && g.geometries.every(isUsableGeometry);
  }
  return countPositions(g.coordinates) > 0;
}

/**
 * The RFC 7946 §5 bounding box [west, south, east, north] of the features'
 * geometries, or undefined when they hold no position (e.g. zero features).
 */
export function featuresBbox(features: readonly GeoJsonFeature[]): number[] | undefined {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const f of features) {
    eachGeometryPosition(f.geometry, (x, y) => {
      west = Math.min(west, x);
      east = Math.max(east, x);
      south = Math.min(south, y);
      north = Math.max(north, y);
    });
  }
  return west <= east ? [west, south, east, north] : undefined;
}

/** A FeatureCollection: `bbox` from the features, then the envelope's attribution members. */
function collection(res: AlertsResponse | StationsResponse, features: GeoJsonFeature[]): GeoJsonFeatureCollection {
  const bbox = featuresBbox(features);
  return { type: "FeatureCollection", ...(bbox !== undefined ? { bbox } : {}), ...envelopeMembers(res), features };
}

function envelopeMembers(res: AlertsResponse | StationsResponse): Partial<GeoJsonFeatureCollection> {
  return prune({
    source: res.source,
    sourceName: res.sourceName,
    licence: res.licence,
    licenceName: res.licenceName,
    updated: res.updated,
  }) as Partial<GeoJsonFeatureCollection>;
}

/**
 * Alert areas -> FeatureCollection. The plain-JSON alert items already carry a
 * GeoJSON `geometry` (a Polygon, or a LineString for a river reach; [lon, lat]
 * order) — it is used verbatim. Items without a usable geometry (none, not a
 * GeoJSON geometry object of a known type, or a position outside ±180/±90) are
 * skipped.
 */
export function alertsToGeoJson(res: AlertsResponse): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const a of res.data) {
    if (!isUsableGeometry(a.geometry)) continue;
    features.push({
      type: "Feature",
      geometry: a.geometry,
      properties: prune({
        kind: a.kind,
        id: a.id,
        areaDesc: a.areaDesc,
        areaType: a.areaType,
        alertHeadline: a.alertHeadline,
        alertLink: a.alertLink,
        lhpClass: a.lhpClass,
        lhpClassName: a.lhpClassName,
        ...(a.cap !== undefined ? { cap: a.cap } : {}),
      }),
    });
  }
  return collection(res, features);
}

/**
 * Stations -> FeatureCollection of Points. Plain-JSON stations are flat with a
 * `coordinates: [lon, lat]` pair; stations without usable coordinates (missing,
 * not finite numbers, or outside ±180/±90) are skipped.
 */
export function stationsToGeoJson(res: StationsResponse): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const s of res.data) {
    const c = s.coordinates;
    if (!Array.isArray(c) || c.length < 2 || !isLonLat(c[0], c[1])) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c[0], c[1]] },
      properties: prune({
        kind: s.kind,
        id: s.id,
        name: s.name,
        water: s.water,
        timestamp: s.timestamp,
        lhpClass: s.lhpClass,
        stateClassName: s.stateClassName,
        stationLink: s.stationLink,
        stateId: s.stateId,
      }),
    });
  }
  return collection(res, features);
}
