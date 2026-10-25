# Data and configuration

Golem keeps everything in two folders next to the code. Both are gitignored.

| Folder | Holds | Back up |
| --- | --- | --- |
| `config/` | What Golem needs to start: `golem.toml` (address, port, allowed people, Google OAuth client) and `secret.key` (the key that encrypts stored credentials). Golem creates both on first start. | Keep a copy somewhere safe, **apart from** the data backup: `secret.key` decrypts credentials in `data/`. |
| `data/` | Everything Golem stores: databases, markdown, files, indexes, models, logs. | Offsite, every night. |

Nothing else is written anywhere. Set `GOLEM_CONFIG` and `GOLEM_DATA` to move the folders.

## Layout

```text
data/
├── golem.sqlite                     The directory: accounts, sessions, workspaces, members, channels,
│                                    the thread registry, settings, and encrypted credentials.
├── workspaces/
│   └── <workspace-id>/              One folder per workspace, and nothing of a workspace outside it.
│       ├── session.sqlite           The agents: one Pi Durable session, with one conversation per thread
│       │                            (transcript, runs, tasks).
│       ├── threads/
│       │   └── <thread-id>/
│       │       └── files/           Attachments and artifacts of this thread.
│       │           └── <uuidv7>-<name>.<ext>
│       ├── notes/                   Knowledge as markdown with YAML frontmatter; an Obsidian vault.
│       ├── files/                   Documents people upload to the workspace.
│       ├── raw/                     Captures from integrations, exactly as received, never edited.
│       │   └── <source>/<yyyy>/<mm>/<uuidv7>.<ext>
│       ├── tables/                  Structured history as Parquet, append-only, read with DuckDB.
│       │   └── <dataset>/date=<yyyy-mm-dd>/<uuidv7>.parquet
│       └── index.sqlite             The search index of this workspace (derived, rebuildable).
├── models/                          Downloaded models, shared because they hold no data.
│   └── embeddinggemma-2-Q8_0.gguf
└── logs/
    └── golem.log
```

## Rules

- **Workspaces are separate on disk.** Every byte of a workspace is under `data/workspaces/<workspace-id>/`:
  its threads, files, notes, captures, tables, and its own search index. Deleting a workspace is deleting its
  folder plus its rows in `golem.sqlite`. Nothing reads one workspace's folder on behalf of another.
- **Search never crosses workspaces.** "Search everything" means everything in one workspace: all channels,
  threads, notes, files, and captures. Each workspace has its own `index.sqlite`; there is no shared index.
- **Folders are named by id, not by name.** Renaming a workspace, channel, or thread changes a row, never a path.
  Channels have no folder; a thread's channel is a column in `golem.sqlite`, so moving a thread moves nothing.
- **Canonical and derived data are separate.** `golem.sqlite`, `session.sqlite`, `notes/`, `files/`, `raw/`, and
  `tables/` are the record. `index.sqlite`, `models/`, and `logs/` can be deleted; Golem rebuilds or
  downloads them.
- **Immutable things get time-ordered names.** Captures, thread files, and Parquet parts are named with UUIDv7,
  so names never collide, sort by time, and merge as a set union when copies sync between machines.
- **One writer per SQLite file.** This Golem process is the only writer of each database. Other machines read
  copies (see the replication design in the README).

## What lives where

| Data | Where | Format |
| --- | --- | --- |
| People, sessions, workspaces, members | `golem.sqlite` (better-auth tables) | SQLite |
| Channels, threads, integration settings, credentials | `golem.sqlite` | SQLite; secrets AES-256-GCM with `config/secret.key` |
| ChatGPT login | `golem.sqlite` | encrypted, shared by all workspaces |
| A thread's conversation and agent state | `session.sqlite`, the conversation named in `thread.conversation_id` | Pi Durable |
| Files attached to a thread's messages or uploaded to the thread, and what its agent made | `threads/<id>/files/` | the file as uploaded or made |
| Knowledge: people, places, decisions, how-tos | `notes/` | markdown + YAML frontmatter (`type`, `title`, dates, links) |
| Uploaded documents | `files/` | the file as uploaded |
| Mail, chats, transcripts, API responses | `raw/<source>/…` | as received (JSON, `.eml`, text) |
| Finances, metrics, any history of numbers | `tables/<dataset>/…` | Parquet, one part per import run |

