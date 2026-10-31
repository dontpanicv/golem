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
│   └── <workspace-id>/              The folder of Golem's one workspace, the family's.
│       ├── session.sqlite           The agents: one Pi Durable session, with one conversation per thread
│       │                            (transcript, runs, tasks).
│       ├── memory.sqlite            The brief of each channel, every version; and the workspace's one memory
│       │                            from before each member had an orchestrator.
│       ├── memories/
│       │   └── <thread-id>.sqlite   The memory of one member's orchestrator: a line for each message of it and
│       │                            of every thread of the channels, merged in pairs into a tree of summaries.
│       ├── channels/
│       │   └── <channel-id>/
│       │       ├── files/           Files uploaded to the channel or attached to messages in its threads.
│       │       │   └── <uuidv7>-<name>.<ext>
│       │       └── deleted/         Files deleted from the channel and old versions, kept as they were.
│       ├── notes/                   Knowledge as markdown with YAML frontmatter; an Obsidian vault.
│       ├── files/                   Documents people upload to the workspace, and the orchestrator's files.
│       ├── deleted/                 Files deleted from `files/` and old versions, kept as they were.
│       ├── raw/                     Captures from integrations, exactly as received, never edited.
│       │   └── <source>/<yyyy>/<mm>/<uuidv7>.<ext>
│       ├── tables/                  Structured history as Parquet, append-only, read with DuckDB.
│       │   └── <dataset>/date=<yyyy-mm-dd>/<uuidv7>.parquet
│       └── index.sqlite             The search index of this workspace (derived, rebuildable).
├── integrations/
│   ├── <credential-id>/             A device linked to a person's number, such as WhatsApp's: its keys and its
│   │                                copy of the person's chats, kept by wacli.
│   └── deleted/                     The folders of deleted credentials, kept as they were.
├── models/                          Downloaded models, shared because they hold no data.
│   └── embeddinggemma-2-Q8_0.gguf
└── logs/
    └── golem.log
```

## Rules

- **Nothing is ever removed.** A delete marks the row with `deleted_at`, and reads leave it out; a deleted thread file
  moves to `channels/<id>/deleted/`. A deleted channel hides its threads, files, artifacts, and routines, and search
  leaves them out at once; in each memory, the lines of its messages become `(deleted)`, and the model writes
  the summaries over them again without them; `session.sqlite` keeps the messages. A deleted
  workspace (`organization.deletedAt`, from before Golem had one workspace) hides all of it, and its folder stays. Deleted
  channels and machines get `~<id>` after their name (and a machine after its certificate), so the name is free again.
  Artifact records that were deleted still count toward the artifact's limits, until a member clears the data, which
  moves the records aside with `~<time>` after their scope.
- **One workspace, with private channels.** Every byte of the family's data is under `data/workspaces/<workspace-id>/`.
  A private channel (`channel.owner_id`) belongs to one member: its threads, files, artifacts, routines, and the memory
  lines of its messages are theirs alone. Every read names whose view it serves (`Realm` in
  `src/workspaces/workspaces.ts`), and only background work that acts for no person reads all of it.
- **Search is one index, filtered per person.** "Search everything" means everything the person sees: the channels
  every member sees, their own private channels, and their own orchestrator. The workspace has one `index.sqlite`, so
  each source is embedded once; a search leaves out the sources the person may not see before it ranks.
- **Folders are named by id, not by name.** Renaming a workspace, channel, or thread changes a row, never a path.
  A channel's folder holds only its files; a thread's channel is a column in `golem.sqlite`, and so is an artifact's.
- **Canonical and derived data are separate.** `golem.sqlite`, `session.sqlite`, `memory.sqlite`, `memories/`, `notes/`,
  `files/`, `raw/`, and `tables/` are the record; the memories come from `session.sqlite`, but only model calls can write them
  again. `index.sqlite`, `models/`, and `logs/` can be deleted; Golem rebuilds or
  downloads them.
- **Immutable things get time-ordered names.** Captures, channel files, and Parquet parts are named with UUIDv7,
  so names never collide, sort by time, and merge as a set union when copies sync between machines.
- **One writer per SQLite file.** This Golem process is the only writer of each database. Other machines read
  copies (see the replication design in the README).

## What lives where

| Data | Where | Format |
| --- | --- | --- |
| People, sessions, workspaces, members | `golem.sqlite` (better-auth tables) | SQLite |
| Channels, threads, credentials, routines and their runs, one-time reminders, notifications, push devices, recent searches | `golem.sqlite` | SQLite; secrets AES-256-GCM with `config/secret.key` |
| ChatGPT login | `golem.sqlite` | encrypted, shared by all workspaces |
| A thread's conversation and agent state | `session.sqlite`, the conversation named in `thread.conversation_id` | Pi Durable |
| The channel briefs: summaries of the messages of a channel's threads, which the model wrote | `memory.sqlite` | SQLite; the tables `node` and `line` are the memory of the workspace's one orchestrator from before, which its person's memory copied, and which nothing reads now |
| The memory of each member's orchestrator: summaries of its messages and those of the channels' threads | `memories/<thread-id>.sqlite` | SQLite |
| Files uploaded to a channel or attached to messages in its threads | `channels/<id>/files/` | the file as uploaded |
| Artifacts: pages and small apps agents make, which belong to a channel, or the orchestrator's to the workspace | `golem.sqlite` | HTML, and the records their visitors keep |
| Knowledge: people, places, decisions, how-tos | `notes/` | markdown + YAML frontmatter (`type`, `title`, dates, links) |
| Uploaded documents, and the files of the orchestrator, which belongs to no channel | `files/` | the file as uploaded |
| Mail, chats, transcripts, API responses | `raw/<source>/…` | as received (JSON, `.eml`, text) |
| Finances, metrics, any history of numbers | `tables/<dataset>/…` | Parquet, one part per import run |

## Backups

Back up `data/` without `models/` and `index.sqlite` files, which Golem rebuilds. SQLite files are live; take a
consistent copy with `sqlite3 <file> ".backup <copy>"` (or `VACUUM INTO`) before copying, or use a backup tool
that snapshots the file system. Keep `config/` in a password manager or another safe place.

## Search

The workspace's index is `data/workspaces/<workspace-id>/index.sqlite`. Search, the search page, and the agents'
`recall` tool find only what their person, or their thread's realm, sees.

- **What is indexed:** every thread's messages, every artifact's text, and every file in the workspace's `notes/`,
  `files/`, `raw/`, and each channel's `files/`. Drop files into those folders; Golem notices within a second. Every file's path is searchable by
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
  scores for the query, centered and scaled per kind because pictures and audio score on a different scale than text;
  keyword coverage is the share of query words a source contains. A source shows when
  z ≥ 3 or coverage ≥ 0.5, scored `max(z, 0) + 2 × coverage^1.5`; queries made of ids or numbers weigh words more.
- **Freshness:** Golem rescans a workspace a second after any change to one of its threads, and every minute for
  files. Only changed sources are re-read, and only changed text is re-embedded. A different model or runtime
  re-embeds everything. Until the model runs, search and recall use keywords only.
