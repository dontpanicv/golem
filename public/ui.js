// Golem interface behaviors: menus, selects, tooltips, dialogs, toasts, and controls that submit on change.
// Everything uses event delegation on the document, so it keeps working when Datastar patches the page.
// Looks and timings follow design/components.md.

const CLOSE_MS = 100;
const TOOLTIP_DELAY_MS = 500;
const TOOLTIP_WARM_MS = 300;
const TOAST_MS = 5000;

// Menus and selects
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
      openMenu(popover);
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
    highlight(item.closest(".menu"), item);
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
  const trigger = popover.querySelector("[data-popover-trigger]");
  const menu = popover.querySelector(".menu");
  menu.hidden = false;
  place(trigger, menu, popover.dataset.align === "start");
  menu.dataset.state = "open";
  trigger.setAttribute("aria-expanded", "true");
  openPopover = popover;
  const items = itemsOf(menu);
  const selected = items.find(
    (item) => item.getAttribute("aria-selected") === "true"
  );
  highlight(menu, focus === "last" ? items.at(-1) : (selected ?? items[0]));
  menu.focus({ preventScroll: true });
}

function closePopover(popover, restoreFocus = true) {
  const trigger = popover.querySelector("[data-popover-trigger]");
  const menu = popover.querySelector(".menu");
  if (popover === openPopover) {
    openPopover = null;
  }
  trigger.setAttribute("aria-expanded", "false");
  menu.dataset.state = "closed";
  setTimeout(() => {
    if (menu.dataset.state === "closed") {
      menu.hidden = true;
    }
  }, CLOSE_MS);
  if (restoreFocus) {
    trigger.focus({ preventScroll: true });
  }
}

/** Fixed positioning, so scrolling containers never clip the menu. Opens below, or above when there is no room. */
function place(trigger, menu, alignStart) {
  const anchor = trigger.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(anchor.width, 180)}px`;
  const { width, height } = menu.getBoundingClientRect();
  const below =
    anchor.bottom + 4 + height <= innerHeight - 8 ||
    anchor.top - 4 - height < 8;
  const left = alignStart ? anchor.left : anchor.right - width;
  menu.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  menu.style.top = `${below ? anchor.bottom + 4 : anchor.top - 4 - height}px`;
  menu.dataset.side = below ? "bottom" : "top";
}

function itemsOf(menu) {
  return [...menu.querySelectorAll("[role=menuitem], [role=option]")].filter(
    (item) => !item.hasAttribute("aria-disabled")
  );
}

function highlight(menu, item) {
  for (const other of menu.querySelectorAll("[data-highlighted]")) {
    other.removeAttribute("data-highlighted");
  }
  if (!item) {
    return;
  }
  item.setAttribute("data-highlighted", "");
  item.scrollIntoView({ block: "nearest" });
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

// Tooltips: <button data-tooltip="Search" data-shortcut="/">

let tooltip;
let tooltipTimer;
let tooltipWarmUntil = 0;

document.addEventListener("pointerover", (event) => {
  const target = event.target.closest("[data-tooltip]");
  if (target) {
    scheduleTooltip(target);
  }
});
document.addEventListener("pointerout", (event) => {
  if (
    event.target.closest("[data-tooltip]") &&
    !event.relatedTarget?.closest?.("[data-tooltip]")
  ) {
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
  tooltip ??= Object.assign(document.createElement("div"), {
    className: "tooltip",
    role: "tooltip",
  });
  const shortcut = target.dataset.shortcut
    ? `<span class="kbd">${escapeHtml(target.dataset.shortcut)}</span>`
    : "";
  tooltip.innerHTML = `${escapeHtml(target.dataset.tooltip)}${shortcut}`;
  document.body.append(tooltip);
  const anchor = target.getBoundingClientRect();
  const { width, height } = tooltip.getBoundingClientRect();
  const below = anchor.bottom + 6 + height <= innerHeight - 8;
  tooltip.style.left = `${Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, innerWidth - width - 8))}px`;
  tooltip.style.top = `${below ? anchor.bottom + 6 : anchor.top - 6 - height}px`;
  tooltip.dataset.state = "open";
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  if (tooltip?.isConnected) {
    tooltip.remove();
    tooltipWarmUntil = Date.now() + TOOLTIP_WARM_MS;
  }
}

// Dialogs: <button data-dialog-open="new-channel"> opens <dialog id="new-channel" class="dialog">

document.addEventListener("click", (event) => {
  const opener = event.target.closest("[data-dialog-open]");
  if (opener) {
    const dialog = document.getElementById(opener.dataset.dialogOpen);
    dialog.dataset.state = "open";
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
    closeDialog(closer.closest("dialog"));
  }
  // A click on the backdrop lands on the dialog element itself.
  else if (event.target.matches?.("dialog.dialog[open]")) {
    closeDialog(event.target);
  }
});

document.addEventListener(
  "cancel",
  (event) => {
    if (event.target.matches("dialog.dialog")) {
      event.preventDefault();
      closeDialog(event.target);
    }
  },
  true
);

function closeDialog(dialog) {
  dialog.dataset.state = "closing";
  setTimeout(() => dialog.close(), CLOSE_MS);
}

// Toasts: the server renders <div class="toast" data-toast> after a redirect with ?error= or ?notice=.

function startToasts() {
  for (const toast of document.querySelectorAll(
    "[data-toast]:not([data-state])"
  )) {
    toast.dataset.state = "open";
    setTimeout(() => dismissToast(toast), TOAST_MS);
  }
  const url = new URL(location.href);
  if (url.searchParams.has("error") || url.searchParams.has("notice")) {
    url.searchParams.delete("error");
    url.searchParams.delete("notice");
    history.replaceState(history.state, "", url);
  }
}

document.addEventListener("click", (event) => {
  const toast = event.target.closest("[data-toast]");
  if (toast) {
    dismissToast(toast);
  }
});

function dismissToast(toast) {
  toast.dataset.state = "closing";
  setTimeout(() => toast.remove(), 200);
}

// Buttons with data-copy="text" copy the text and confirm with a toast.

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) {
    return;
  }
  // The clipboard needs https or localhost, which sign-in needs too.
  await navigator.clipboard.writeText(button.dataset.copy);
  document
    .querySelector(".toasts")
    ?.insertAdjacentHTML(
      "beforeend",
      '<div class="toast success" role="status" data-toast><span class="dot"></span>Copied</div>'
    );
  startToasts();
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

function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`
  );
}

startToasts();
