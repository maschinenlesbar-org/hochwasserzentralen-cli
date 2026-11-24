# hochwasser-mcp

An [MCP](https://modelcontextprotocol.io/) server for Germany's joint flood portal of the states,
the Länderübergreifendes Hochwasserportal (LHP, [hochwasserzentralen.de](https://www.hochwasserzentralen.de)):
the states' official flood warnings and the flood class at about 1300 gauges, live, as tools for
AI agents. Read-only, no API key; the data is CC BY 4.0 (attribution with the data's time).

The LHP publishes classifications only, no water levels: for centimetres and trends at a gauge,
use [pegel-online-cli](https://github.com/maschinenlesbar-org/pegel-online-cli).

It is the MCP side of [hochwasserzentralen-cli](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/hochwasserzentralen-mcp
```

This installs the **`hochwasser-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/hochwasserzentralen-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add hochwasser -- hochwasser-mcp
# or with the image:
claude mcp add hochwasser -- docker run -i --rm ghcr.io/maschinenlesbar-org/hochwasserzentralen-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "hochwasser": { "command": "hochwasser-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "hochwasser": { "type": "stdio", "command": "hochwasser-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
hochwasser-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http hochwasser http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/hochwasserzentralen-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/releases) instead of
`latest`: `…/hochwasserzentralen-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/hochwasserzentralen-mcp:<version> --repo maschinenlesbar-org/hochwasserzentralen-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getFloodAlerts` | The states' official flood warnings for Germany or some states, worst first on the alerts scale (6 Sehr großes Hochwasser … 2 Vorwarnung), with a verdict; all-clears (1, Entwarnung) apart, never as a flood; with `cap`, the official instruction. No warning is the usual answer, said plainly. |
| `getFloodSituation` | The flood class at the gauges per state and for Germany from one request: the worst class, the gauges per class, the no-data (-1) and unclassified (null) gauges apart, border gauges counted once as sites, the worst gauges by name, a verdict. |
| `getFloodMap` | Warning areas (Polygons, river reaches as LineStrings) or gauges (Points) as a GeoJSON FeatureCollection, a page at a time, with what has no usable geometry named. |
| `listGauges` | The gauges by state, water (a part of the name) and minimum class, worst first, a page at a time; a water search names the waters it matched. |
| `findGauge` | One gauge by id or name; a border gauge's two entries are one answer, a name matching several places is ambiguous with the candidates. |

States are taken as codes or names (`BY`, `Bayern`, `Bavaria`, `NRW`). Every result carries the
attribution CC BY 4.0 asks for, with the data's time as German local time (the API writes
`+01:00` also in summer).

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A failure is a tool error that says what to change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://api.hochwasserzentralen.de/public/v1)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages. With
  `--auth-token-file <path>` every request must send `Authorization: Bearer <token>` (the file holds
  one token of at least 32 characters, mode 600, owned by the user the server runs as; read once at
  start; `(umask 077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401.
  Exposed beyond localhost (it logs a warning then), it belongs behind a proxy that authenticates or
  at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline. A request those limits would hold longer than it or its call may
  wait is not sent: the call fails at once, naming the limit and when to ask again (and the log says
  so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new
  connection and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal
  ends it at once. On stdio it ends at once, and when stdin ends.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/blob/main/LICENSING.md)).
Data: the Länderübergreifendes Hochwasserportal's (the states' flood services), under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de): use, also commercial, with the
source and the data's time named ([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/hochwasserzentralen-cli/blob/main/DATA_LICENSE.md)).
Every result's `attribution.text` is that credit ("Quelle: Länderübergreifendes Hochwasserportal
(LHP), hochwasserzentralen.de — Stand: …"); keep it with whatever is passed on, and refresh data
republished online at least every 10 minutes. It is unverified raw data without warranty: for
safety decisions, the states' own flood services (the `link` of each warning and gauge) and
official emergency channels are authoritative. Running this server as a service for others
passes the LHP's data on: the attribution goes with it.
