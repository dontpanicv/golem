// Golem interface behaviors: menus, selects, tooltips, dialogs, toasts, file pickers, and controls that submit on change.
// Everything uses event delegation on the document, so it keeps working when Datastar patches the page.
// Looks and timings follow design/components.md, measured from Linear.

const TOOLTIP_DELAY_MS = 450;
const TOOLTIP_WARM_MS = 300;
const TOOLTIP_CLOSE_MS = 200;
const TOAST_MS = 4000;
const TOAST_CLOSE_MS = 400;
const MENU_OFFSET = 4;
const VIEWPORT_MARGIN = 8;

// Menus and selects open and close at once.
//
// <div class="popover" data-popover [data-autosubmit] [data-align="start"]>
//   <button data-popover-trigger aria-haspopup="menu|listbox" aria-expanded="false">…</button>
//   <div class="menu" role="menu|listbox" tabindex="-1" hidden>
//     role="menuitem" links or buttons, or role="option" with data-value and aria-selected
//   </div>
//   <input type="hidden" name="…" value="…">   (selects only)
// </div>

let openPopover = null;
let typeahead = { text: "", until: 0 };

document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-popover-trigger]");
  if (trigger) {
    const popover = trigger.closest("[data-popover]");
    if (popover === openPopover) {
      closePopover(popover);
    } else {
      // A pointer highlights the item under it; an action menu opened by a click starts with none.
      openMenu(popover, event.detail === 0 ? "selected" : "pointer");
    }
    return;
  }
  const item = event.target.closest(
    "[data-popover] .menu [role=menuitem], [data-popover] .menu [role=option]"
  );
  if (item) {
    activate(item, true);
    return;
  }
  if (openPopover && !event.target.closest("[data-popover]")) {
    closePopover(openPopover, false);
  }
});

document.addEventListener("pointermove", (event) => {
  const item = event.target.closest(
    ".menu [role=menuitem], .menu [role=option]"
  );
  if (item && !item.hasAttribute("data-highlighted")) {
    highlight(item.closest(".menu"), item, false);
  }
});

document.addEventListener("keydown", (event) => {
  const trigger = event.target.closest?.("[data-popover-trigger]");
  if (trigger && ["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    openMenu(
      trigger.closest("[data-popover]"),
      event.key === "ArrowUp" ? "last" : "selected"
    );
    return;
  }
  if (!openPopover) {
    return;
  }
  const menu = openPopover.querySelector(".menu");
  const items = itemsOf(menu);
  const current = menu.querySelector("[data-highlighted]");
  const index = items.indexOf(current);
  const keys = {
    ArrowDown: () =>
      highlight(menu, items[Math.min(index + 1, items.length - 1)]),
    ArrowUp: () => highlight(menu, items[Math.max(index - 1, 0)]),
    Home: () => highlight(menu, items[0]),
    End: () => highlight(menu, items.at(-1)),
    Enter: () => current && activate(current),
    " ": () => current && activate(current),
    Escape: () => closePopover(openPopover),
    Tab: () => closePopover(openPopover, false),
  };
  if (keys[event.key]) {
    if (event.key !== "Tab") {
      event.preventDefault();
    }
    keys[event.key]();
  } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
    const now = Date.now();
    typeahead = {
      text:
        (now < typeahead.until ? typeahead.text : "") + event.key.toLowerCase(),
      until: now + 700,
    };
    const match = items.find((item) =>
      item.textContent.trim().toLowerCase().startsWith(typeahead.text)
    );
    if (match) {
      highlight(menu, match);
    }
  }
});

addEventListener(
  "resize",
  () => openPopover && closePopover(openPopover, false)
);
addEventListener(
  "scroll",
  (event) =>
    openPopover &&
    !openPopover.contains(event.target) &&
    closePopover(openPopover, false),
  true
);

