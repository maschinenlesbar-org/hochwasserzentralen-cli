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
    const geometry = f.geometry as { coordinates?: unknown } | null | undefined;
    eachPosition(geometry?.coordinates, (x, y) => {
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
 * GeoJSON `geometry` (Polygon, [lon, lat] order) — it is used verbatim. Items
 * without a geometry are skipped.
 */
export function alertsToGeoJson(res: AlertsResponse): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const a of res.data) {
    if (a.geometry === undefined || a.geometry === null) continue;
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
 * `coordinates: [lon, lat]` pair; stations without usable coordinates are skipped.
 */
export function stationsToGeoJson(res: StationsResponse): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [];
  for (const s of res.data) {
    const c = s.coordinates;
    if (!Array.isArray(c) || c.length < 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
      continue;
    }
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
