# Proactive Golem

Golem follows useful matters from accounts that their owner has enabled. A person can continue normal conversations.
They do not need to maintain a task list or set a routine for each expected reply.

## The process

1. **Collect.** Gmail, WhatsApp, Slack, and Plaud have read adapters. Each account is off until its owner turns on
   Read for me. Polls run every 15 minutes. The first poll starts one day back. Later polls use a durable cursor,
   an overlap, and bounded work. A failed or incomplete poll preserves its cursor. Raw results go to the audit.
2. **Select and batch.** Slack retains the person's messages, direct mentions, DMs, group DMs, and replies in
   threads where they wrote or were mentioned. The adapter resolves Slack thread roots and preserves cursors for
   deferred lookups and partial thread reads. General channel activity is excluded. Gmail and WhatsApp keep incoming
   and outgoing text regardless of whether Golem sent it. Each judge batch has at most six source conversations and
   normally 24,000 characters of new text. A larger individual message remains whole in its own batch.
3. **Recall and assess.** FTS5 and EmbeddingGemma find candidate subject chats. Recall adds only matching checks,
   at most twelve additional evidence records within 8,000 characters, and at most 6,000 characters of chat
   context. Latest chat messages come before prior summaries, so clipping
   preserves the latest state.
   The configured judge receives original text, direction, source IDs, bulk metadata, and attachment names/types/sizes.
   It also receives the facts that the family wrote and what Golem learned that the owner sees. These explain the
   evidence and carry the owner's wishes about what to watch or report; they are never evidence.
   There is no Qwen reader. Code validates destinations, evidence IDs, exact quotes, and times. A failed batch does
   not prevent unrelated batches from being assessed. Source text never gives tool instructions.
4. **Keep state.** Useful context goes into the existing private chat's stable prompt section. A useful new
   subject stays as a proposed destination in its queued review. Collection creates no subject topic or chat.
   Passive filing retains evidence without a discussion. Source files for a proposed new discussion wait until its
   review is confirmed. Other knowledge can remain as source evidence.
   An internal check keeps the unresolved question, original
   evidence, and a future time. No inferred task cards are added to Upcoming.
5. **Check time.** A minute timer finds due internal checks. Collection and related evidence run before assessment.
   An unresolved request, partial fulfilment, or undated commitment gets an internal review after three days; this is
   not a promised deadline. Unknown sending or delivery details are verified in the existing chat. Later reviews stay quiet
   unless a follow-up helps. A stated calendar-day period keeps the local wall time across a clock change.
6. **Confirm the destination and review.** Before creating a new discussion, Golem reads the relevant sources again
   and the judge checks whether the queued review still helps. It can suppress a handled matter or reuse an existing
   chat with a different title or source conversation. Recent chats and their summaries include destinations made
   earlier in the same batch. Only a confirmed useful review creates a subject chat, and only in one of the
   person's own private topics, or a new private topic and its first chat when none fits; a topic that others
   see is never offered for a new matter, and silent filing stays in the person's private topics too. This decision needs no person approval. Related queued updates
   are then grouped by their selected chat. A saved request id reuses a chat after an interrupted creation.
   A useful development adds a visible Golem source message, the email or other
   source as a file, and supported attachments to the existing subject chat. No agent starts on it: Golem is the
   person's second brain, not their worker, and the chat's agent works only when the person asks there. Normal
   filing stays silent. Nonurgent changes wait for the person's morning review (`src/intake/morning.ts`), once a day in
   the 08:00 Europe/Prague hour. Golem reads their source accounts again, then one model call plans all of the
   person's waiting updates together: it groups them by matter, puts each matter into its existing chat or one new
   chat, and drops what the newest sources show handled or stale. Each matter gets one Golem message with its
   source files in its chat, which says what changed, what it asks of the owner or of whom, and any stated
   deadline; no agent starts on it. The plan never analyses further or drafts. A matter that asks something of the
   owner gets a check; the morning summary nudges it every 2 days until new evidence shows it handled, or the owner
   says it is done, rejected, or someone else's (handled or stop in Following, or `intake_update`). Then the person's own Golem chat gets one
   summary with a link to each chat, and a notification. A plan that leaves an update out or names a chat or
   topic that was not given changes nothing, and the review is tried again after 15 minutes, then 30. After two
   failed plans, each update goes alone to its chat without a plan. A failing review has its own back-off, so the
   person's urgent updates never wait for it, and a summary that a try could not send goes at the next try. Other
   failed intake work waits 15 minutes, then twice as long each time it fails in a row, up to a day.
