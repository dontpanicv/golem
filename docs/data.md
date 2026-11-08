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
│       ├── memory.sqlite            The brief of each channel, every version; what Golem learned about each
│       │                            person and each channel; and the workspace's one memory from before each
│       │                            member had an orchestrator.
│       ├── threads/
│       │   └── <thread-id>/
│       │       └── memory.sqlite   The orchestrator's own conversation and returned worker results,
│       │                            merged in pairs into a tree of summaries.
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
├── audit.sqlite                    Private raw process log; SQLite backup makes one portable copy.
├── models/                          Downloaded models, shared because they hold no data.
│   ├── embeddinggemma-2-Q8_0.gguf
└── logs/
    └── golem.log
```

## Rules

- **Nothing is ever removed.** A delete marks the row with `deleted_at`, and reads leave it out; a deleted thread file
  moves to `channels/<id>/deleted/`. A channel goes only by merging into another, which first moves its threads, files,
  artifacts, and routines there; the empty channel is then marked deleted. A result already sent to an orchestrator remains part of its own conversation;
  `session.sqlite` keeps the messages. A deleted workspace (`organization.deletedAt`, from before Golem had one
  workspace) hides all of it, and its folder stays. Deleted
  channels and machines get `~<id>` after their name (and a machine after its certificate), so the name is free again.
  Artifact records that a visitor or a member deleted still count toward the artifact's limits, until a member clears
  the data, which moves the records aside with `~<time>` after their scope. A record that an agent deletes moves aside
  at once.
- **A thread moves with what it made.** A thread that moves to another channel takes its artifacts, its routine,
  and the files of its old channel that it mentions and no other thread there does, with their old versions. The
  index keeps their vectors. When the move takes the thread from people, the old channel's brief is written again
  from the threads that stay; the new channel's brief reads the whole thread. `session.sqlite` keeps the conversation,
  with a note of the move.
- **One workspace, with private channels.** Every byte of the family's data is under `data/workspaces/<workspace-id>/`.
  A private channel (`channel.owner_id`) belongs to one member: its threads, files, artifacts, and routines are theirs
  alone. An orchestrator remembers only its own conversation and the results sent to it. Every read names whose view
  it serves (`Realm` in `src/workspaces/workspaces.ts`), and only background work that acts for no person reads all of it.
- **Search is one index, filtered per person.** "Search everything" means everything the person sees: the channels
  every member sees, their own private channels, and their own orchestrator. The workspace has one `index.sqlite`, so
  each source is embedded once; a search leaves out the sources the person may not see before it ranks.
- **Folders are named by id, not by name.** Renaming a workspace, channel, or thread changes a row, never a path.
  A channel's folder holds only its files; a thread's channel is a column in `golem.sqlite`, and so is an artifact's.
- **Canonical and derived data are separate.** `golem.sqlite`, `session.sqlite`, `memory.sqlite`, the thread memories, `notes/`,
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
| Channels, threads, credentials, routines and their runs, one-time reminders, suggestions, notifications, push devices, Live Activities, recent searches, the usage of the model by day, the feedback of agents | `golem.sqlite` | SQLite; secrets AES-256-GCM with `config/secret.key` |
| Current and historical source evidence, collection cursors, private context, internal checks, and delivery state | `golem.sqlite`, `intake_item`, `intake_source`, `intake_fts`, `intake_check`, `intake_context`, `intake_delivery`, `intake_thread_read` | SQLite; all rows belong to one person |
| Raw collection results, attachment bytes, prompts, model responses and usage, retrieval results, state changes, notices, agent work, corrections, and runtime fingerprints | `audit.sqlite`, `event` and `blob` | SQLite WAL, synchronous FULL; local private file, no integration credential secrets |
| ChatGPT login | `golem.sqlite` | encrypted, shared by all workspaces |
| A thread's conversation and agent state | `session.sqlite`, the conversation named in `thread.conversation_id` | Pi Durable |
| A routine run's fixed definition and initial store, and its script result | `golem.sqlite`, `routine_run.input` and `routine_run.result`; retained after completion | JSON |
| What Golem learned: facts about each person and how-tos of each channel, which the reviews of quiet threads write and people correct | `memory.sqlite`, the tables `learned`, `learned_read`, and `learned_since` | SQLite |
| The channel briefs: summaries of the messages of a channel's threads, which the model wrote | `memory.sqlite` | SQLite; old orchestrator memory tables are kept but no longer read |
| The memory of each member's orchestrator: its own conversation and returned worker results | `threads/<thread-id>/memory.sqlite` | SQLite |
| Files uploaded to a channel or attached to messages in its threads | `channels/<id>/files/` | the file as uploaded |
| Artifacts: pages and small apps agents make, which belong to a channel, or the orchestrator's to the workspace | `golem.sqlite` | HTML, and the records their visitors keep |
| Knowledge: people, places, decisions, how-tos | `notes/` | markdown + YAML frontmatter (`type`, `title`, dates, links) |
| Uploaded documents, and the files of the orchestrator, which belongs to no channel | `files/` | the file as uploaded |
| Mail, chats, transcripts, API responses | `raw/<source>/…` | as received (JSON, `.eml`, text) |
| Finances, metrics, any history of numbers | `tables/<dataset>/…` | Parquet, one part per import run |

The old orchestrator memory tables in `memory.sqlite` and the databases in `memories/` stay on disk, but Golem does
not read them. Each current memory is built from its orchestrator's complete saved transcript, including past worker results.

`intake_delivery.notification` is a nullable, validated proposal with a reason, source id, and exact quote. Null means
the thread update is silent, including rows made by the prior version. The additive migration keeps those rows and
adds a source-conversation index for short replies. Delivery and notification are separate: a useful thread answer
can complete without a notice or a change to `intake_check.notified_at`. Only confirmed notices consume matching due
checks. The private audit records the proposal, fresh source read, final judge input and result, and suppression or
confirmation. Source failures retain the delivery for retry with the same thread request and notification ids.

`intake_delivery.subject` keeps a proposed new subject while `thread_id` is null. The additive column leaves
previously routed rows unchanged. A final evidence assessment can cancel the proposal or select an existing thread;
only a still-useful review can create a destination. The binding saves its thread, source references, and check links
together. A stable thread request id prevents another thread when creation succeeds before the binding is saved.

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
- **Keywords:** SQLite FTS5 (`porter unicode61 remove_diacritics 2`), with the title weighted three times the text.
  Each word also gets its Czech stem from the Snowball Czech stemmer
  ([multilingual-stemmer](https://github.com/MrRefactoring/multilingual-stemmer), MIT), to match common Czech inflections. Exact words ignore diacritics; Czech stems use standard Snowball rules without
  guessed spelling. A query word also matches words that start with it, or its stem. When this changes, Golem rebuilds the keywords from the stored segments, which keep their vectors.
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

## Audit export

`audit.sqlite` is separate from operational state. Each event has a trace id, stage, workspace, owner, time, and JSON
payload. Attachments use content hashes in `blob`. Prompts and raw model results preserve the inputs for later replay
or training. `audit.open` records the Bun version and source-file hashes. Model calls record model identity and usage.
The audit contains private communications. It is never served by a public route or added to Git.

Use SQLite backup to get a consistent, single file while Golem runs:

```sh
sqlite3 data/audit.sqlite ".backup '/private/export/golem-audit.sqlite'"
```

Then copy that file to the machine used for evaluation or training. Do not copy only the main database file while its WAL is active. Account opt-out stops
future processing; it does not remove audit history. In operational reads, a changed source record replaces its prior
version. Original versions remain as evidence for previously inferred checks.


The personal Following ledger uses `intake_check_revision` in `golem.sqlite`. Additive triggers record check creation and changes made by both current and previous server versions. Each revision holds the previous and current text, state, source IDs, discussion, stated date, and review time. User actions add their exact words and action to the same transaction; the private audit also records the complete correction and result. Stopped checks retain their evidence and history. Existing checks get an initial snapshot when this schema is added. The apps use the revision number to reject concurrent edits.

Automatic Gmail collection selects only incoming Primary inbox mail after Gmail filters and the owner's sent-mail context. Other categories, archived incoming mail, drafts, spam, and trash are excluded before body fetch and raw intake storage. A normal tool can still read older mail when the person or thread agent needs it; only eligible messages from such a read enter the intake ledger. Earlier stored source records remain historical evidence.

`intake_archive` maps each source account, conversation, calendar period, and destination channel to one source file. Its selected message IDs prevent unrelated private messages from entering a shared channel. Gmail uses its thread ID, Slack channels use their source thread ID, and Plaud uses its recording ID. WhatsApp conversations and Slack DMs or group DMs use one file per calendar day in the server's time zone, as the agenda does. The file keeps its ID when messages arrive or change. Source messages remain separate, complete evidence records in SQLite and the audit.

The archive stores pending membership and attachment IDs before completing a file update, so an interrupted write can resume. A matching generated filename recovers a file saved before its ID reached SQLite. Unchanged content is not written again. Supported attachments keep their file IDs across message edits. A conversation file that the person or an agent edited is never deleted, also when its sources are deleted. File versions use the same retained-version store as other Golem files.