function openMenu(popover, focus = "selected") {
  if (openPopover && openPopover !== popover) {
    closePopover(openPopover, false);
  }
  hideTooltip();
  const trigger = popover.querySelector("[data-popover-trigger]");
  const menu = popover.querySelector(".menu");
  const items = itemsOf(menu);
  const selected = items.find(
    (item) => item.getAttribute("aria-selected") === "true"
  );
  menu.hidden = false;
  if (menu.getAttribute("role") === "listbox") {
    placeOverTrigger(trigger, menu, selected ?? items[0]);
  } else {
    placeBelow(trigger, menu, popover.dataset.align === "start");
  }
  trigger.setAttribute("aria-expanded", "true");
  openPopover = popover;
  if (focus === "last") {
    highlight(menu, items.at(-1));
  } else if (focus === "selected" || selected) {
    highlight(menu, selected ?? items[0]);
  }
  menu.focus({ preventScroll: true });
}

function closePopover(popover, restoreFocus = true) {
  const trigger = popover.querySelector("[data-popover-trigger]");
  if (popover === openPopover) {
    openPopover = null;
  }
  trigger.setAttribute("aria-expanded", "false");
  popover.querySelector(".menu").hidden = true;
  if (restoreFocus) {
    trigger.focus({ preventScroll: true });
  }
}

/** Fixed positioning, so scrolling containers never clip the menu. Opens below, or above when there is no room. */
function placeBelow(trigger, menu, alignStart) {
  const anchor = trigger.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  const below =
    anchor.bottom + MENU_OFFSET + height <= innerHeight - VIEWPORT_MARGIN ||
    anchor.top - MENU_OFFSET - height < VIEWPORT_MARGIN;
  const left = alignStart ? anchor.left : anchor.right - width;
  menu.style.left = `${clamp(left, width, innerWidth)}px`;
  menu.style.top = `${below ? anchor.bottom + MENU_OFFSET : anchor.top - MENU_OFFSET - height}px`;
}

/** A select menu opens over its trigger with the selected option on the trigger's value, as macOS menus do. */
function placeOverTrigger(trigger, menu, selected) {
  const anchor = trigger.getBoundingClientRect();
  menu.style.minWidth = `${anchor.width}px`;
  menu.scrollTop = 0;
  const { width, height } = menu.getBoundingClientRect();
  const optionTop = selected ? selected.offsetTop : 0;
  const optionHeight = selected ? selected.offsetHeight : 0;
  const top = anchor.top + anchor.height / 2 - optionHeight / 2 - optionTop;
  // The option text sits 12 px in, the trigger's value 10 px.
  menu.style.left = `${clamp(anchor.left - 2, width, innerWidth)}px`;
  menu.style.top = `${clamp(top, height, innerHeight)}px`;
}

function clamp(start, size, limit) {
  return Math.max(
    VIEWPORT_MARGIN,
    Math.min(start, limit - size - VIEWPORT_MARGIN)
  );
}

function itemsOf(menu) {
  return [...menu.querySelectorAll("[role=menuitem], [role=option]")].filter(
    (item) => !item.hasAttribute("aria-disabled")
  );
}

function highlight(menu, item, scroll = true) {
  for (const other of menu.querySelectorAll("[data-highlighted]")) {
    other.removeAttribute("data-highlighted");
  }
  if (!item) {
    return;
  }
  item.setAttribute("data-highlighted", "");
  if (scroll) {
    item.scrollIntoView({ block: "nearest" });
  }
}

function activate(item, clicked = false) {
  const popover = item.closest("[data-popover]");
  if (item.getAttribute("role") === "option") {
    for (const option of popover.querySelectorAll("[role=option]")) {
      option.setAttribute("aria-selected", String(option === item));
    }
    popover.querySelector("[data-popover-value]").textContent =
      item.dataset.label ?? item.textContent.trim();
    const input = popover.querySelector("input[type=hidden]");
    input.value = item.dataset.value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    closePopover(popover);
    if (popover.hasAttribute("data-autosubmit")) {
      input.form?.requestSubmit();
    }
  } else {
    closePopover(popover, false);
    // Links and buttons inside menus do their own thing: navigate, submit, or open a dialog.
    if (!clicked) {
      item.click();
    }
  }
}

