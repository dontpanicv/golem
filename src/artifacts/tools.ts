import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { Artifact, Artifacts, ArtifactWorkspaces } from "./artifacts.ts";

const RUNTIME = `An artifact is one self-contained HTML page: a schedule, an invite, an explainer, a poll, a sign-up list, a game for the kids, or any small app. People open its link on their phones, often from WhatsApp, so make it mobile-first and good-looking. Put the CSS and JavaScript inline; scripts, styles, fonts, and pictures may also come from https URLs, such as a library from a CDN. The page cannot use fetch or reach other sites: it keeps data only through the \`golem\` object, which is ready when \`await golem.ready\` returns. Every call returns a promise.
- \`golem.me\`: { id, name, member } of the person looking. Members have their name; a public visitor's name is null until \`await golem.setName(name)\`, so ask for a name before you save anything that needs one.
- \`golem.mine.get(key)\`, \`.set(key, value)\`, \`.delete(key)\`, \`.list(prefix?)\`: data of the person looking, such as their vote, their score, or their progress. Only they can change it. \`list\` gives [{ key, value, updatedAt }].
- \`golem.everyone.list(prefix?)\`: the data of every visitor, read-only, as [{ visitor, name, key, value, updatedAt }]. Use it for results, a leaderboard, or who brings what.
- \`golem.shared.get/set/delete/list\`: one copy for everyone, such as game levels or a closed flag. Everyone reads it; only members and you change it.
Values are JSON, up to 64 KB each. A write replaces the value. Keep each person's answers in \`mine\`, so that people never overwrite each other. There are no live updates: to show what others do, call \`everyone.list\` again every few seconds. A call fails with an Error whose message says why; show it.`;

const idParameter = Type.String({ description: "The artifact id" });