7. **Decide whether to notify.** Chat completion is silent, even when its answer is useful. The judge must supply
   a separate reason and exact source quote before a notification is eligible. After the answer, Golem reads the
   source accounts again and checks the proposed reason against the latest evidence. A later reply can suppress the
   notice while the useful answer stays in the chat. A source outage leaves the notice pending for retry. A confirmed
   notice opens the same chat. A `QUIET` answer stays quiet. Stable request ids prevent duplicate inputs, runs,
   files, or notifications on retry. There is no separate worker chat or result handoff. No source starts an agent, so no
   draft or other work is made unless the person asks in the chat.
8. **Return source findings.** Successful connector reads in a chat can add original source
   records to intake. Gmail thread reads decode MIME bodies and exclude drafts; WhatsApp message and search reads keep
   incoming and outgoing text; Slack reads keep the personal selection rule; Plaud note reads keep summaries only.
   The connector, not the agent, supplies the account and returned records. Only the owner of a still-enabled account
   can feed its reads back. Intake stores the evidence and a durable pending read in `intake_source_read`.
   A message that intake has not judged yet also gets the normal assessment, so a reply that an agent reads first
   still gets its follow-up. A message older than where the next poll starts is history that someone looked up: it stays
   evidence for the read, but it is never assessed as new and makes no check. Each read is assessed on the next intake tick: a bounded judge call updates or resolves
   the related open checks. This call cannot create checks,
   start chats, run another review, or notify. A partial answer leaves the remaining question open. Failed judgments
   retain their pending read and retry with backoff; a failed chat cannot block unrelated source-read assessments.
   Repeated reads reuse the evidence and assessment. These targeted reads do not advance polling coverage.

A source conversation is an email conversation, a WhatsApp chat, a Slack thread or DM, or a Plaud recording. A Golem
chat is a conversation about a subject. These are different. A source conversation can contain several subjects;
a subject can span several accounts and Golem chats.

## Example: a response within 30 days

Your outgoing email states that a builder has 30 calendar days to give a substantive response. Golem keeps that exact
source and a future check. A receipt acknowledgement leaves it open. A full reply in a new email conversation can
resolve it. A partial reply can leave the unanswered part open. Your statement that you resolved it by phone is also
evidence. At the due time, Golem looks for replies and checks source coverage. It can report a useful follow-up, or
state that it could not verify the account. It must not present a source outage as proof that nobody replied.

Business-day rules and periods that start on delivery need evidence of the rule and start. The model is instructed
to use an uncertain internal review if it cannot establish them. This system does not decide legal deadlines.

## Data and privacy

Operational state lives in `golem.sqlite`, in the `intake_*` tables. Current source versions have an FTS5 index.
Source reads reuse original message ids, timestamps, and attachment metadata where the connector supplies them.
Plaud note reads do not supply the recording date: `observedAt` marks their read time, which cannot start a response
period. Original returned tool data and the source-read judgment are also in the separate audit.
The chat and file search uses Bun's SQLite FTS5 plus the existing local semantic index. Czech keywords use the
standard Snowball stemmer; there is no guessed accent restoration. This change does not bundle a separate SQLite
library. On macOS, Bun still selects Apple's SQLite. FTS5 is enabled; this implementation needs no native extension.

Each record belongs to one member. A shared integration credential still produces private evidence for its owner.
An existing shared family chat may receive source material that matches its subject, as explicitly permitted.
Other people's private chats remain inaccessible. The posted update is visible in the matching chat. Any confirmed notification goes only to the account owner. Turning an account off stops its reads, checks,
and queued reviews. It keeps historical audit data. Deleted Golem chats are hidden from source recall.

