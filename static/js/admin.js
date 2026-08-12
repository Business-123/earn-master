/* ============================================================
   EarnMaster — Admin console (advanced)
   Vanilla JS, no build step. Talks to the /api/admin/* endpoints.
   ============================================================ */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const loginScreen = $("#loginScreen");
  const dashboard = $("#dashboard");
  const loginForm = $("#loginForm");
  const loginError = $("#loginError");
  const loginSubmit = $("#loginSubmit");

  let usersCache = [];
  let tasksCache = [];
  let categoriesCache = [];

  // ---------------- helpers ----------------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function money(n) {
    const v = Number(n || 0);
    return v.toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dateFmt(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  }

  function toast(message, kind = "") {
    const el = $("#toast");
    el.textContent = message;
    el.className = "toast" + (kind ? ` toast-${kind}` : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function statusBadge(status) {
    const s = String(status || "").toLowerCase();
    let cls = "badge-neutral";
    if (["approved", "success", "credited", "active", "resolved"].includes(s)) cls = "badge-good";
    else if (["pending", "initialized", "held", "processing", "open"].includes(s)) cls = "badge-warn";
    else if (["rejected", "failed", "blocked", "amount_mismatch", "expired", "cancelled"].includes(s)) cls = "badge-bad";
    return `<span class="badge ${cls}">${escapeHtml(s || "unknown")}</span>`;
  }

  function severityBadge(sev) {
    const s = String(sev || "").toLowerCase();
    let cls = "badge-neutral";
    if (["high", "critical"].includes(s)) cls = "badge-bad";
    else if (["medium", "moderate"].includes(s)) cls = "badge-warn";
    else if (["low"].includes(s)) cls = "badge-good";
    return `<span class="badge ${cls}">${escapeHtml(s || "unknown")}</span>`;
  }

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function downloadCsv(filename, rows) {
    if (!rows.length) { toast("Nothing to export", "error"); return; }
    const headers = Object.keys(rows[0]);
    const escapeCell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------------- theme ----------------
  function initTheme() {
    const saved = localStorageSafeGet("em_admin_theme") || "dark";
    applyTheme(saved);
  }
  function localStorageSafeGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function localStorageSafeSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }
  function applyTheme(theme) {
    document.body.classList.toggle("theme-light", theme === "light");
    const btn = $("#themeToggle");
    if (btn) btn.textContent = theme === "light" ? "🌙" : "☀️";
    localStorageSafeSet("em_admin_theme", theme);
  }
  $("#themeToggle").addEventListener("click", () => {
    const isLight = document.body.classList.contains("theme-light");
    applyTheme(isLight ? "dark" : "light");
  });
  initTheme();

  // ---------------- sidebar collapse ----------------
  function initSidebar() {
    const tabbar = $("#adminTabbar");
    const main = $("#dashboardMain");
    const toggleBtn = $("#sidebarToggleBtn");
    if (!tabbar || !main || !toggleBtn) return;

    function applyCollapsed(collapsed) {
      tabbar.classList.toggle("collapsed", collapsed);
      main.classList.toggle("sidebar-collapsed", collapsed);
      toggleBtn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
      toggleBtn.setAttribute("aria-label", toggleBtn.title);
    }

    const saved = localStorageSafeGet("em_admin_sidebar_collapsed");
    applyCollapsed(saved === "1");

    toggleBtn.addEventListener("click", () => {
      const collapsed = !tabbar.classList.contains("collapsed");
      applyCollapsed(collapsed);
      localStorageSafeSet("em_admin_sidebar_collapsed", collapsed ? "1" : "0");
    });
  }
  initSidebar();

  // ---------------- modal confirm (generic) ----------------
  function confirmAction({
    title,
    body,
    needReason = false,
    confirmLabel = "Confirm",
    needAmount = false,
    amountLabel = "Amount (GHS)",
    amountValue = "",
    allowNegativeAmount = false,
    needText = false,
    textLabel = "Value",
    textValue = "",
    needTextarea = false,
    textareaLabel = "Value",
    textareaValue = "",
    needSelect = false,
    selectLabel = "Category",
    selectOptions = [],
  }) {
    return new Promise((resolve) => {
      const backdrop = $("#modalBackdrop");
      $("#modalTitle").textContent = title;
      $("#modalBody").textContent = body;

      const reasonField = $("#modalReasonField");
      const reasonInput = $("#modalReasonInput");
      reasonField.hidden = !needReason;
      reasonInput.value = "";

      const amountField = $("#modalAmountField");
      const amountInput = $("#modalAmountInput");
      $("#modalAmountLabel").textContent = amountLabel;
      amountField.hidden = !needAmount;
      amountInput.value = amountValue;
      amountInput.min = allowNegativeAmount ? "" : "0";

      const textField = $("#modalTextField");
      const textInput = $("#modalTextInput");
      $("#modalTextLabel").textContent = textLabel;
      textField.hidden = !needText;
      textInput.value = textValue;

      const textareaField = $("#modalTextareaField");
      const textareaInput = $("#modalTextareaInput");
      $("#modalTextareaLabel").textContent = textareaLabel;
      textareaField.hidden = !needTextarea;
      textareaInput.value = textareaValue;

      const selectField = $("#modalSelectField");
      const selectInput = $("#modalSelectInput");
      $("#modalSelectLabel").textContent = selectLabel;
      selectField.hidden = !needSelect;
      if (needSelect) {
        selectInput.innerHTML = selectOptions.map((o) =>
          `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`
        ).join("");
      }

      $("#modalConfirm").textContent = confirmLabel;
      backdrop.hidden = false;
      const toFocus = needText ? textInput : needAmount ? amountInput : null;
      if (toFocus) setTimeout(() => { toFocus.focus(); toFocus.select && toFocus.select(); }, 0);

      const cleanup = (result) => {
        backdrop.hidden = true;
        $("#modalCancel").onclick = null;
        $("#modalConfirm").onclick = null;
        resolve(result);
      };

      $("#modalCancel").onclick = () => cleanup(null);
      $("#modalConfirm").onclick = () => {
        const result = { reason: reasonInput.value.trim() };
        if (needAmount) {
          const amount = Number(amountInput.value);
          if (!amountInput.value.trim() || Number.isNaN(amount) || (!allowNegativeAmount && amount < 0)) {
            amountInput.focus();
            return;
          }
          result.amount = amount;
        }
        if (needText) {
          if (!textInput.value.trim()) { textInput.focus(); return; }
          result.text = textInput.value.trim();
        }
        if (needTextarea) {
          if (!textareaInput.value.trim()) { textareaInput.focus(); return; }
          result.textarea = textareaInput.value.trim();
        }
        if (needSelect) {
          result.select = selectInput.value;
        }
        cleanup(result);
      };
      const onKeydown = (ev) => {
        if (ev.key === "Escape") {
          document.removeEventListener("keydown", onKeydown);
          cleanup(null);
        }
      };
      document.addEventListener("keydown", onKeydown);
    });
  }

  // ---------------- auth ----------------
  async function checkSession() {
    try {
      const data = await api("/api/admin/ping");
      if (data.admin) {
        showDashboard();
        return;
      }
    } catch (e) { /* fall through to login */ }
    showLogin();
  }

  function closeModal() {
    const backdrop = $("#modalBackdrop");
    if (backdrop) backdrop.hidden = true;
    closeDrawer();
  }

  function showLogin() {
    closeModal();
    loginScreen.hidden = false;
    dashboard.hidden = true;
  }

  function showDashboard() {
    loginScreen.hidden = true;
    dashboard.hidden = false;
    loadOverview();
    loadUsers();
    loadWithdrawals();
    loadWithdrawalFeeSetting();
    loadPayments();
    loadTasks();
    loadCategories();
    loadLevels();
    loadRisk();
    loadAudit();
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    loginSubmit.disabled = true;
    loginSubmit.textContent = "Signing in…";
    try {
      const data = await api("/api/admin/login", {
        method: "POST",
        body: {
          username: $("#loginUsername").value.trim(),
          password: $("#loginPassword").value,
        },
      });
      $("#adminUsername").textContent = data.username || "";
      showDashboard();
    } catch (err) {
      loginError.textContent = err.message || "Invalid credentials";
      loginError.hidden = false;
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = "Sign in";
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    try { await api("/api/admin/logout"); } catch (e) { /* ignore */ }
    showLogin();
  });

  // ---------------- tabs ----------------
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      $$(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`#panel-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // ---------------- overview ----------------
  async function loadOverview() {
    try {
      const data = await api("/api/admin/overview");
      $("#statTotalUsers").textContent = data.total_users ?? "–";
      $("#statBlockedUsers").textContent = data.blocked_users ?? "–";
      $("#statPendingWithdrawals").textContent = data.pending_withdrawals ?? "–";
      $("#statPendingPayments").textContent = data.pending_payments ?? "–";
      $("#statTotalBalance").textContent = money(data.total_balance);
    } catch (err) {
      toast(err.message, "error");
    }
    loadAnalytics();
  }

  async function loadAnalytics() {
    try {
      const data = await api("/api/admin/analytics");
      renderBarChart($("#signupsChart"), data.signups_by_day, "day", "n");
      renderBarChart($("#revenueChart"), data.revenue_by_day, "day", "total");
      renderTopCategories(data.top_categories || []);
    } catch (err) {
      /* analytics is a nice-to-have; fail quietly */
    }
  }

  function renderBarChart(svg, rows, keyField, valField) {
    if (!svg) return;
    svg.innerHTML = "";
    if (!rows || !rows.length) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", "280"); t.setAttribute("y", "80");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("class", "axis-label");
      t.textContent = "No data yet";
      svg.appendChild(t);
      return;
    }
    const W = 560, H = 160, padBottom = 22, padTop = 10;
    const max = Math.max(1, ...rows.map((r) => Number(r[valField] || 0)));
    const barW = W / rows.length;
    rows.forEach((r, i) => {
      const val = Number(r[valField] || 0);
      const h = ((H - padBottom - padTop) * val) / max;
      const x = i * barW + barW * 0.15;
      const w = barW * 0.7;
      const y = H - padBottom - h;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", x.toFixed(1));
      rect.setAttribute("y", y.toFixed(1));
      rect.setAttribute("width", w.toFixed(1));
      rect.setAttribute("height", Math.max(1, h).toFixed(1));
      rect.setAttribute("rx", "2");
      rect.setAttribute("class", "bar");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${r[keyField]}: ${val}`;
      rect.appendChild(title);
      svg.appendChild(rect);

      if (i % Math.ceil(rows.length / 7 || 1) === 0) {
        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", (x + w / 2).toFixed(1));
        label.setAttribute("y", (H - 6).toFixed(1));
        label.setAttribute("class", "value-label");
        label.textContent = String(r[keyField]).slice(5);
        svg.appendChild(label);
      }
    });
  }

  function renderTopCategories(rows) {
    const el = $("#topCategoriesList");
    if (!rows.length) {
      el.innerHTML = `<p class="hint">No completed tasks yet.</p>`;
      return;
    }
    const max = Math.max(1, ...rows.map((r) => Number(r.n || 0)));
    el.innerHTML = rows.map((r) => `
      <div class="bar-list-row">
        <span>${escapeHtml(r.display_name)}</span>
        <span class="bar-list-track"><span class="bar-list-fill" style="width:${((r.n / max) * 100).toFixed(0)}%"></span></span>
        <span class="bar-list-count">${r.n}</span>
      </div>
    `).join("");
  }

  // ---------------- users ----------------
  async function loadUsers() {
    const tbody = $("#usersTableBody");
    try {
      const users = await api("/api/admin/users");
      usersCache = users;
      renderUsers(users);
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  function renderUsers(users) {
    const tbody = $("#usersTableBody");
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No users yet.</td></tr>`;
      return;
    }
    tbody.innerHTML = users.map((u) => `
      <tr class="row-clickable" data-open-user="${escapeHtml(u.user_id)}">
        <td>
          <span class="cell-name">${escapeHtml(u.full_name || "N/A")}</span>
          <span class="cell-sub">${escapeHtml(u.user_id)}</span>
        </td>
        <td class="mono">${escapeHtml(u.phone || "—")}</td>
        <td>${escapeHtml(u.email || "—")}</td>
        <td class="mono">GHS ${money(u.balance)}</td>
        <td>${dateFmt(u.created_at)}</td>
        <td>${statusBadge(u.blocked ? "blocked" : "active")}</td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm ${u.blocked ? "btn-approve" : "btn-reject"}" data-toggle-block="${escapeHtml(u.user_id)}" data-blocked="${u.blocked ? "1" : "0"}">
              ${u.blocked ? "Unblock" : "Block"}
            </button>
          </div>
        </td>
      </tr>
    `).join("");
  }

  $("#userSearch").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) { renderUsers(usersCache); return; }
    const filtered = usersCache.filter((u) =>
      [u.full_name, u.phone, u.email, u.user_id].some((v) => String(v || "").toLowerCase().includes(q))
    );
    renderUsers(filtered);
  });

  $("#exportUsersCsv").addEventListener("click", () => {
    downloadCsv("users.csv", usersCache.map((u) => ({
      user_id: u.user_id,
      full_name: u.full_name || "",
      phone: u.phone || "",
      email: u.email || "",
      balance: u.balance,
      created_at: u.created_at || "",
      blocked: u.blocked ? "yes" : "no",
    })));
  });

  // global search jumps straight to a user's drawer
  $("#globalSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const match = usersCache.find((u) =>
      [u.full_name, u.phone, u.email, u.user_id].some((v) => String(v || "").toLowerCase().includes(q))
    );
    if (match) {
      openUserDrawer(match.user_id);
      e.target.value = "";
    } else {
      toast("No matching user found", "error");
    }
  });

  document.addEventListener("click", async (e) => {
    const row = e.target.closest("[data-open-user]");
    if (row && !e.target.closest("[data-toggle-block]")) {
      openUserDrawer(row.dataset.openUser);
      return;
    }

    const btn = e.target.closest("[data-toggle-block]");
    if (!btn) return;
    e.stopPropagation();
    const userId = btn.dataset.toggleBlock;
    const wantBlock = btn.dataset.blocked === "0";
    const result = await confirmAction({
      title: wantBlock ? "Block user" : "Unblock user",
      body: wantBlock
        ? `${userId} will be signed out immediately and unable to log in.`
        : `${userId} will regain full access to the app.`,
      needReason: wantBlock,
      confirmLabel: wantBlock ? "Block" : "Unblock",
    });
    if (!result) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/toggle-block`, {
        method: "POST",
        body: { blocked: wantBlock, reason: result.reason || undefined },
      });
      toast(wantBlock ? "User blocked" : "User unblocked", "good");
      await Promise.all([loadUsers(), loadOverview()]);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- user detail drawer ----------------
  function closeDrawer() {
    const backdrop = $("#userDrawerBackdrop");
    if (backdrop) backdrop.hidden = true;
  }

  $("#drawerClose").addEventListener("click", closeDrawer);
  $("#userDrawerBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "userDrawerBackdrop") closeDrawer();
  });

  async function openUserDrawer(userId) {
    const backdrop = $("#userDrawerBackdrop");
    const body = $("#drawerBody");
    $("#drawerUserId").textContent = userId;
    $("#drawerUserName").textContent = "Loading…";
    body.innerHTML = `<div class="empty-row">Loading…</div>`;
    backdrop.hidden = false;

    try {
      const data = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
      renderDrawer(userId, data);
    } catch (err) {
      body.innerHTML = `<div class="empty-row">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderDrawer(userId, data) {
    const u = data.user;
    $("#drawerUserName").textContent = u.full_name || "N/A";

    const perms = [
      ["can_tasks", "Can do tasks", "Allow this user to submit task answers"],
      ["can_deposit", "Can deposit", "Allow level-unlock / final-stage payments"],
      ["can_withdraw", "Can withdraw", "Allow withdrawal requests"],
      ["flagged", "Flagged for review", "Marks the account for manual review"],
    ];

    const levelsHtml = (data.levels || []).map((lv) => `
      <div class="mini-log-item">
        <strong>Level ${lv.level_number}</strong> — ${escapeHtml(lv.status)}
        <div class="mini-log-item-meta">
          Tasks ${lv.total_tasks_completed_count || 0}/${lv.total_task_count} ·
          Unlock GHS ${money(lv.unlock_fee)} · Reward GHS ${money(lv.completion_reward)}
          ${lv.is_completed ? " · Completed" : ""}
        </div>
      </div>
    `).join("") || `<p class="hint">No levels started yet.</p>`;

    const notesHtml = (data.notes || []).map((n) => `
      <div class="note-item">
        ${escapeHtml(n.note)}
        <div class="note-item-meta">${escapeHtml(n.created_by || "admin")} · ${dateFmt(n.created_at)}</div>
      </div>
    `).join("") || `<p class="hint">No notes yet.</p>`;

    const flagsHtml = (data.risk_flags || []).map((f) => `
      <div class="mini-log-item">
        ${severityBadge(f.severity)} ${escapeHtml(f.title)}
        <div class="mini-log-item-meta">${escapeHtml(f.category)} · ${statusBadge(f.status)} · ${dateFmt(f.created_at)}</div>
      </div>
    `).join("") || `<p class="hint">No risk flags.</p>`;

    const auditHtml = (data.audit_log || []).slice(0, 15).map((a) => `
      <div class="mini-log-item">
        ${escapeHtml(a.summary)}
        <div class="mini-log-item-meta">${escapeHtml(a.actor_id || "system")} · ${dateFmt(a.created_at)}</div>
      </div>
    `).join("") || `<p class="hint">No recorded actions yet.</p>`;

    $("#drawerBody").innerHTML = `
      <div class="drawer-section">
        <div class="drawer-grid">
          <div class="drawer-stat">
            <span class="drawer-stat-label">Balance</span>
            <span class="drawer-stat-value">GHS ${money(u.balance)}</span>
          </div>
          <div class="drawer-stat">
            <span class="drawer-stat-label">Status</span>
            <span class="drawer-stat-value">${statusBadge(u.account_status)}</span>
          </div>
          <div class="drawer-stat">
            <span class="drawer-stat-label">Phone</span>
            <span class="drawer-stat-value mono" style="font-size:12.5px;">${escapeHtml(u.phone || "—")}</span>
          </div>
          <div class="drawer-stat">
            <span class="drawer-stat-label">Pending withdrawals</span>
            <span class="drawer-stat-value">GHS ${money(data.pending_withdrawals?.total)} (${data.pending_withdrawals?.count || 0})</span>
          </div>
        </div>
        <div class="action-row">
          <button class="btn btn-sm btn-approve" id="drawerCreditBtn">Credit balance</button>
          <button class="btn btn-sm btn-reject" id="drawerDebitBtn">Debit balance</button>
        </div>
      </div>

      <div class="drawer-section">
        <span class="drawer-section-title">Permissions</span>
        ${perms.map(([key, label, sub]) => `
          <div class="toggle-row">
            <div>
              <span class="toggle-row-label">${label}</span>
              <span class="toggle-row-sub">${sub}</span>
            </div>
            <label class="switch">
              <input type="checkbox" data-perm-toggle="${key}" ${u[key] ? "checked" : ""}>
              <span class="switch-track"></span>
            </label>
          </div>
        `).join("")}
      </div>

      <div class="drawer-section">
        <span class="drawer-section-title">Levels</span>
        ${levelsHtml}
      </div>

      <div class="drawer-section">
        <span class="drawer-section-title">Admin notes</span>
        ${notesHtml}
        <div class="note-add-row">
          <input type="text" id="drawerNoteInput" placeholder="Add an internal note…">
          <button class="btn btn-sm btn-primary" id="drawerNoteSubmit">Add</button>
        </div>
      </div>

      <div class="drawer-section">
        <span class="drawer-section-title">Risk flags</span>
        ${flagsHtml}
      </div>

      <div class="drawer-section">
        <span class="drawer-section-title">Recent activity</span>
        ${auditHtml}
      </div>
    `;

    $("#drawerCreditBtn").addEventListener("click", () => adjustBalance(userId, 1));
    $("#drawerDebitBtn").addEventListener("click", () => adjustBalance(userId, -1));

    $$("[data-perm-toggle]", $("#drawerBody")).forEach((input) => {
      input.addEventListener("change", async () => {
        const key = input.dataset.permToggle;
        input.disabled = true;
        try {
          await api(`/api/admin/users/${encodeURIComponent(userId)}/permissions`, {
            method: "POST",
            body: { [key]: input.checked },
          });
          toast("Permission updated", "good");
        } catch (err) {
          input.checked = !input.checked;
          toast(err.message, "error");
        } finally {
          input.disabled = false;
        }
      });
    });

    $("#drawerNoteSubmit").addEventListener("click", async () => {
      const input = $("#drawerNoteInput");
      const note = input.value.trim();
      if (!note) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}/notes`, {
          method: "POST",
          body: { note },
        });
        input.value = "";
        toast("Note added", "good");
        openUserDrawer(userId);
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  async function adjustBalance(userId, sign) {
    const result = await confirmAction({
      title: sign > 0 ? "Credit balance" : "Debit balance",
      body: sign > 0
        ? "This adds funds directly to the user's wallet balance."
        : "This removes funds directly from the user's wallet balance.",
      needAmount: true,
      amountLabel: "Amount (GHS)",
      needReason: true,
      confirmLabel: sign > 0 ? "Credit" : "Debit",
    });
    if (!result) return;
    if (!result.reason) {
      toast("A reason is required for balance adjustments", "error");
      return;
    }
    try {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/balance`, {
        method: "POST",
        body: { amount: sign * Math.abs(result.amount), reason: result.reason },
      });
      toast("Balance updated", "good");
      await Promise.all([loadUsers(), loadOverview()]);
      openUserDrawer(userId);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  // ---------------- withdrawals ----------------
  async function loadWithdrawals() {
    const tbody = $("#withdrawalsTableBody");
    try {
      const rows = await api("/api/admin/withdrawals");
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No withdrawal requests yet.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((r) => `
        <tr>
          <td>
            <span class="cell-name">${escapeHtml(r.user_state?.user_id || r.user_id || "—")}</span>
            <span class="cell-sub">${escapeHtml(r.user_state?.email || "")}</span>
          </td>
          <td class="mono">${money(r.amount)}</td>
          <td>${escapeHtml(r.network || "—")}</td>
          <td class="mono">${escapeHtml(r.number || "—")}</td>
          <td>${escapeHtml(r.name || "—")}</td>
          <td>${dateFmt(r.created_at)}</td>
          <td>${statusBadge(r.status)}</td>
          <td>
            ${r.status === "pending" ? `
              <div class="row-actions">
                <button class="btn btn-sm btn-approve" data-withdrawal-decision="approved" data-id="${escapeHtml(r.id)}">Approve</button>
                <button class="btn btn-sm btn-reject" data-withdrawal-decision="rejected" data-id="${escapeHtml(r.id)}">Reject</button>
              </div>
            ` : ""}
          </td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshWithdrawals").addEventListener("click", loadWithdrawals);

  // ---------------- withdrawal verification fee ----------------
  async function loadWithdrawalFeeSetting() {
    const input = $("#withdrawalFeeInput");
    if (!input) return;
    try {
      const data = await api("/api/admin/settings/withdrawal-verification-fee");
      input.value = Number(data.fee ?? 0).toFixed(2);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const saveWithdrawalFeeBtn = $("#saveWithdrawalFeeBtn");
  if (saveWithdrawalFeeBtn) {
    saveWithdrawalFeeBtn.addEventListener("click", async () => {
      const input = $("#withdrawalFeeInput");
      const fee = Number(input?.value);
      if (!Number.isFinite(fee) || fee < 0) {
        toast("Enter a valid fee amount.", "error");
        return;
      }
      saveWithdrawalFeeBtn.disabled = true;
      try {
        const data = await api("/api/admin/settings/withdrawal-verification-fee", {
          method: "POST",
          body: { fee },
        });
        input.value = Number(data.fee ?? fee).toFixed(2);
        toast("Withdrawal verification fee updated", "good");
      } catch (err) {
        toast(err.message, "error");
      } finally {
        saveWithdrawalFeeBtn.disabled = false;
      }
    });
  }

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-withdrawal-decision]");
    if (!btn) return;
    const decision = btn.dataset.withdrawalDecision;
    const id = btn.dataset.id;
    const result = await confirmAction({
      title: decision === "approved" ? "Approve withdrawal" : "Reject withdrawal",
      body: decision === "approved"
        ? "This will mark the withdrawal as paid out."
        : "The reserved amount will be returned to the user's balance.",
      needReason: decision === "rejected",
      confirmLabel: decision === "approved" ? "Approve" : "Reject",
    });
    if (!result) return;
    btn.closest(".row-actions").querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api(`/api/admin/withdrawals/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body: { decision, reason: result.reason || undefined },
      });
      toast(`Withdrawal ${decision}`, "good");
      await Promise.all([loadWithdrawals(), loadOverview()]);
    } catch (err) {
      toast(err.message, "error");
      btn.closest(".row-actions")?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });

  // ---------------- payments ----------------
  async function loadPayments() {
    const tbody = $("#paymentsTableBody");
    try {
      const rows = await api("/api/admin/payments");
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No payments yet.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((p) => `
        <tr>
          <td>
            <span class="cell-name">${escapeHtml(p.full_name || "N/A")}</span>
            <span class="cell-sub">${escapeHtml(p.user_id || "")}</span>
          </td>
          <td>${escapeHtml(p.payment_type || p.type || "—")}</td>
          <td class="mono">${money(p.paid_amount ?? p.amount)}</td>
          <td class="mono">${escapeHtml(p.reference || "—")}</td>
          <td>${escapeHtml(p.provider || "—")}</td>
          <td>${dateFmt(p.created_at)}</td>
          <td>${statusBadge(p.status)}</td>
          <td>
            ${p.status === "pending" ? `
              <div class="row-actions">
                <button class="btn btn-sm btn-approve" data-payment-decision="approve" data-ref="${escapeHtml(p.reference)}">Approve</button>
                ${p.source !== "manual_payment" ? `<button class="btn btn-sm btn-reject" data-payment-decision="reject" data-ref="${escapeHtml(p.reference)}">Reject</button>` : ""}
              </div>
            ` : ""}
          </td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshPayments").addEventListener("click", loadPayments);

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-payment-decision]");
    if (!btn) return;
    const decision = btn.dataset.paymentDecision;
    const ref = btn.dataset.ref;
    const result = await confirmAction({
      title: decision === "approve" ? "Approve payment" : "Reject payment",
      body: decision === "approve"
        ? "This will confirm the payment and credit the user."
        : "This payment will be marked as rejected.",
      needReason: decision === "reject",
      confirmLabel: decision === "approve" ? "Approve" : "Reject",
    });
    if (!result) return;
    btn.closest(".row-actions").querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      await api(`/api/admin/payments/${encodeURIComponent(ref)}/decision`, {
        method: "POST",
        body: { decision, reason: result.reason || undefined },
      });
      toast(`Payment ${decision}d`, "good");
      await Promise.all([loadPayments(), loadOverview()]);
    } catch (err) {
      toast(err.message, "error");
      btn.closest(".row-actions")?.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });

  // ---------------- tasks ----------------
  async function loadCategories() {
    try {
      categoriesCache = await api("/api/admin/task-categories");
    } catch (e) { categoriesCache = []; }
  }

  async function loadTasks() {
    const tbody = $("#tasksTableBody");
    try {
      const rows = await api("/api/admin/tasks");
      tasksCache = rows;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No tasks yet.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((t) => `
        <tr>
          <td><span class="cell-name">${escapeHtml(t.title)}</span></td>
          <td>${escapeHtml(t.category_key || "—")}</td>
          <td class="mono">GHS ${money(t.reward)}</td>
          <td class="mono">${t.sort_order}</td>
          <td>${statusBadge(t.is_active ? "active" : "blocked")}</td>
          <td>
            <div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-edit-task="${t.id}">Edit</button>
              <button class="btn btn-sm btn-approve" data-edit-task-reward="${t.id}" data-current-reward="${t.reward}" data-title="${escapeHtml(t.title)}">
                Reward
              </button>
              <button class="btn btn-sm ${t.is_active ? "btn-reject" : "btn-approve"}" data-toggle-task-active="${t.id}" data-active="${t.is_active ? "1" : "0"}">
                ${t.is_active ? "Disable" : "Enable"}
              </button>
            </div>
          </td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshTasks").addEventListener("click", loadTasks);

  $("#newTaskBtn").addEventListener("click", async () => {
    const catOptions = categoriesCache.length
      ? categoriesCache.map((c) => ({ value: c.category_key, label: c.display_name }))
      : [{ value: "headline_classifier", label: "Headline Classifier" }];

    const result = await confirmAction({
      title: "New task",
      body: "Create a new bonus task users can complete for a reward.",
      needText: true,
      textLabel: "Task title",
      needSelect: true,
      selectLabel: "Category",
      selectOptions: catOptions,
      needAmount: true,
      amountLabel: "Reward (GHS)",
      amountValue: "0.01",
      confirmLabel: "Create",
    });
    if (!result) return;
    try {
      await api("/api/admin/tasks", {
        method: "POST",
        body: { title: result.text, category_key: result.select, reward: result.amount },
      });
      toast("Task created", "good");
      await loadTasks();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  document.addEventListener("click", async (e) => {
    const rewardBtn = e.target.closest("[data-edit-task-reward]");
    if (rewardBtn) {
      const taskId = rewardBtn.dataset.editTaskReward;
      const currentReward = rewardBtn.dataset.currentReward;
      const title = rewardBtn.dataset.title;
      const result = await confirmAction({
        title: "Edit task reward",
        body: `Set the reward paid to a user for completing "${title}".`,
        confirmLabel: "Save",
        needAmount: true,
        amountLabel: "Reward (GHS)",
        amountValue: currentReward,
        needReason: true,
      });
      if (!result) return;
      rewardBtn.disabled = true;
      try {
        await api(`/api/admin/tasks/${encodeURIComponent(taskId)}/reward`, {
          method: "POST",
          body: { reward: result.amount, reason: result.reason || undefined },
        });
        toast("Task reward updated", "good");
        await loadTasks();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        rewardBtn.disabled = false;
      }
      return;
    }

    const editBtn = e.target.closest("[data-edit-task]");
    if (editBtn) {
      const taskId = editBtn.dataset.editTask;
      const task = tasksCache.find((t) => String(t.id) === String(taskId));
      if (!task) return;
      const result = await confirmAction({
        title: "Edit task",
        body: "Update the task's title, category and display order.",
        needText: true,
        textLabel: "Title",
        textValue: task.title,
        needSelect: true,
        selectLabel: "Category",
        selectOptions: categoriesCache.length
          ? categoriesCache.map((c) => ({ value: c.category_key, label: c.display_name }))
          : [{ value: task.category_key, label: task.category_key }],
        confirmLabel: "Save",
      });
      if (!result) return;
      try {
        await api(`/api/admin/tasks/${encodeURIComponent(taskId)}/edit`, {
          method: "POST",
          body: { title: result.text, category_key: result.select },
        });
        toast("Task updated", "good");
        await loadTasks();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }

    const activeBtn = e.target.closest("[data-toggle-task-active]");
    if (activeBtn) {
      const taskId = activeBtn.dataset.toggleTaskActive;
      const wantActive = activeBtn.dataset.active === "0";
      activeBtn.disabled = true;
      try {
        await api(`/api/admin/tasks/${encodeURIComponent(taskId)}/toggle-active`, {
          method: "POST",
          body: { is_active: wantActive },
        });
        toast(wantActive ? "Task enabled" : "Task disabled", "good");
        await loadTasks();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        activeBtn.disabled = false;
      }
    }
  });

  // ---------------- levels ----------------
  async function loadLevels() {
    const tbody = $("#levelsTableBody");
    try {
      const rows = await api("/api/admin/levels");
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row">No levels found.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((lv) => `
        <tr>
          <td><span class="cell-name">Level ${lv.level_number}</span></td>
          <td class="mono">GHS ${money(lv.unlock_fee)}</td>
          <td class="mono">GHS ${money(lv.final_stage_fee)}</td>
          <td class="mono">GHS ${money(lv.completion_reward)}</td>
          <td class="mono">${lv.base_task_count}/${lv.total_task_count}</td>
          <td>${statusBadge(lv.is_active ? "active" : "blocked")}</td>
          <td>
            <button class="btn btn-sm ${lv.allow_balance_payment ? "btn-reject" : "btn-approve"}" data-toggle-level-balance="${lv.id}" data-enabled="${lv.allow_balance_payment ? "1" : "0"}">
              ${lv.allow_balance_payment ? "Disable" : "Enable"}
            </button>
          </td>
          <td>
            <div class="row-actions">
              <button class="btn btn-sm btn-ghost" data-edit-level="${lv.id}" data-level-number="${lv.level_number}"
                data-unlock="${lv.unlock_fee}" data-final="${lv.final_stage_fee}" data-reward="${lv.completion_reward}">
                Edit economics
              </button>
            </div>
          </td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshLevels").addEventListener("click", loadLevels);

  document.addEventListener("click", async (e) => {
    const balanceToggleBtn = e.target.closest("[data-toggle-level-balance]");
    if (balanceToggleBtn) {
      const levelId = balanceToggleBtn.dataset.toggleLevelBalance;
      const wantEnabled = balanceToggleBtn.dataset.enabled === "0";
      balanceToggleBtn.disabled = true;
      try {
        await api(`/api/admin/levels/${encodeURIComponent(levelId)}/toggle-balance-payment`, {
          method: "POST",
          body: { enabled: wantEnabled },
        });
        toast(wantEnabled ? "Balance payment enabled" : "Balance payment disabled", "good");
        await loadLevels();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        balanceToggleBtn.disabled = false;
      }
      return;
    }
  });

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-edit-level]");
    if (!btn) return;
    const levelId = btn.dataset.editLevel;
    const levelNumber = btn.dataset.levelNumber;

    const unlockResult = await confirmAction({
      title: `Level ${levelNumber} — unlock fee`,
      body: "Set the GHS fee users pay to unlock this level.",
      needAmount: true,
      amountLabel: "Unlock fee (GHS)",
      amountValue: btn.dataset.unlock,
      confirmLabel: "Next: final-stage fee",
    });
    if (!unlockResult) return;

    const finalResult = await confirmAction({
      title: `Level ${levelNumber} — final-stage fee`,
      body: "Set the GHS fee users pay to unlock the final stage (0 if not applicable).",
      needAmount: true,
      amountLabel: "Final-stage fee (GHS)",
      amountValue: btn.dataset.final,
      confirmLabel: "Next: completion reward",
    });
    if (!finalResult) return;

    const rewardResult = await confirmAction({
      title: `Level ${levelNumber} — completion reward`,
      body: "Set the GHS reward credited when a user completes this level.",
      needAmount: true,
      amountLabel: "Completion reward (GHS)",
      amountValue: btn.dataset.reward,
      confirmLabel: "Save level",
    });
    if (!rewardResult) return;

    btn.disabled = true;
    try {
      await api(`/api/admin/levels/${encodeURIComponent(levelId)}`, {
        method: "POST",
        body: {
          unlock_fee: unlockResult.amount,
          final_stage_fee: finalResult.amount,
          completion_reward: rewardResult.amount,
        },
      });
      toast(`Level ${levelNumber} updated`, "good");
      await loadLevels();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  // ---------------- broadcast ----------------
  $("#broadcastForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const target = $("#broadcastTarget").value;
    const title = $("#broadcastTitle").value.trim();
    const body = $("#broadcastBody").value.trim();
    if (!title || !body) return;

    const submitBtn = $("#broadcastSubmit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Sending…";
    $("#broadcastHint").textContent = "";
    try {
      const data = await api("/api/admin/broadcast", {
        method: "POST",
        body: { target, title, body },
      });
      $("#broadcastHint").textContent = `Sent to ${data.recipients} user(s).`;
      toast("Broadcast sent", "good");
      $("#broadcastForm").reset();
      await loadAudit();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send broadcast";
    }
  });

  // ---------------- risk flags ----------------
  async function loadRisk() {
    const tbody = $("#riskTableBody");
    const status = $("#riskStatusFilter").value;
    try {
      const rows = await api(`/api/admin/risk-flags?status=${encodeURIComponent(status)}`);
      const openCount = rows.filter((r) => r.status === "open").length;
      $("#riskDot").hidden = openCount === 0;
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-row">No risk flags.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((f) => `
        <tr>
          <td>${severityBadge(f.severity)}</td>
          <td>${escapeHtml(f.category)}</td>
          <td>${escapeHtml(f.title)}</td>
          <td class="mono">${escapeHtml(f.user_id || "—")}</td>
          <td>${dateFmt(f.created_at)}</td>
          <td>${statusBadge(f.status)}</td>
          <td>
            ${f.status === "open" ? `
              <div class="row-actions">
                <button class="btn btn-sm btn-approve" data-resolve-flag="${f.id}">Resolve</button>
              </div>
            ` : ""}
          </td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshRisk").addEventListener("click", loadRisk);
  $("#riskStatusFilter").addEventListener("change", loadRisk);

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-resolve-flag]");
    if (!btn) return;
    btn.disabled = true;
    try {
      await api(`/api/admin/risk-flags/${encodeURIComponent(btn.dataset.resolveFlag)}/resolve`, { method: "POST" });
      toast("Flag resolved", "good");
      await loadRisk();
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  });

  // ---------------- audit log ----------------
  async function loadAudit() {
    const tbody = $("#auditTableBody");
    const q = $("#auditSearch").value.trim();
    try {
      const rows = await api(`/api/admin/audit-logs?q=${encodeURIComponent(q)}`);
      if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No activity recorded yet.</td></tr>`;
        return;
      }
      tbody.innerHTML = rows.map((a) => `
        <tr>
          <td class="mono">${dateFmt(a.created_at)}</td>
          <td class="mono">${escapeHtml(a.actor_id || "system")}</td>
          <td>${escapeHtml(a.action_group)}</td>
          <td>${escapeHtml(a.action_type)}</td>
          <td class="mono">${escapeHtml(a.target_type)}:${escapeHtml(a.target_id)}</td>
          <td>${escapeHtml(a.summary)}</td>
        </tr>
      `).join("");
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-row">${escapeHtml(err.message)}</td></tr>`;
    }
  }

  $("#refreshAudit").addEventListener("click", loadAudit);
  let auditSearchTimer;
  $("#auditSearch").addEventListener("input", () => {
    clearTimeout(auditSearchTimer);
    auditSearchTimer = setTimeout(loadAudit, 300);
  });

  // ---------------- init ----------------
  checkSession();

  // If the browser restores this tab from its back/forward cache (bfcache),
  // scripts don't re-run but the DOM keeps whatever state it was left in -
  // e.g. a confirm modal that was open. Force a fresh session check + close
  // any leftover modal whenever that happens.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      closeModal();
      checkSession();
    }
  });
})();
