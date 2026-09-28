(() => {
  "use strict";

  const toast = document.getElementById("toast");
  let toastTimer;

  function showToast(text, kind) {
    if (!toast) return;
    toast.textContent = text;
    toast.className = `toast ${kind === "error" ? "error" : "ok"}`;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), kind === "error" ? 7000 : 3500);
  }

  async function post(url, body) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Non-JSON error page.
    }
    if (response.status === 401) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      throw new Error("Your session expired.");
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function updateCounter(textarea) {
    const counter = textarea.closest(".composer")?.querySelector(".counter");
    if (counter) counter.textContent = `${textarea.value.length}/${textarea.dataset.limit}`;
  }

  const BUSY = {
    draft: "Drafting…",
    "followup-draft": "Rewriting…",
    send: "Sending…",
    "followup-send": "Sending…",
    "send-all": "Sending…",
    fix: "Saving…",
    unlink: "Removing…",
    "add-to-issue": "Adding…",
    done: "Saving…",
    reopen: "Saving…",
    sync: "Checking…",
  };

  function value(card, selector) {
    return card?.querySelector(selector)?.value ?? "";
  }

  async function run(action, button, card) {
    const id = card?.dataset.reviewId;
    switch (action) {
      case "draft":
        return post(`/api/reviews/${id}/draft`);
      case "send":
        return post(`/api/reviews/${id}/reply`, { text: value(card, 'textarea[name="reply"]') });
      case "fix": {
        const issueId = value(card, '[name="issue_id"]');
        return post(`/api/reviews/${id}/fix`, {
          issueId,
          // A title only matters when this starts a new issue.
          title: issueId ? "" : value(card, '[name="issue_title"]'),
          note: value(card, '[name="fix_note"]'),
          version: value(card, '[name="fix_version"]'),
        });
      }
      case "unlink":
        return post(`/api/reviews/${id}/unlink`);
      case "add-to-issue": {
        const issueId = button.closest("[data-issue-id]")?.dataset.issueId;
        return post(`/api/issues/${issueId}/add`, { reviewIds: [button.dataset.reviewIdToAdd] });
      }
      case "done":
        return post(`/api/reviews/${id}/status`, { status: "done" });
      case "reopen":
        return post(`/api/reviews/${id}/status`, { status: "open" });
      case "followup-draft":
        return post(`/api/reviews/${id}/followup-draft`);
      case "followup-send":
        return post(`/api/reviews/${id}/followup`, { text: value(card, 'textarea[name="followup"]') });
      case "send-all":
        return post(`/api/apps/${button.dataset.appId}/followups/send`);
      case "sync":
        return post("/api/sync");
      default:
        return null;
    }
  }

  async function copyFrom(button) {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source.value ?? source.textContent);
    } catch {
      // Older browsers, or clipboard access refused: select it so Cmd/Ctrl+C works.
      source.focus();
      source.select?.();
      showToast("Press Cmd+C (or Ctrl+C) to copy.", "ok");
      return;
    }
    showToast("Copied.", "ok");
  }

  document.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("button[data-copy]");
    if (copyButton) {
      copyFrom(copyButton);
      return;
    }
    const button = event.target.closest("button[data-action]");
    if (!button || button.getAttribute("aria-busy") === "true") return;
    const action = button.dataset.action;
    const card = button.closest("[data-review-id]");
    const label = button.textContent;
    button.setAttribute("aria-busy", "true");
    button.textContent = BUSY[action] || "Working…";
    try {
      const data = await run(action, button, card);
      if (!data) return;
      if (data.html && card) {
        const holder = document.createElement("div");
        holder.innerHTML = data.html;
        const next = holder.firstElementChild;
        if (next) {
          card.replaceWith(next);
          next.querySelectorAll("textarea[data-limit]").forEach(updateCounter);
          if (action === "draft" || action === "followup-draft") next.querySelector("textarea")?.focus();
        }
      }
      if (data.message) showToast(data.message, "ok");
      if (data.reload) setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      showToast(error.message || "Something went wrong.", "error");
    } finally {
      if (button.isConnected) {
        button.removeAttribute("aria-busy");
        button.textContent = label;
      }
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches("textarea[data-limit]")) updateCounter(event.target);
  });

  document.addEventListener("change", async (event) => {
    const input = event.target;
    if (input.matches("input[type=file][data-fill]")) {
      const file = input.files && input.files[0];
      const target = input.form?.querySelector(`[name="${input.dataset.fill}"]`);
      if (file && target) target.value = (await file.text()).trim();
    } else if (input.matches("select[data-autosubmit]")) {
      input.form.submit();
    } else if (input.matches("select[data-issue-select]")) {
      // An existing issue brings its own fix note and version; a new one needs a title.
      const fields = input.closest(".fix-fields");
      const option = input.selectedOptions[0];
      const existing = Boolean(input.value);
      fields.querySelector(".issue-title-field").hidden = existing;
      fields.querySelector('[name="fix_note"]').value = existing ? option.dataset.note || "" : "";
      fields.querySelector('[name="fix_version"]').value = existing ? option.dataset.version || "" : "";
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (form.dataset.confirm && !window.confirm(form.dataset.confirm)) event.preventDefault();
  });

  // Landing page tour: the steps work as tabs over one screenshot slot (ARIA tabs pattern).
  for (const tour of document.querySelectorAll("[data-tour]")) {
    const tabs = [...tour.querySelectorAll('[role="tab"]')];
    const panels = tabs.map((tab) => document.getElementById(tab.getAttribute("aria-controls")));
    const select = (index, focus) => {
      tabs.forEach((tab, i) => {
        const active = i === index;
        tab.classList.toggle("is-active", active);
        tab.setAttribute("aria-selected", String(active));
        tab.tabIndex = active ? 0 : -1;
        panels[i].classList.toggle("is-active", active);
      });
      if (focus) tabs[index].focus();
    };
    tour.addEventListener("click", (event) => {
      const tab = event.target.closest('[role="tab"]');
      if (tab) select(tabs.indexOf(tab), false);
    });
    tour.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(document.activeElement);
      if (current === -1) return;
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (event.key in keys) {
        event.preventDefault();
        select((current + keys[event.key] + tabs.length) % tabs.length, true);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        select(event.key === "Home" ? 0 : tabs.length - 1, true);
      }
    });
    tour.classList.add("is-ready");
  }

  // Drop the flash message from the URL so a refresh doesn't repeat it.
  const url = new URL(window.location.href);
  if (url.searchParams.has("ok") || url.searchParams.has("err")) {
    url.searchParams.delete("ok");
    url.searchParams.delete("err");
    window.history.replaceState(null, "", url.pathname + (url.search ? url.search : "") + url.hash);
  }
})();
