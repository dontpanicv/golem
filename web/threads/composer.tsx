import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import { Button } from "../ui/components.tsx";
import { Icon } from "../ui/icon.tsx";
import { showError } from "../ui/toast.tsx";

/**
 * A message box for text and files. Files are picked, dropped on it, or pasted into it. Enter sends; Shift+Enter adds a
 * line. With `clearAtOnce`, the box clears as the message is sent, as a sent message shows in the thread at once, and
 * gets its text back if it fails; otherwise it is busy until `onSend` ends. `onStop` adds a Stop button that shows while
 * `running`.
 */
export function Composer({
  placeholder,
  onSend,
  clearAtOnce = false,
  running = false,
  onStop,
}: {
  placeholder: string;
  onSend: (text: string, files: readonly File[]) => Promise<unknown>;
  clearAtOnce?: boolean;
  running?: boolean;
  onStop?: () => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly File[]>([]);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  const send = async () => {
    if (busy || !(text.trim() || files.length > 0)) {
      return;
    }
    const sent = { text, files };
    if (clearAtOnce) {
      setText("");
      setFiles([]);
    } else {
      setBusy(true);
    }
    try {
      await onSend(sent.text, sent.files);
      if (!clearAtOnce) {
        setText("");
        setFiles([]);
      }
    } catch (error) {
      showError(error);
      if (clearAtOnce) {
        setText((current) => current || sent.text);
        setFiles((current) => (current.length > 0 ? current : sent.files));
      }
    } finally {
      setBusy(false);
    }
  };
  const add = (added: FileList) =>
    setFiles((current) => [...current, ...added]);
  const onDrop = (event: DragEvent) => {
    setDropping(false);
    if (event.dataTransfer.files.length > 0) {
      event.preventDefault();
      add(event.dataTransfer.files);
    }
  };
  const onPaste = (event: ClipboardEvent) => {
    if (event.clipboardData.files.length > 0) {
      event.preventDefault();
      add(event.clipboardData.files);
    }
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: dropping files is a shortcut for the attach button
    <form
      aria-busy={busy || undefined}
      className="composer"
      data-dropping={dropping || undefined}
      onDragLeave={(event) =>
        event.currentTarget.contains(event.relatedTarget as Node) ||
        setDropping(false)
      }
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDropping(true);
        }
      }}
      onDrop={onDrop}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Message"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
        }}
        onPaste={onPaste}
        placeholder={placeholder}
        rows={1}
        value={text}
      />
      {files.length > 0 ? (
        <div className="file-chips">
          {files.map((file, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the same file can be picked twice
            <span className="file-chip" key={index}>
              <Icon name="attach" />
              <span>{file.name}</span>
              <button
                aria-label={`Remove ${file.name}`}
                className="file-chip-remove"
                onClick={() =>
                  setFiles((current) =>
                    current.filter((_, other) => other !== index)
                  )
                }
                type="button"
              >
                <Icon name="close" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="composer-actions">
        <Button
          data-file-pick
          icon="attach"
          label="Attach file"
          onClick={() => picker.current?.click()}
          size="tiny"
          variant="ghost"
        />
        <input
          hidden
          multiple
          onChange={(event) => {
            if (event.target.files) {
              add(event.target.files);
            }
            event.target.value = "";
          }}
          ref={picker}
          type="file"
        />
        <span className="spacer" />
        {onStop && running ? (
          <Button icon="stop" label="Stop" onClick={onStop} size="tiny" />
        ) : null}
        <Button
          icon="send"
          label="Send"
          shortcut="↵"
          size="tiny"
          type="submit"
          variant="primary"
        />
      </div>
    </form>
  );
}