// Tooltips: <button data-tooltip="Search" data-shortcut="/">. One shows 450 ms after the pointer or keyboard
// focus arrives, 8 px below its target. Within 300 ms of one closing, the next shows at once and the old one goes.

let tooltip = null;
let tooltipTimer;
let tooltipWarmUntil = 0;

document.addEventListener("pointerover", (event) => {
  const target = event.target.closest("[data-tooltip]");
  if (target && event.pointerType !== "touch") {
    scheduleTooltip(target);
  }
});
document.addEventListener("pointerout", (event) => {
  const target = event.target.closest("[data-tooltip]");
  if (target && !target.contains(event.relatedTarget)) {
    hideTooltip();
  }
});
document.addEventListener("focusin", (event) => {
  const target = event.target.closest?.("[data-tooltip]");
  if (target?.matches(":focus-visible")) {
    scheduleTooltip(target);
  }
});
document.addEventListener("focusout", hideTooltip);
document.addEventListener("pointerdown", hideTooltip);

function scheduleTooltip(target) {
  clearTimeout(tooltipTimer);
  tooltipTimer = setTimeout(
    () => showTooltip(target),
    Date.now() < tooltipWarmUntil ? 0 : TOOLTIP_DELAY_MS
  );
}

function showTooltip(target) {
  if (!target.isConnected || openPopover?.contains(target)) {
    return;
  }
  for (const old of document.querySelectorAll(".tooltip")) {
    old.remove();
  }
  tooltip = document.createElement("div");
  tooltip.className = "tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.dataset.state = "open";
  tooltip.append(target.dataset.tooltip);
  if (target.dataset.shortcut) {
    const key = document.createElement("kbd");
    key.className = "kbd";
    key.textContent = target.dataset.shortcut;
    tooltip.append(key);
  }
  document.body.append(tooltip);
  const anchor = target.getBoundingClientRect();
  const { width, height } = tooltip.getBoundingClientRect();
  const below =
    anchor.bottom + MENU_OFFSET * 2 + height <= innerHeight - VIEWPORT_MARGIN;
  tooltip.dataset.side = below ? "bottom" : "top";
  tooltip.style.left = `${clamp(anchor.left + anchor.width / 2 - width / 2, width, innerWidth)}px`;
  tooltip.style.top = `${below ? anchor.bottom + MENU_OFFSET * 2 : anchor.top - MENU_OFFSET * 2 - height}px`;
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  if (!tooltip) {
    return;
  }
  const closing = tooltip;
  tooltip = null;
  closing.dataset.state = "closed";
  setTimeout(() => closing.remove(), TOOLTIP_CLOSE_MS);
  tooltipWarmUntil = Date.now() + TOOLTIP_WARM_MS;
}

// Dialogs open and close at once: <button data-dialog-open="new-channel"> opens <dialog id="new-channel">.

document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-dialog-open]");
  if (opener) {
    const dialog = document.getElementById(opener.dataset.dialogOpen);
    dialog.showModal();
    dialog
      .querySelector(
        "[autofocus], input, textarea, button:not([data-dialog-close])"
      )
      ?.focus();
    return;
  }
  const closer = event.target.closest("[data-dialog-close]");
  if (closer) {
    closer.closest("dialog").close();
  }
  // A click on the backdrop lands on the dialog element itself.
  else if (event.target.matches?.("dialog.dialog[open]")) {
    event.target.close();
  }
});

// Toasts: the server renders one after a redirect with ?error= or ?notice=, and showToast adds more. Each goes
// after 4 s, sooner on a click; the pointer on it keeps it.

const toastTimers = new WeakMap();

function startToasts() {
  for (const toast of document.querySelectorAll(
    "[data-toast]:not([data-state])"
  )) {
    toast.dataset.state = "open";
    scheduleToastDismissal(toast);
  }
  const url = new URL(location.href);
  if (url.searchParams.has("error") || url.searchParams.has("notice")) {
    url.searchParams.delete("error");
    url.searchParams.delete("notice");
    history.replaceState(history.state, "", url);
  }
}

