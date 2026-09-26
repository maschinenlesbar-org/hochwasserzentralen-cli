# Developing & integrating

This document covers `hochwasserzentralen-cli` as a **TypeScript library**, plus
its architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`hochwasser`) and a typed API client
(`HochwasserzentralenClient`) for the official **LHP-PublicAPI v1**
(`https://api.hochwasserzentralen.de/public/v1`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed alert areas, stations, CAP blocks and envelopes.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the LHP-PublicAPI needs no key; this client only reads.

## The API choice (read this before touching endpoints)

This repo wraps the **official LHP-PublicAPI v1** announced by the LHP:

- Base URL: `https://api.hochwasserzentralen.de/public/v1`
- Two GET endpoints: `/data/alerts` (regional flood alerts, optional `cap=true`
  CAP detail) and `/data/stations` (flood classification at ~1600 gauges;
  1573 on 2026-09-15).
- Content negotiation: `Accept: application/geo+json` (server default),
  `application/json`, `text/xml`; `Accept-Language: de` (default) or `en`.
- A **test system** with fixed canned data lives at
  `https://api.hochwasserzentralen.de/public/v1/test` (exported as
  `TEST_BASE_URL`; reach it via `--base-url`). It always has active alerts —
  useful because the production `/data/alerts` is often (happily) empty.

**The legacy bundesAPI endpoints are defunct.** The
`www.hochwasserzentralen.de/webservices/*.php` endpoints documented by
bundesAPI/hochwasserzentralen-api return empty responses (verified 2026-07-13).
Do **not** wrap them; this repo intentionally targets only the official
PublicAPI.

**Representation quirk (important):** this client always requests
`Accept: application/json` — the *plain* JSON representation — and the two
endpoints flatten differently (verified live 2026-07-13):

- `/data/alerts` items keep their GeoJSON-Feature form even in plain JSON
  (`type: "Feature"` + `geometry` + flattened alert fields, list under `data`).
- `/data/stations` items are **flat**: `coordinates` and the properties sit
  directly on the item — no `geometry`/`properties`/`style` wrapper, list under
  `data`. The wrapped Feature form (under `features`) only appears in the
  `application/geo+json` representation.

**Cache mix-up (upstream, transient).** Responses carry
`Cache-Control: max-age=60` but `Vary: Accept-Encoding` only, and a cache in
front of the API serves one representation for all `Accept` and
`Accept-Language` values of a URL. So a request for `application/json` can get
the `application/geo+json` body (seen live 2026-09-15: `Content-Type:
application/geo+json`, `Age: 21`), and `Accept-Language: en` can get `lang: "de"`.
`assertDataArray` in [`src/client/client.ts`](src/client/client.ts) turns the
first case into a `HochwasserzentralenParseError` that says so and suggests a
retry; the client does not convert the GeoJSON body.

The types in [`src/client/types.ts`](src/client/types.ts) model the plain-JSON
shapes. The CLI's `--geojson` flag does **not** switch the Accept header — it
rebuilds a `FeatureCollection` locally via
[`src/client/geojson.ts`](src/client/geojson.ts), which lets `--water` /
`--min-class` filter first and lets the export carry the CC-BY attribution
foreign members.

**ETag / caching (future work).** The API supports `ETag` /
`If-None-Match` / `304 Not Modified` server-side. This client does not implement
conditional requests or caching yet — a polling consumer could cut traffic
substantially by sending `If-None-Match`. Noted as future work; the door is open
via `EngineOptions.defaultHeaders`.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
hochwasser --help
```

## Library usage

```ts
import {
  HochwasserzentralenClient,
  HochwasserzentralenApiError,
  TEST_BASE_URL,
  stationsToGeoJson,
} from "@maschinenlesbar.org/hochwasserzentralen-cli";

const client = new HochwasserzentralenClient(); // defaults to the production API

const alerts = await client.alerts({ states: ["BY", "SN"], cap: true });
console.log(alerts.updated, alerts.data.length); // show the data timestamp (CC BY)

const stations = await client.stations({ states: ["BE"], lang: "en" });
const flooding = stations.data.filter((s) => s.lhpClass >= 1);

const fc = stationsToGeoJson(stations); // valid FeatureCollection, [lon, lat]

const demo = new HochwasserzentralenClient({ baseUrl: TEST_BASE_URL }); // canned data

try {
  await client.stations({ states: ["XX"] });
} catch (err) {
  if (err instanceof HochwasserzentralenApiError) console.error(err.status, err.detail);
}
```

### Client options

All fields are optional; the values below are illustrative overrides, **not**
defaults (defaults are `maxRetries: 2`, `maxResponseBytes: 100 MiB`,
`timeoutMs: 30_000`).

```ts
new HochwasserzentralenClient({
  baseUrl: "https://api.hochwasserzentralen.de/public/v1",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 retried; Retry-After honoured (capped at 30 s)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

## Architecture

```
src/
  client/
    types.ts     # envelopes, AlertArea / Station / CAP shapes, state codes, lhpClass names
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff (Retry-After aware), JSON decoding, error mapping
    errors.ts    # Hochwasserzentralen{Error,ApiError,NetworkError,ValidationError,ParseError}
    geojson.ts   # pure plain-JSON -> FeatureCollection converters (alerts + stations)
    client.ts    # HochwasserzentralenClient — alerts() / stations() over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/writeFile/fileExists)
    shared.ts    # option parsers (states! min-class!), global-option resolver, JSON/GeoJSON renderers
    commands/    # data.ts — alerts / stations / situation (incl. the aggregation)
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- **Redirects are NOT followed** — a 3xx surfaces as a `HochwasserzentralenApiError`
  (CLI exit 1 with a hint). The canonical host answers directly; since no redirect
  is ever followed, credential headers can never leak across hosts (this client
  is keyless anyway).
- **Every option value is validated** — `--states` against the 16 codes (parse
  time, exit 2), `--lang` via commander `.choices()`, `--min-class` bounded to
  -1..4. A typo never becomes a silently-dropped filter that returns the full
  nationwide set. The client validates `states` again (`normalizeStates`) for
  library users.
- **`-o/--output` never silently overwrites.** An existing file is refused with
  exit 2 unless `--force` is passed. The check uses `lstat` and the write is an
  exclusive create (`wx`), so a symlink at the path (even a dangling one) is
  refused too and never written through; GeoJSON writes additionally report the
  feature count. (This is stricter than some siblings — deliberate here, since
  the flagship use-case is file export.)
- **CC BY 4.0 plumbing:** the API envelope's `source*`/`licence*`/`updated`
  fields are never stripped — they survive filtering (`--water`/`--min-class`),
  appear in the `situation` aggregate, and ride along as GeoJSON foreign members.

### Library & technical terms

**API client (`HochwasserzentralenClient`).** [`src/client/client.ts`](src/client/client.ts) —
the typed wrapper over the API: `alerts(params)` and `stations(params)`. Usable as
a library independently of the CLI.

**Request engine (`RequestEngine`).** [`src/client/engine.ts`](src/client/engine.ts)
— builds URLs, serialises queries, applies retry/backoff, decodes JSON and maps
errors. `DEFAULT_BASE_URL` is `https://api.hochwasserzentralen.de/public/v1`;
`TEST_BASE_URL` appends `/test`.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`src/client/http.ts`](src/client/http.ts)). The default (`nodeHttpTransport`) uses Node's
built-in `http`/`https`; tests inject a mock. This is the only HTTP seam.

**Retry / backoff.** Transient `429` (rate limit) and `503` responses are retried
automatically up to `maxRetries` (default `2`). A `Retry-After` header (seconds or
HTTP-date as an IMF-fixdate; any other value counts as absent) takes precedence over
the linear backoff and is clamped to 30 s so a
hostile value cannot hang the CLI. `HochwasserzentralenApiError` exposes
`isRetryable`. CLI: `--max-retries`.

**maxResponseBytes.** A hard cap on response body size to defend against memory
exhaustion (default 100 MiB; `0` = unlimited). CLI: `--max-response-bytes`.

**GeoJSON converters.** [`src/client/geojson.ts`](src/client/geojson.ts) — pure
functions `alertsToGeoJson` / `stationsToGeoJson` producing RFC-7946
FeatureCollections (`[lon, lat]`), skipping items without usable geometry,
computing `bbox` (`[west, south, east, north]`) from the exported features
rather than copying the API's `[west, north, east, south]` Germany box, and
carrying attribution + `updated` as foreign members.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`src/cli/io.ts`](src/cli/io.ts)): a client factory plus an I/O object
(`out`/`err`/`writeFile`/`fileExists`). Lets the whole CLI run in tests with a
mocked client and captured output — no subprocess.

