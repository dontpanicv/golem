# Golem

A family AI assistant and second brain that runs on our own machines. No cloud and no central server.

In Prague legend, Rabbi Loew shaped the Golem from clay to serve and protect his community. This one is made from
SQLite and markdown.

## Goals

- **One assistant on every device.** The office Mac mini, the home server, and the MacBook each run Golem; the iPhone
  talks to it.
- **No single point of failure.** Every machine holds a full copy of the data. One machine can go down; a machine that
  comes back catches up.
- **Plain, durable data.** Knowledge is markdown that Obsidian can open. Structured history is append-only files.
  Indexes can be rebuilt.

## Design

| Data | Writer | Replication |
| --- | --- | --- |
| Notes and captures (markdown) | Any device | Peer-to-peer file sync (Syncthing) |
| Agent state ([Pi Durable](https://github.com/earendil-works/pi)) | One SQLite file per machine | Streamed to the other machines (Litestream) |
| Scheduled jobs | The machine that wins the claim | Claims in a 3-node Raft table (rqlite) |
| Structured history | The job that pulled it | Immutable Parquet files, synced as files |
| Search index | Each device | Not replicated; rebuilt locally |

The machines connect over a WireGuard mesh VPN.

## Status

Early design. We are building in public.
