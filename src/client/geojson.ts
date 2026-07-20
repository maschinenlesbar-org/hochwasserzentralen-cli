// Pure converters from the plain-JSON API responses to valid GeoJSON
// FeatureCollections (RFC 7946). No I/O — trivially testable.
//
// The exported collections carry the LHP attribution and the data timestamp as
// GeoJSON *foreign members* (`source`, `sourceName`, `licence`, `licenceName`,
// `updated`) — RFC 7946 §6.1 allows them and CC BY 4.0 requires showing source
// and timestamp when the data is passed on (see DATA_LICENSE.md).

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

function envelopeMembers(res: AlertsResponse | StationsResponse): Partial<GeoJsonFeatureCollection> {
  return prune({
    ...(res.bbox !== undefined ? { bbox: res.bbox } : {}),
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
  return { type: "FeatureCollection", ...envelopeMembers(res), features };
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
  return { type: "FeatureCollection", ...envelopeMembers(res), features };
}