**Error types.** [`src/client/errors.ts`](src/client/errors.ts):
`HochwasserzentralenApiError` (non-2xx incl. unfollowed 3xx; carries `status`,
`detail`, `url`, `method`, `body`), `HochwasserzentralenNetworkError` (transport
failure/timeout/size cap), `HochwasserzentralenValidationError` (client-side,
no request made; CLI exit 2), `HochwasserzentralenParseError` (bad JSON), all
extending the base `HochwasserzentralenError`.

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation (states join, cap boolean).
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, headers (Accept / Accept-Language), JSON decoding,
  error mapping, 429/503 retry incl. Retry-After precedence and clamping, 3xx-not-followed,
  control-character sanitisation — mocked transport.
- **`client.test.ts`** — endpoint/query/header mapping, state-code validation, typed
  fixtures, GeoJSON converters — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, filter validation (exit 2 paths),
  the situation aggregation, GeoJSON export + overwrite guard, exit codes (0/2/4/6/1)
  — mocked client, captured output.

Run one file after building: `node --test dist/test/cli.test.js`.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`,
  generate CycloneDX SBOMs, and create a GitHub Release with the artifacts.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing**
  (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/hochwasserzentralen-cli/> in
English and <https://maschinenlesbar-org.github.io/hochwasserzentralen-cli/de/> in German — is
built from `site/` with [Jekyll](https://jekyllrb.com/),
[banira](https://sebs.github.io/banira/) web components and [Fylgja](https://fylgja.dev/) CSS,
and deployed by `docs.yml` together with the TypeDoc API reference under `/api/`. Its content
comes from this repository: the README intro and quick start, the command tree of the built CLI
(`site/scripts/cli-reference.mjs`), `Usage.md`, `GLOSSARY.md` and its German version
`GLOSSARY.de.md`, the skills, and the skill examples in `EXAMPLE.md` and `EXAMPLE.de.md`. The
only repo-specific files are `site/_config.yml` and `site/_data/project.yml` (the German intro
and the access requirements); the rest of `site/` is identical in every maschinenlesbar.org
CLI, so change it in all of them together. When the README intro changes, update the German
intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/hochwasserzentralen-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**. The upstream **data**
is CC BY 4.0 — see **[DATA_LICENSE.md](DATA_LICENSE.md)**.