An intake message starts a normal turn in its destination chat. Its agent has the same tools as a turn started by
the person, including connected-account search and attachment retrieval. The account owner remains the turn's person;
normal access checks and approvals still apply. Source text and attachments are untrusted data, never instructions.
Automatic turns cannot send a completion notification themselves, including through `notify`. The intake service
owns this decision. Approval requests for protected actions keep their normal rules.

Notification permission defaults to null. It requires one supported reason: the owner asked to be told; a substantive
reply changes a matter Golem was following and needs attention; an unresolved stated time arrived; or time-sensitive
preparation or a changed event needs attention now. Ordinary messages, mentions, unread status, important matters,
and an hour without a reply do not qualify alone. Internal review times do not count as promised deadlines. The morning
review uses the same rule. A silent chat update leaves future checks eligible for later notification. Only eligible
notifications incur an extra source read and final judge call. Conversation recall includes short replies such as
"Handled" even when they share no search words with the original request.

Intake first matches an existing subject chat. An unassigned review stores its proposal in
`intake_delivery.subject`; it does not create a destination until the final delivery assessment. When only a topic
fits, it starts the subject chat there. When neither fits, it creates a private topic and its first chat.
Topic names cover lasting subjects; chat titles
name specific matters. An invitation or ticket can justify a new chat, including a useful notice on the event day.
The chat agent can find older related mail and attachments with the connected account's normal tools. Intake has
no separate related-mail discovery process. Durable time checks still handle a missing reply or an approaching event
when no new source arrives. Source conversation links and the source FTS index keep known subjects available before semantic indexing catches up. A queued review and notification check pin their existing subject rather than searching for a new destination. Source files
are saved in the chosen topic. Replays reuse the topic, chat, source input, and notification.