## Backups

Back up `data/` without `models/` and `index.sqlite` files, which Golem rebuilds. SQLite files are live; take a
consistent copy with `sqlite3 <file> ".backup <copy>"` (or `VACUUM INTO`) before copying, or use a backup tool
that snapshots the file system. Keep `config/` in a password manager or another safe place.

## Search

Each workspace has its own index at `data/workspaces/<workspace-id>/index.sqlite`. Search, the search page, and the
agents' `recall` tool read only the index of the workspace they are in; there is no search across workspaces.

- **What is indexed:** every thread's messages, and every file in the workspace's `notes/`, `files/`, `raw/`, and each
  thread's `files/`. Drop files into those folders; Golem notices within a second. Every file's path is searchable by
  keywords, also when Golem cannot read the file. The same kinds as DigUp:

  | Kind | Formats | How |
  | --- | --- | --- |
  | Documents | txt, md, rtf, doc, docx, odt, html, xlsx, ods, pptx, odp, csv, json, yaml, xml, eml, ics, vcf | Text in chunks of about 1800 characters with 200 of overlap. Office files are read from their XML; a sheet becomes tab-separated rows, a slide its text and speaker notes. `.doc` needs macOS. |
  | PDF | pdf | One segment per page. A page with little text is a scan: it is rendered (poppler) and embedded as a picture, and its OCR text (tesseract) goes to keywords. |
  | Pictures | jpg, png, heic, webp, gif, tiff, bmp, avif | The picture itself, at most 1024 pixels long; screenshots and PNGs also get OCR text. |
  | Audio | mp3, m4a, wav, aac, flac, ogg, opus, aiff, caf | 30-second windows, 25 seconds apart; silence is skipped. EmbeddingGemma 2 hears what is said. |
  | Video | mp4, mov, m4v, mkv, webm, avi | A frame every 3 seconds, kept when the shot changes, plus the soundtrack as audio. |

  Pictures, audio, and video need **ffmpeg**; scanned PDF pages need **poppler**; OCR needs **tesseract**, which reads
  in every language it has (add Czech with `ces.traineddata`). On a Mac: `brew install ffmpeg poppler tesseract`.
  Without a tool, that part is skipped and the file is found by its name.
- **Keywords:** SQLite FTS5 (`porter unicode61`), with the title weighted three times the text.
- **Meaning:** Google's [EmbeddingGemma 2](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF) (Apache 2.0),
  run by a pinned llama.cpp `llama-server` child process. On first start Golem downloads the text model (310 MB) and
  the picture and audio encoders (555 MB) to `data/models/`, and llama.cpp to `data/runtime/`, all checked against
  pinned sha256 hashes. Text that reads as prose, pictures, and audio get a 768-dimension vector in one shared space,
  stored as float16 in the `segments` table: no vector database, no extension.
  Queries compare against every vector by brute force, which takes milliseconds at family scale.
- **Ranking:** after DigUp (github.com/ARahim3/DigUp, MIT). Each source's best cosine becomes a z-score against all
  scores for the query, centered per kind because pictures and audio score on a different scale than text; keyword
  coverage is the share of query words a source contains. A source shows when
  z ≥ 2 or coverage ≥ 0.5, scored `max(z, 0) + 2 × coverage^1.5`; queries made of ids or numbers weigh words more.
- **Freshness:** Golem rescans a workspace a second after any change to one of its threads, and every minute for
  files. Only changed sources are re-read, and only changed text is re-embedded. A different model or runtime
  re-embeds everything. Until the model runs, search and recall use keywords only.