function scheduleToastDismissal(toast) {
  clearTimeout(toastTimers.get(toast));
  toastTimers.set(
    toast,
    setTimeout(() => dismissToast(toast), TOAST_MS)
  );
}

document.addEventListener("click", (event) => {
  const toast = event.target.closest("[data-toast]");
  if (toast) {
    dismissToast(toast);
  }
});
document.addEventListener("pointerover", (event) => {
  const toast = event.target.closest("[data-toast]");
  if (toast && toast.dataset.state === "open") {
    clearTimeout(toastTimers.get(toast));
  }
});
document.addEventListener("pointerout", (event) => {
  const toast = event.target.closest("[data-toast]");
  if (
    toast &&
    toast.dataset.state === "open" &&
    !toast.contains(event.relatedTarget)
  ) {
    scheduleToastDismissal(toast);
  }
});

function dismissToast(toast) {
  if (toast.dataset.state === "closing") {
    return;
  }
  clearTimeout(toastTimers.get(toast));
  toast.dataset.state = "closing";
  setTimeout(() => toast.remove(), TOAST_CLOSE_MS);
}

/** The same markup as the server's toast in src/platform/ui/components.ts. */
function showToast(tone, text) {
  const toast = document.createElement("div");
  toast.className = `toast ${tone}`;
  toast.setAttribute("role", "status");
  toast.toggleAttribute("data-toast", true);
  const icon = document.createElement("span");
  icon.className = "toast-icon";
  const label = document.createElement("span");
  label.className = "toast-text";
  label.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  toast.append(icon, label, close);
  document.querySelector(".toasts")?.append(toast);
  startToasts();
}

// Buttons with data-copy="text" copy the text and confirm with a toast.

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) {
    return;
  }
  // The clipboard needs https or localhost, which sign-in needs too.
  await navigator.clipboard.writeText(button.dataset.copy);
  showToast("success", "Copied");
});

// A Datastar request that fails, such as a message that does not send, shows an error toast.

document.addEventListener("datastar-fetch", (event) => {
  if (event.detail.type === "error") {
    showToast("error", "The request failed. Try again.");
  }
});

// A form is busy while its request runs, such as a message with a large file: Datastar requests until they finish,
// plain posts until the next page loads.

document.addEventListener("datastar-fetch", (event) => {
  const form = event.detail.el.closest?.("form");
  if (event.detail.type === "started") {
    form?.setAttribute("aria-busy", "true");
  } else if (event.detail.type === "finished") {
    form?.removeAttribute("aria-busy");
  }
});

document.addEventListener("submit", (event) => {
  if (!event.defaultPrevented) {
    event.target.setAttribute("aria-busy", "true");
  }
});

// A page from the back-forward cache comes back as it was left.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    for (const form of document.querySelectorAll("form[aria-busy]")) {
      form.removeAttribute("aria-busy");
    }
  }
});

// Switches and checkboxes with data-autosubmit submit their form on change.

document.addEventListener("change", (event) => {
  if (event.target.matches("input[data-autosubmit]")) {
    event.target.form?.requestSubmit();
  }
});

// Single-key shortcuts: an element with data-hotkey="/" is clicked when that key is pressed outside a text field.

document.addEventListener("keydown", (event) => {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.target.closest?.("input, textarea, select, [contenteditable]")
  ) {
    return;
  }
  const target = document.querySelector(
    `[data-hotkey="${CSS.escape(event.key)}"]`
  );
  if (target) {
    event.preventDefault();
    target.click();
  }
});

startToasts();

// File pickers: <button data-file-pick> opens the <input type="file"> of its form. Files dropped on a
// [data-file-drop] area, or pasted into it, join its input. A [data-file-list] shows the picked files as chips from
// its form's <template data-file-chip>; each chip's [data-file-remove] button takes its file out.