`audit.sqlite` is a separate private database. It contains raw source results, exact model requests and responses,
model identity and usage, retrieval results, validated decisions, state changes, notices, supported attachment bytes,
agent context and source-review tool results, and corrections. A runtime event records source-file hashes. It contains
no integration credential store. [SQLite backup](data.md#audit-export) makes a consistent single file for replay on
another machine. This raw log supports later evaluation and training; it does not train a model by itself.

A turn reads intake as the person it answers, in any chat they see, also in a topic that others see: it can use
`intake_read` to explain what Golem is following, with every update that still waits for its chat or the morning
review; reading it delivers nothing. When the person writes in a chat, the updates that wait for it
from their accounts join that turn in its observed context, and count as delivered once that turn answers: a turn
that fails takes them again, and no delivery posts them meanwhile. Another member's
message never takes them. Ordinary-language corrections use
`intake_update` with the person's latest exact words. The same services have authenticated JSON endpoints for both
clients. The web and iOS account settings expose the same opt-in.

## Verification

The direct-judge revision passes its tests, lint, and backend and web type checks. Source tests cover Slack's own
messages, exact mentions, DMs, group DMs, participating-chat replies, unrelated-topic exclusion, deferred root
lookups, and partial chat cursors. Intake tests cover whole long email bodies, outgoing direction, attachment
metadata, bounded batches, per-batch retry isolation, scoped checks, and a queued review's fixed subject.
Intake does not read the messages that people write in Golem chats; agents apply corrections with `intake_update`.

Sequence tests cover a 30-day check across a restart, acknowledgements, replies across conversations, account
outages, repeated polls, silent due reviews, membership and owner isolation, resolved morning updates, opt-out,
edited source versions, shared-family subjects, and normal source-review tools and approvals. Conference sequences
cover existing private and shared topics, a new private topic, and name conflicts. Retrying a review creates
no second input or notification.

The configured judge also passes eleven invented notification examples in `evals/intake/notification-cases.ts`:
ordinary requests, a later owner reply, a mention, a stated period before and at its due time, an awaited substantive
reply, today's conference ticket, an explicitly requested update, and an unresolved claim without a known deadline.
The final notification phase also covers a confirmed event and the owner already handling it. These examples do
not establish a full-day false-alert rate.

Private captured-data replays retain the original inputs, raw audit, decisions, all chat activity, files, errors,
notification records, and reference usage. They run in a separate copy with external writes and real pushes disabled.
A cold-start replay is not a historical test of each 15-minute poll. A frozen source capture cannot prove that no
reply arrives after its cutoff. Production is not changed by these tests.

The earlier reader-based run is retained for comparison. It passed almost all source groups to the judge, while
unrelated recalled evidence made inputs large and queued subjects could drop out of recall. Those findings led to
code selection, direct bounded batches, scoped recall, and fixed review subjects. The whole uncommitted feature
still has structural warnings for growth, churn, and duplicate code; it does not pass a clean structural gate.

Source-read sequence tests cover an older answer found during a review, partial fulfilment, restart and retry,
account opt-out, account isolation, and rejection of drafts, fabricated quotes, new work, and response periods based
on a read time. The person-correction tool still requires the person's exact words. Agent answers and drafts never
become source evidence. Connector tools without a source observation adapter do not feed facts into this path.
Destination sequences cover passive filing, a proposal held until morning across restart, suppression after an owner
reply without new topics or files, reuse of a differently titled chat created after queuing, two proposals merged
into one chat review, and recovery after chat creation but before the queue binding was saved. Validation rejects
new checks, split subjects, and promoted notification reasons during the final destination assessment.

## Manual trial

Use the complete source snapshot with a separate configuration folder and a consistent copy of the data folder.
Do not point the trial at the running server's database. Give the trial its own `base_url` and port in `golem.toml`.
Keep the model service available as configured. To inspect recorded notifications without real pushes, omit the
trial's `[apns]` section. The account Settings control which accounts intake reads.

```sh
bun install --frozen-lockfile
GOLEM_CONFIG=/path/to/trial/config GOLEM_DATA=/path/to/trial/data bun start
```

Check the visible source messages and answers in Golem, use `intake_read` to inspect open questions, and keep the
trial's separate `audit.sqlite`. The source-read change needs no new model or manual check setup. The trial starts
normal Golem services, including routines and reminders. A source snapshot alone starts no service and copies no
credentials or personal data. Destination selection is automatic. The older captured-data reports describe the
earlier creation behavior; the delayed destination change needs a new live trial.


## Following and mail selection

Following is a personal view in both apps. It shows open checks, their complete supporting sources, the linked discussion when one exists, and the revision history. Handled resolves the check; Stop following leaves it stopped without claiming success. Reopen resumes monitoring. Undo restores the previous revision. A free-text correction uses the existing intake model and can change only the selected check. Every correction retains the person's exact words and before/after states. The next judge call receives these decisions and must not recreate a stopped matter. No correction creates a chat. An old revision or a revoked source cannot be used to expose another person's private context.

Gmail's automatic query is `after:<checkpoint> {in:inbox in:sent} -in:spam -in:trash -in:chats -in:drafts`: the mail the owner sees in their inbox, in every tab. The connector also checks each message's labels before it fetches the body. Incoming messages need INBOX; mail in the Promotions, Social, or Forums tab is marked bulk, and the judge decides. SENT keeps outgoing context. Excluded messages do not enter collection audit records or source files. The same admission rule applies when a normal Gmail thread read updates intake checks. Normal deliberate mail searches keep their full access.

## Source files

Source files represent conversations, rather than individual messages:

| Source | One Markdown file |
| --- | --- |
| Gmail | One source email thread |
| Slack channel | One source thread, including its selected replies |
| Slack DM or group DM | One conversation per local calendar day |
| WhatsApp | One conversation per local calendar day |
| Plaud | One meeting, with its latest summary |

New messages update the same file ID. Message edits replace their earlier text in that file. Each entry keeps its original source ID, date, sender, and source link. Attachments remain separate files and appear as links in the conversation file. Overlapping polls and retries do not add duplicate entries or files. The archive is scoped to the owner, account, and destination topic: a shared family review receives only messages selected for that topic. It does not receive the rest of a private conversation.

Older per-message source files stay as they are, so the links to them in earlier messages keep working. A Slack search records only its counts in the audit; the messages that intake keeps are recorded with the collection result.
