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

import type { AlertArea, AlertsResponse, Station, StationsResponse } from "./types.js";
import { assertValid, responseArgProblem } from "./validate.js";

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
 * An RFC 7946 §3.1.1 position: two or three finite numbers (longitude, latitude, optional
 * elevation; "implementations SHOULD NOT extend positions beyond three elements"), with lon/lat
 * in range.
 */
function isPosition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value.length === 2 || value.length === 3) &&
    value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
    isLonLat(value[0], value[1])
  );
}

/** An array of at least `min` positions. */
function isPositions(value: unknown, min: number): boolean {
  return Array.isArray(value) && value.length >= min && value.every(isPosition);
}

/** An RFC 7946 §3.1.6 linear ring: four or more positions, the first and the last equal. */
function isLinearRing(value: unknown): boolean {
  if (!isPositions(value, 4)) return false;
  const ring = value as number[][];
  const first = ring[0] as number[];
  const last = ring[ring.length - 1] as number[];
  return first.length === last.length && first.every((n, i) => n === last[i]);
}

/** Polygon coordinates: one or more linear rings (the exterior, then any holes). */
function isPolygonCoordinates(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(isLinearRing);
}

/** A non-empty array whose every member passes `member`. */
function isListOf(value: unknown, member: (v: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length >= 1 && value.every(member);
}

/**
 * True for a GeoJSON geometry object worth exporting, as RFC 7946 §3.1 defines it: a Point is
 * one position; a LineString two or more; a Polygon closed linear rings of four or more
 * positions; the Multi* forms non-empty arrays of those; a GeometryCollection a non-empty list
 * of valid geometries. Every position has lon/lat in range. A string, an unknown type, a point
 * at [200, 95], a ring of two positions, an unclosed ring, a one-position line or an empty hole
 * would otherwise be written as a feature a GIS drops or rejects, and counted as written.
 */
function isUsableGeometry(geometry: unknown): boolean {
  if (typeof geometry !== "object" || geometry === null || Array.isArray(geometry)) return false;
  const g = geometry as { type?: unknown; coordinates?: unknown; geometries?: unknown };
  switch (g.type) {
    case "Point":
      return isPosition(g.coordinates);
    case "MultiPoint":
      return isPositions(g.coordinates, 1);
    case "LineString":
      return isPositions(g.coordinates, 2);
    case "MultiLineString":
      return isListOf(g.coordinates, (line) => isPositions(line, 2));
    case "Polygon":
      return isPolygonCoordinates(g.coordinates);
    case "MultiPolygon":
      return isListOf(g.coordinates, isPolygonCoordinates);
    case "GeometryCollection":
      return isListOf(g.geometries, isUsableGeometry);
    default:
      return false;
  }
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
  assertValid("res", res as unknown, responseArgProblem);
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
  assertValid("res", res as unknown, responseArgProblem);
  const features: GeoJsonFeature[] = [];
  for (const s of res.data) {
    const c = s.coordinates;
    if (!hasUsableCoordinates(s) || !Array.isArray(c)) continue;
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

/** True for a station whose `coordinates` hold a [lon, lat] position in range. */
function hasUsableCoordinates(station: Station): boolean {
  const c = station.coordinates;
  return Array.isArray(c) && c.length >= 2 && isLonLat(c[0], c[1]);
}

/**
 * The alert areas {@link alertsToGeoJson} leaves out because they have no usable
 * geometry, in response order. A map without them is missing warnings — possibly the most
 * severe one — so the CLI names them on stderr; a library user can do the same.
 */
export function alertsWithoutGeometry(res: AlertsResponse): AlertArea[] {
  assertValid("res", res as unknown, responseArgProblem);
  return res.data.filter((a) => !isUsableGeometry(a.geometry));
}

/** The stations {@link stationsToGeoJson} leaves out because they have no usable coordinates. */
export function stationsWithoutCoordinates(res: StationsResponse): Station[] {
  assertValid("res", res as unknown, responseArgProblem);
  return res.data.filter((s) => !hasUsableCoordinates(s));
}