document.addEventListener("click", (event) => {
  const picker = event.target.closest("[data-file-pick]");
  if (picker) {
    picker.form.querySelector("input[type=file]").click();
    return;
  }
  const remove = event.target.closest("[data-file-remove]");
  if (remove) {
    const form = remove.closest("form");
    const input = form.querySelector("input[type=file]");
    const index = [
      ...form.querySelectorAll("[data-file-list] .file-chip"),
    ].indexOf(remove.closest(".file-chip"));
    setFiles(
      input,
      [...input.files].filter((_, other) => other !== index)
    );
  }
});

document.addEventListener("change", (event) => {
  if (event.target.matches?.("input[type=file]")) {
    showPicked(event.target.form);
  }
});

document.addEventListener("reset", (event) => {
  // The fields clear after the reset event.
  setTimeout(() => showPicked(event.target));
});

document.addEventListener("dragover", (event) => {
  const area = event.target.closest?.("[data-file-drop]");
  if (area && event.dataTransfer.types.includes("Files")) {
    event.preventDefault();
    area.toggleAttribute("data-dropping", true);
  }
});

document.addEventListener("dragleave", (event) => {
  const area = event.target.closest?.("[data-file-drop]");
  if (area && !area.contains(event.relatedTarget)) {
    area.removeAttribute("data-dropping");
  }
});

document.addEventListener("drop", (event) => {
  const area = event.target.closest?.("[data-file-drop]");
  if (area && event.dataTransfer.files.length > 0) {
    event.preventDefault();
    area.removeAttribute("data-dropping");
    addFiles(area, event.dataTransfer.files);
  }
});

document.addEventListener("paste", (event) => {
  const area = event.target.closest?.("[data-file-drop]");
  if (area && event.clipboardData.files.length > 0) {
    event.preventDefault();
    addFiles(area, event.clipboardData.files);
  }
});

function addFiles(area, files) {
  const input = area.querySelector("input[type=file]");
  setFiles(input, [...input.files, ...files]);
}

/** Sets the files of an input and sends `change`, as picking them does: forms that upload on change upload them. */
function setFiles(input, files) {
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function showPicked(form) {
  const list = form?.querySelector("[data-file-list]");
  if (!list) {
    return;
  }
  const files = [...form.querySelector("input[type=file]").files];
  const template = form.querySelector("template[data-file-chip]");
  list.hidden = files.length === 0;
  list.replaceChildren(
    ...files.map((file) => {
      const chip = template.content.firstElementChild.cloneNode(true);
      chip.querySelector("span").textContent = file.name;
      chip
        .querySelector("[data-file-remove]")
        .setAttribute("aria-label", `Remove ${file.name}`);
      return chip;
    })
  );
}

// Elapsed time
//
// <span data-elapsed-since="<ms>">12s</span> counts up each second, as the server writes it.

setInterval(() => {
  for (const element of document.querySelectorAll("[data-elapsed-since]")) {
    element.textContent = duration(
      Date.now() - Number(element.dataset.elapsedSince)
    );
  }
}, 1000);

/** A time span as 8s, 2m 05s, or 1h 03m. */
function duration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

// Work in progress
//
// The steps of an agent at work keep the newest one in view, until the person scrolls up; scrolling back to the end
// follows again.

const unpinned = new WeakSet();

document.addEventListener(
  "scroll",
  (event) => {
    const steps = event.target;
    if (!(steps instanceof Element && steps.matches(".work-steps"))) {
      return;
    }
    if (steps.scrollHeight - steps.scrollTop - steps.clientHeight < 4) {
      unpinned.delete(steps);
    } else {
      unpinned.add(steps);
    }
  },
  true
);

new MutationObserver(() => {
  for (const steps of document.querySelectorAll(
    ".work.working > .work-steps"
  )) {
    if (!unpinned.has(steps)) {
      steps.scrollTop = steps.scrollHeight;
    }
  }
}).observe(document.body, { childList: true, subtree: true });
