import {
  DropdownMenu,
  Select as RadixSelect,
  Tooltip as RadixTooltip,
} from "radix-ui";
import {
  type ComponentProps,
  createContext,
  type ReactNode,
  type SubmitEvent,
  useContext,
  useEffect,
  useRef,
} from "react";
import { Icon, type IconName } from "./icon.tsx";

// The design system's components. Looks are in public/styles.css, and the spec for each is in design/components.md.
// Menus, selects, and tooltips are Radix primitives with our looks.

export interface ButtonProps
  extends Omit<ComponentProps<"button">, "children"> {
  readonly label: string;
  readonly variant?: "primary" | "ghost" | "danger";
  readonly size?: "small" | "large" | "icon" | "tiny";
  readonly icon?: IconName;
  /** A shortcut shown in the tooltip of an icon button. */
  readonly shortcut?: string;
}

/** A button. Icon buttons carry their label as an accessible name and a tooltip. */
export function Button({
  label,
  variant,
  size,
  icon,
  shortcut,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconOnly = size === "icon" || size === "tiny";
  const classes = [
    "button",
    variant,
    iconOnly ? "icon-only" : size,
    size === "tiny" && "tiny",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  const button = (
    <button
      aria-label={iconOnly ? label : undefined}
      className={classes}
      type={type}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {!iconOnly && label}
    </button>
  );
  return iconOnly ? (
    <Tooltip label={label} shortcut={shortcut}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** A tooltip 450 ms after the pointer or keyboard focus arrives, 8 px below its target. */
export function Tooltip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          className="tooltip"
          collisionPadding={8}
          side="bottom"
          sideOffset={8}
        >
          {label}
          {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/** Within 300 ms of one tooltip closing, the next shows at once. */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={450} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export type MenuEntry =
  | {
      readonly kind: "action";
      readonly label: string;
      readonly onSelect: () => void;
      readonly icon?: IconName;
      readonly current?: boolean;
    }
  | { readonly kind: "separator" }
  | { readonly kind: "label"; readonly label: string };

/** An action menu opened by `trigger`, a button. */
export function Menu({
  trigger,
  entries,
  align = "end",
}: {
  trigger: ReactNode;
  entries: readonly MenuEntry[];
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          className="menu"
          collisionPadding={8}
          sideOffset={4}
        >
          {entries.map((entry, index) => {
            if (entry.kind === "separator") {
              return (
                <DropdownMenu.Separator
                  className="menu-separator"
                  // biome-ignore lint/suspicious/noArrayIndexKey: separators have nothing else to tell them apart
                  key={index}
                />
              );
            }
            if (entry.kind === "label") {
              return (
                // biome-ignore lint/a11y/noLabelWithoutControl: a menu's heading, a div
                <DropdownMenu.Label className="menu-label" key={entry.label}>
                  {entry.label}
                </DropdownMenu.Label>
              );
            }
            return (
              <DropdownMenu.Item
                aria-current={entry.current ? "true" : undefined}
                className="menu-item"
                key={entry.label}
                onSelect={entry.onSelect}
              >
                {entry.icon ? <Icon name={entry.icon} /> : null}
                <span className="label">{entry.label}</span>
                <span className="check">
                  <Icon name="check" />
                </span>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Our select: a trigger and a menu of options that opens over it, with the chosen option on the trigger's value. */
export function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <RadixSelect.Root onValueChange={onChange} value={value}>
      <RadixSelect.Trigger aria-label={label} className="select-trigger">
        <span data-popover-value>
          <RadixSelect.Value />
        </span>
        <Icon name="chevron" />
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content className="menu" position="item-aligned">
          <RadixSelect.Viewport>
            {options.map((option) => (
              <RadixSelect.Item
                className="menu-item"
                key={option.value}
                value={option.value}
              >
                <span className="label">
                  <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                </span>
                <span className="check">
                  <Icon name="check" />
                </span>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

/** A modal dialog with a form. It opens and closes at once; a click on the backdrop closes it. */
export function Dialog({
  open,
  onClose,
  title,
  submit,
  onSubmit,
  busy = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  /** The submit button; a dialog without one only shows its content. */
  submit?: string;
  /** Gets the form's fields. */
  onSubmit?: (form: FormData) => void;
  busy?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    if (open && !element.open) {
      element.showModal();
      element.querySelector<HTMLElement>("input, textarea")?.focus();
    } else if (!open && element.open) {
      element.close();
    }
  }, [open]);
  const send = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit?.(new FormData(event.currentTarget));
  };
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape closes the dialog
    <dialog
      aria-label={title}
      className="dialog"
      onClick={(event) => event.target === event.currentTarget && onClose()}
      onClose={onClose}
      ref={dialog}
    >
      {open ? (
        <form aria-busy={busy || undefined} onSubmit={send}>
          <header className="dialog-header">
            <h2>{title}</h2>
            <Button
              icon="close"
              label="Close"
              onClick={onClose}
              size="icon"
              variant="ghost"
            />
          </header>
          <div className="dialog-body">{children}</div>
          {submit ? (
            <footer className="dialog-footer">
              <Button label="Cancel" onClick={onClose} />
              <Button label={submit} type="submit" variant="primary" />
            </footer>
          ) : null}
        </form>
      ) : null}
    </dialog>
  );
}

export function TextField({
  label,
  large,
  ...input
}: ComponentProps<"input"> & { label: string; large?: boolean }) {
  return (
    <label className="field">
      {label}
      <input className={large ? "input large" : "input"} {...input} />
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <input
      aria-checked={checked}
      aria-label={label}
      checked={checked}
      className="switch"
      onChange={(event) => onChange(event.target.checked)}
      role="switch"
      type="checkbox"
    />
  );
}

/** The number of colors in `avatar` of design/tokens.json. */
const AVATAR_COLORS = 10;

/** A person's initial on a color picked by the sum of their name's code points, as iOS's `Avatar` picks it, or an agent's on the accent. */
export function Avatar({
  name,
  agent = false,
  size,
}: {
  name: string;
  agent?: boolean;
  size?: "small" | "large";
}) {
  let sum = 0;
  for (const character of name) {
    sum += character.codePointAt(0)!;
  }
  return (
    <span
      aria-hidden="true"
      className={["avatar", agent && "agent", size].filter(Boolean).join(" ")}
      style={
        agent
          ? undefined
          : ({
              "--avatar": `var(--avatar-${sum % AVATAR_COLORS})`,
            } as React.CSSProperties)
      }
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function Badge({
  label,
  tone,
}: {
  label: string;
  tone?: "success" | "warning" | "danger" | "accent";
}) {
  return (
    <span className={tone ? `badge ${tone}` : "badge"}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function Empty({ icon, title }: { icon: IconName; title: string }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <strong>{title}</strong>
    </div>
  );
}

export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="settings-card">{children}</div>;
}

/** A settings row: label and description on the left, `children`, the control, on the right. */
export function SettingsRow({
  label,
  description,
  lead,
  compact = false,
  children,
}: {
  label: string;
  description?: string | null;
  lead?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={compact ? "settings-row compact" : "settings-row"}>
      {lead ? <span className="settings-lead">{lead}</span> : null}
      <div className="settings-text">
        <strong>{label}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The content of a settings-style page: its title and sections. */
export function PageContent({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <div className="page-content">
        <h1 className="page-title">{title}</h1>
        {children}
      </div>
    </div>
  );
}

export function PageSection({
  title,
  children,
}: {
  title?: string;
  children: ReactNode;
}) {
  return (
    <section className="page-section">
      {title ? <h2>{title}</h2> : null}
      {children}
    </section>
  );
}

/** The threads whose agent works now, which the workspace's working stream reports. */
export const WorkingContext = createContext<ReadonlySet<string>>(new Set());

/** A spinner that shows while the agent of a thread works. */
export function WorkingSpinner({ threadId }: { threadId: string }) {
  return useContext(WorkingContext).has(threadId) ? (
    <span aria-label="Working" className="working-spinner" role="img" />
  ) : null;
}