/** The tools that let agents make artifacts in their channel, change them, and read the data their visitors keep. */
export function artifactTools(
  artifacts: Artifacts,
  workspaces: ArtifactWorkspaces,
  workspaceId: string
) {
  const threadOf = (conversationId: number) => {
    const thread = workspaces
      .threadsIn(workspaceId)
      .find((candidate) => candidate.conversationId === conversationId);
    if (!thread) {
      throw new Error("This tool works only in a thread.");
    }
    return thread;
  };
  /** The channel an artifact belongs to: the named one, or the thread's; null, the workspace, for the orchestrator. */
  const placeOf = (
    thread: { readonly id: string; readonly channelId: string },
    channel: string | undefined
  ) => {
    if (channel !== undefined) {
      const name = channel.replace(/^#/, "");
      const named = workspaces
        .channelsIn(workspaceId)
        .find((candidate) => candidate.name === name);
      if (!named) {
        throw new Error(
          `There is no channel #${name}. list_channels shows the channels.`
        );
      }
      return named.id;
    }
    return workspaces.orchestratorOf(workspaceId)?.id === thread.id
      ? null
      : thread.channelId;
  };
  const artifactOf = (id: string) => {
    const artifact = artifacts
      .inWorkspace(workspaceId)
      .find((candidate) => candidate.id === id);
    if (!artifact) {
      throw new Error(
        `There is no artifact ${id}. list_artifacts shows the artifacts.`
      );
    }
    return artifact;
  };
  const visibility = Type.Optional(
    Type.Union([Type.Literal("members"), Type.Literal("public")], {
      description:
        "members: only members of this workspace, signed in. public: anyone with the link, such as family on WhatsApp. Default members; choose public only when they want to share it outside the workspace.",
    })
  );

  return [
    defineTool({
      name: "create_artifact",
      description: `Make an artifact and give its link to the people. It belongs to the channel of this thread, or to another channel you name, and stays there after the thread is settled; the orchestrator's belong to the workspace. Before you make one, look for an artifact to change with list_artifacts or recall. ${RUNTIME}`,
      parameters: Type.Object({
        title: Type.String({
          description: "A short title; link previews show it",
        }),
        html: Type.String({ description: "The whole HTML document" }),
        visibility,
        channel: Type.Optional(
          Type.String({
            description:
              "The name of the channel it belongs to, such as recipes, when it is not this thread's channel",
          })
        ),
      }),
      // The request key comes from the task, so a rerun after a crash finds the artifact it made before.
      replay: "safe",
      execute: async ({ channel, ...args }, api) => {
        const thread = threadOf(api.conversationId);
        const artifact = artifacts.create(thread, placeOf(thread, channel), {
          ...args,
          requestKey: `${workspaceId}:${api.taskId}`,
        });
        return text(
          `Made the artifact.\n${describe(artifact)}\nShow it in your answer with ![${artifact.title}](artifact:${artifact.id}).`
        );
      },
    }),

    defineTool({
      name: "update_artifact",
      description:
        "Replace the HTML, title, or visibility of an artifact. Its data stays, so read it with artifact_data before you change how the page stores it.",
      parameters: Type.Object({
        id: idParameter,
        title: Type.Optional(Type.String()),
        html: Type.Optional(
          Type.String({ description: "The whole new HTML document" })
        ),
        visibility,
      }),
      replay: "safe",
      execute: async ({ id, ...changes }) =>
        text(
          `Changed the artifact.\n${describe(artifacts.update(workspaceId, artifactOf(id).id, changes))}`
        ),
    }),

    defineTool({
      name: "edit_artifact",
      description:
        "Change part of an artifact's HTML: replace the one place where `find` occurs with `replace`. Cheaper than update_artifact for small changes. read_artifact shows the HTML.",
      parameters: Type.Object({
        id: idParameter,
        find: Type.String({ description: "Text that occurs exactly once" }),
        replace: Type.String(),
      }),
      execute: async ({ id, find, replace }) => {
        const html = artifacts.html(artifactOf(id).id);
        const count = html.split(find).length - 1;
        if (count !== 1) {
          throw new Error(
            `The text occurs ${count} times; give text that occurs exactly once.`
          );
        }
        artifacts.update(workspaceId, id, {
          html: html.replace(find, () => replace),
        });
        return text("Changed the artifact.");
      },
    }),

    defineTool({
      name: "read_artifact",
      description: "The HTML of an artifact.",
      parameters: Type.Object({ id: idParameter }),
      replay: "safe",
      execute: async ({ id }) => text(artifacts.html(artifactOf(id).id)),
    }),

    defineTool({
      name: "list_artifacts",
      description:
        "List the artifacts of this workspace, newest first, with their links, channels, and the threads that made them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const channels = workspaces.channelsIn(workspaceId);
        const threads = workspaces.threadsIn(workspaceId);
        const list = artifacts.inWorkspace(workspaceId).map((artifact) => {
          const channel = channels.find(
            (candidate) => candidate.id === artifact.channelId
          );
          const thread = threads.find(
            (candidate) => candidate.id === artifact.threadId
          );
          const place = channel
            ? `Channel: #${channel.name}`
            : "The workspace's";
          return `${describe(artifact)}\n${place}\nMade in: [${thread?.title}](thread:${artifact.threadId})`;
        });
        return text(list.join("\n\n") || "This workspace has no artifacts.");
      },
    }),

    defineTool({
      name: "artifact_data",
      description:
        "Read the data an artifact keeps: the shared records (visitor null) and each visitor's records, with their names.",
      parameters: Type.Object({
        id: idParameter,
        prefix: Type.Optional(
          Type.String({ description: "Only keys that start with it" })
        ),
      }),
      replay: "safe",
      execute: async ({ id, prefix }) => {
        const records = artifacts.records(artifactOf(id).id, prefix);
        return text(
          records.length
            ? records.map((record) => JSON.stringify(record)).join("\n")
            : "The artifact keeps no data yet."
        );
      },
    }),

    defineTool({
      name: "set_artifact_data",
      description:
        "Write or delete a shared record of an artifact, such as its settings, the levels of a game, or a flag that closes a poll.",
      parameters: Type.Object({
        id: idParameter,
        key: Type.String(),
        value: Type.Unknown({
          description: "Any JSON value; null deletes the record",
        }),
      }),
      replay: "safe",
      execute: async ({ id, key, value }) => {
        const artifact = artifactOf(id);
        if (value === null || value === undefined) {
          artifacts.deleteRecord(artifact.id, "shared", key);
          return text("Deleted the record.");
        }
        artifacts.write(artifact.id, "shared", key, value);
        return text("Saved the record.");
      },
    }),
  ];
}

function describe(artifact: Artifact): string {
  return `${artifact.title} (id ${artifact.id}, ${artifact.visibility === "public" ? "anyone with the link" : "members only"}, ${artifact.visitors} visitors)\nLink: ${artifact.url}`;
}

function text(value: string) {
  return { output: [{ type: "text" as const, text: value }] };
}
