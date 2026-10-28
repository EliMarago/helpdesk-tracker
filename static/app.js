/**
 * Help Desk Console — Frontend Application Logic
 * Includes Email/Password Auth, DB Session Management, Dark & Light Mode
 */

const state = {
  user: null,
  token: localStorage.getItem("hd_auth_token") || null,
  theme: localStorage.getItem("hd_theme") || "dark",
  tasks: [],
  templates: [],
  selectedTaskId: null,
  currentView: "kanban", // "kanban" | "list"
  workDate: new Date().toISOString().slice(0, 10),
  carryover: true,
  searchQuery: "",
  filterPriority: "ALL",
  filterCategory: "ALL"
};

const SLA_DEFAULTS = {
  P1: 60,
  P2: 240,
  P3: 480,
  P4: 1440
};

const STATUS_LABELS = {
  todo: "Da fare",
  in_progress: "In lavorazione",
  waiting: "In attesa utente/fornitore",
  resolved: "Risolto"
};

const CATEGORY_ICONS = {
  Hardware: "💻",
  Software: "🧩",
  Rete: "🌐",
  Account: "🔐",
  Altro: "📋"
};

// --- THEME MANAGEMENT (DARK / LIGHT MODE) ---

function applyTheme(theme, persistToDb = false) {
  const validTheme = theme === "light" ? "light" : "dark";
  state.theme = validTheme;
  document.documentElement.setAttribute("data-theme", validTheme);
  localStorage.setItem("hd_theme", validTheme);

  // Update buttons in both Auth screen and App Header
  const nextIcon = validTheme === "dark" ? "☀️" : "🌙";
  const nextLabel = validTheme === "dark" ? "Light Mode" : "Dark Mode";
  const nextShortLabel = validTheme === "dark" ? "Light" : "Dark";

  const authIcon = document.getElementById("authThemeIcon");
  const authLabel = document.getElementById("authThemeLabel");
  if (authIcon) authIcon.textContent = nextIcon;
  if (authLabel) authLabel.textContent = nextLabel;

  const appIcon = document.getElementById("themeIcon");
  const appLabel = document.getElementById("themeLabel");
  if (appIcon) appIcon.textContent = nextIcon;
  if (appLabel) appLabel.textContent = nextShortLabel;

  if (persistToDb && state.token) {
    apiFetch("/api/auth/theme", {
      method: "PUT",
      body: JSON.stringify({ theme_preference: validTheme })
    }).catch(() => {});
  }
}

function toggleTheme() {
  const next = state.theme === "dark" ? "light" : "dark";
  applyTheme(next, true);
  showToast(next === "light" ? "☀️ Modalità Chiara attivata" : "🌙 Modalità Scura attivata");
}

// --- AUTHENTICATED FETCH WRAPPER ---

async function apiFetch(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) {
    headers["Authorization"] = `Bearer ${state.token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    handleUnauthorized();
    throw new Error("Sessione scaduta");
  }
  return res;
}

function showAuthError(msg) {
  const box = document.getElementById("authErrorBox");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = msg;
  box.classList.remove("hidden");
}

function switchToAppView(user) {
  state.user = user;
  if (user.theme_preference) {
    applyTheme(user.theme_preference, false);
  }

  // Populate user profile pill
  const initials = (user.full_name || user.email || "OP")
    .split(" ")
    .map(p => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  document.getElementById("userAvatar").textContent = initials;
  document.getElementById("userNameDisplay").textContent = user.full_name || user.email;
  document.getElementById("userRoleDisplay").textContent = user.role || "Help Desk";

  document.getElementById("authScreen").classList.add("hidden");
  document.getElementById("appShell").classList.remove("hidden");

  fetchTasks();
  fetchTemplates();
}

function handleUnauthorized() {
  state.user = null;
  state.token = null;
  localStorage.removeItem("hd_auth_token");
  closeDrawer();
  document.getElementById("appShell").classList.add("hidden");
  document.getElementById("authScreen").classList.remove("hidden");
}

async function checkInitialAuth() {
  applyTheme(state.theme, false);
  if (!state.token) {
    handleUnauthorized();
    return;
  }
  try {
    const res = await apiFetch("/api/auth/me");
    if (!res.ok) {
      handleUnauthorized();
      return;
    }
    const data = await res.json();
    if (data.authenticated && data.user) {
      switchToAppView(data.user);
    } else {
      handleUnauthorized();
    }
  } catch (e) {
    handleUnauthorized();
  }
}

// --- UTILITIES ---

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":");
}

function getLiveSeconds(task) {
  let base = task.time_spent_seconds || 0;
  if (task.timer_started_at) {
    const startMs = new Date(task.timer_started_at).getTime();
    const diffSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    return base + diffSec;
  }
  return base;
}

function computeSlaInfo(task) {
  if (task.status === "resolved") {
    return { label: "✓ SLA Completato", cssClass: "sla-done", state: "done", remainingMins: 9999 };
  }
  if (!task.sla_deadline) {
    return { label: "SLA N/D", cssClass: "sla-ok", state: "ok", remainingMins: 999 };
  }
  const deadlineMs = new Date(task.sla_deadline).getTime();
  const diffMins = Math.round((deadlineMs - Date.now()) / 60000);

  if (diffMins < 0) {
    const overMins = Math.abs(diffMins);
    const overText = overMins >= 60
      ? `${Math.floor(overMins / 60)}h ${overMins % 60}m`
      : `${overMins}m`;
    return {
      label: `⚠ Scaduto da ${overText}`,
      cssClass: "sla-breached",
      state: "breached",
      remainingMins: diffMins
    };
  }
  const remText = diffMins >= 60
    ? `${Math.floor(diffMins / 60)}h ${diffMins % 60}m`
    : `${diffMins}m`;

  if (diffMins <= 30) {
    return {
      label: `⏳ Scade tra ${remText}`,
      cssClass: "sla-warn",
      state: "warn",
      remainingMins: diffMins
    };
  }
  return {
    label: `🕒 SLA ${remText}`,
    cssClass: "sla-ok",
    state: "ok",
    remainingMins: diffMins
  };
}

function showToast(msg) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- API CALLS ---

async function fetchTasks() {
  if (!state.token) return;
  const params = new URLSearchParams({
    date: state.workDate,
    carryover: String(state.carryover)
  });
  const res = await apiFetch(`/api/tasks?${params.toString()}`);
  const data = await res.json();
  state.tasks = data.tasks || [];
  renderAll();
}

async function fetchTemplates() {
  if (!state.token) return;
  const res = await apiFetch("/api/templates");
  const data = await res.json();
  state.templates = data.templates || [];
  renderTemplatesControls();
}

async function createTask(payload) {
  const res = await apiFetch("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (data.task) {
    state.tasks.unshift(data.task);
    renderAll();
    showToast(`Ticket ${data.task.ticket_id} creato!`);
  }
}

async function updateTask(taskId, updates) {
  const res = await apiFetch(`/api/tasks/${taskId}`, {
    method: "PUT",
    body: JSON.stringify(updates)
  });
  const data = await res.json();
  if (data.task) {
    const idx = state.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) state.tasks[idx] = data.task;
    renderAll();
    if (state.selectedTaskId === taskId) {
      populateDrawer(data.task);
    }
  }
}

async function toggleTaskTimer(taskId, action = "toggle", extra = {}) {
  await apiFetch(`/api/tasks/${taskId}/timer`, {
    method: "POST",
    body: JSON.stringify({ action, exclusive: true, ...extra })
  });
  await fetchTasks();
  if (state.selectedTaskId === taskId) {
    const t = state.tasks.find(x => x.id === taskId);
    if (t) populateDrawer(t);
  }
}

async function addTaskLog(taskId, note) {
  const res = await apiFetch(`/api/tasks/${taskId}/logs`, {
    method: "POST",
    body: JSON.stringify({ note, log_type: "note" })
  });
  const data = await res.json();
  if (data.task) {
    const idx = state.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) state.tasks[idx] = data.task;
    populateDrawer(data.task);
    showToast("Nota registrata nel diario del ticket");
  }
}

async function deleteTask(taskId) {
  await apiFetch(`/api/tasks/${taskId}`, { method: "DELETE" });
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  if (state.selectedTaskId === taskId) {
    closeDrawer();
  }
  renderAll();
  showToast("Ticket eliminato");
}

// --- FILTERING & RENDERING ---

function getFilteredTasks() {
  return state.tasks.filter(t => {
    if (state.filterPriority !== "ALL" && t.priority !== state.filterPriority) return false;
    if (state.filterCategory !== "ALL" && t.category !== state.filterCategory) return false;
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const hay = `${t.ticket_id} ${t.title} ${t.description} ${t.requester_name} ${t.requester_dept}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderAll() {
  const filtered = getFilteredTasks();
  renderKpis();
  renderKanban(filtered);
  renderList(filtered);
  updateLiveClocks();
}

function renderKpis() {
  const all = state.tasks;
  const total = all.length;
  const resolved = all.filter(t => t.status === "resolved").length;
  const open = total - resolved;
  const inProgress = all.filter(t => t.status === "in_progress").length;
  const waiting = all.filter(t => t.status === "waiting").length;

  let slaWarnOrBreach = 0;
  let slaBreached = 0;
  let totalSec = 0;

  all.forEach(t => {
    totalSec += getLiveSeconds(t);
    const sla = computeSlaInfo(t);
    if (sla.state === "warn" || sla.state === "breached") slaWarnOrBreach++;
    if (sla.state === "breached") slaBreached++;
  });

  document.getElementById("kpiTotal").textContent = total;
  document.getElementById("kpiOpenSub").textContent = `${open} ancora aperti`;
  document.getElementById("kpiActive").textContent = inProgress + waiting;
  document.getElementById("kpiWaitingSub").textContent = `${inProgress} in lav. · ${waiting} in attesa`;
  document.getElementById("kpiSlaAlert").textContent = slaWarnOrBreach;
  document.getElementById("kpiSlaBreached").textContent = `${slaBreached} fuori SLA`;
  document.getElementById("kpiResolved").textContent = resolved;
  const rate = total > 0 ? Math.round((resolved / total) * 100) : 0;
  document.getElementById("kpiResolutionRate").textContent = `${rate}% completamento`;
  document.getElementById("kpiTimeSpent").textContent = formatDuration(totalSec);
}

function renderKanban(tasks) {
  const statuses = ["todo", "in_progress", "waiting", "resolved"];
  statuses.forEach(st => {
    const colEl = document.getElementById(`col-${st}`);
    const countEl = document.getElementById(`count-${st}`);
    const colTasks = tasks.filter(t => t.status === st);
    countEl.textContent = colTasks.length;
    colEl.innerHTML = "";

    colTasks.forEach(task => {
      const sla = computeSlaInfo(task);
      const isRunning = Boolean(task.timer_started_at);
      const liveSec = getLiveSeconds(task);
      const icon = CATEGORY_ICONS[task.category] || "📋";

      const card = document.createElement("div");
      card.className = `task-card priority-${task.priority} ${isRunning ? "timer-active" : ""}`;
      card.draggable = true;
      card.dataset.id = task.id;

      card.innerHTML = `
        <div class="card-top">
          <div class="card-badges">
            <span class="ticket-badge">${escapeHtml(task.ticket_id)}</span>
            <span class="priority-badge p-${task.priority}">${task.priority}</span>
            <span class="category-tag">${icon} ${escapeHtml(task.category)}</span>
          </div>
        </div>
        <div class="card-title">${escapeHtml(task.title)}</div>
        ${task.requester_name ? `
          <div class="card-requester">
            👤 <span>${escapeHtml(task.requester_name)}</span>
            ${task.requester_dept ? `<span>· ${escapeHtml(task.requester_dept)}</span>` : ""}
          </div>
        ` : ""}
        <div class="card-footer">
          <span class="sla-pill ${sla.cssClass}" data-sla-task="${task.id}">${sla.label}</span>
          <div class="card-actions">
            <button class="timer-chip-btn ${isRunning ? "running" : ""} mono-clock" data-timer-btn="${task.id}" title="${isRunning ? "Metti in pausa" : "Avvia cronometro"}">
              ${isRunning ? "⏸" : "▶"} <span data-card-clock="${task.id}">${formatDuration(liveSec)}</span>
            </button>
          </div>
        </div>
      `;

      card.addEventListener("dragstart", e => {
        e.dataTransfer.setData("text/plain", String(task.id));
      });

      card.addEventListener("click", e => {
        const timerBtn = e.target.closest("[data-timer-btn]");
        if (timerBtn) {
          e.stopPropagation();
          toggleTaskTimer(task.id, "toggle");
          return;
        }
        openDrawer(task.id);
      });

      colEl.appendChild(card);
    });
  });
}

function renderList(tasks) {
  const tbody = document.getElementById("listTableBody");
  tbody.innerHTML = "";

  tasks.forEach(task => {
    const sla = computeSlaInfo(task);
    const isRunning = Boolean(task.timer_started_at);
    const liveSec = getLiveSeconds(task);
    const icon = CATEGORY_ICONS[task.category] || "📋";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="ticket-badge">${escapeHtml(task.ticket_id)}</span></td>
      <td><span class="priority-badge p-${task.priority}">${task.priority}</span></td>
      <td>
        <strong>${escapeHtml(task.title)}</strong>
        <div style="font-size:11.5px;color:var(--text-muted)">${icon} ${escapeHtml(task.category)}</div>
      </td>
      <td>
        ${escapeHtml(task.requester_name || "—")}
        <div style="font-size:11.5px;color:var(--text-dim)">${escapeHtml(task.requester_dept || "")}</div>
      </td>
      <td>${STATUS_LABELS[task.status] || task.status}</td>
      <td><span class="sla-pill ${sla.cssClass}">${sla.label}</span></td>
      <td>
        <button class="timer-chip-btn ${isRunning ? "running" : ""} mono-clock" data-timer-btn="${task.id}">
          ${isRunning ? "⏸" : "▶"} <span data-card-clock="${task.id}">${formatDuration(liveSec)}</span>
        </button>
      </td>
      <td>
        <button class="btn btn-xs btn-secondary" data-open-id="${task.id}">Dettagli</button>
      </td>
    `;

    tr.addEventListener("click", e => {
      const timerBtn = e.target.closest("[data-timer-btn]");
      if (timerBtn) {
        e.stopPropagation();
        toggleTaskTimer(task.id, "toggle");
        return;
      }
      openDrawer(task.id);
    });

    tbody.appendChild(tr);
  });
}

// --- LIVE CLOCK TICKER (1s) ---

function updateLiveClocks() {
  if (!state.user) return;
  let activeTask = null;
  let totalDaySeconds = 0;

  state.tasks.forEach(task => {
    const sec = getLiveSeconds(task);
    totalDaySeconds += sec;
    if (task.timer_started_at) {
      activeTask = task;
    }

    document.querySelectorAll(`[data-card-clock="${task.id}"]`).forEach(el => {
      el.textContent = formatDuration(sec);
    });

    const slaEl = document.querySelector(`[data-sla-task="${task.id}"]`);
    if (slaEl) {
      const sla = computeSlaInfo(task);
      slaEl.className = `sla-pill ${sla.cssClass}`;
      slaEl.textContent = sla.label;
    }
  });

  const kpiTimeEl = document.getElementById("kpiTimeSpent");
  if (kpiTimeEl) kpiTimeEl.textContent = formatDuration(totalDaySeconds);

  const banner = document.getElementById("activeTimerBanner");
  if (activeTask) {
    banner.classList.remove("hidden");
    document.getElementById("activeTimerTicket").textContent = `${activeTask.ticket_id} · ${activeTask.title.slice(0, 28)}`;
    document.getElementById("activeTimerClock").textContent = formatDuration(getLiveSeconds(activeTask));
    document.getElementById("stopActiveTimerBtn").onclick = () => toggleTaskTimer(activeTask.id, "stop");
  } else {
    banner.classList.add("hidden");
  }

  if (state.selectedTaskId) {
    const sel = state.tasks.find(t => t.id === state.selectedTaskId);
    if (sel) {
      document.getElementById("drawerTimerDisplay").textContent = formatDuration(getLiveSeconds(sel));
      const sla = computeSlaInfo(sel);
      const badge = document.getElementById("drawerSlaBadge");
      badge.className = `sla-pill ${sla.cssClass}`;
      badge.textContent = sla.label;
    }
  }
}

// --- DRAWER MANAGEMENT ---

function openDrawer(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  state.selectedTaskId = taskId;
  populateDrawer(task);
  document.getElementById("detailDrawer").classList.remove("hidden");
}

function closeDrawer() {
  state.selectedTaskId = null;
  document.getElementById("detailDrawer").classList.add("hidden");
}

function populateDrawer(task) {
  document.getElementById("drawerTicketBadge").textContent = task.ticket_id;
  const pBadge = document.getElementById("drawerPriorityBadge");
  pBadge.textContent = task.priority;
  pBadge.className = `priority-badge p-${task.priority}`;

  const sla = computeSlaInfo(task);
  const slaBadge = document.getElementById("drawerSlaBadge");
  slaBadge.className = `sla-pill ${sla.cssClass}`;
  slaBadge.textContent = sla.label;

  document.getElementById("drawerTitleInput").value = task.title || "";
  document.getElementById("drawerDescInput").value = task.description || "";
  document.getElementById("drawerStatusSelect").value = task.status || "todo";
  document.getElementById("drawerPrioritySelect").value = task.priority || "P3";
  document.getElementById("drawerCategorySelect").value = task.category || "Software";
  document.getElementById("drawerTicketIdInput").value = task.ticket_id || "";
  document.getElementById("drawerRequesterInput").value = task.requester_name || "";
  document.getElementById("drawerDeptInput").value = task.requester_dept || "";

  document.getElementById("drawerTimerDisplay").textContent = formatDuration(getLiveSeconds(task));
  const toggleBtn = document.getElementById("drawerTimerToggleBtn");
  if (task.timer_started_at) {
    toggleBtn.textContent = "⏸ Ferma Timer";
    toggleBtn.className = "btn btn-sm btn-danger";
  } else {
    toggleBtn.textContent = "▶ Avvia Timer";
    toggleBtn.className = "btn btn-sm btn-success";
  }

  const logsContainer = document.getElementById("drawerLogsList");
  logsContainer.innerHTML = "";
  const logs = task.logs || [];
  if (logs.length === 0) {
    logsContainer.innerHTML = `<p class="helper-text">Nessuna attività registrata.</p>`;
  } else {
    logs.forEach(l => {
      const div = document.createElement("div");
      div.className = `log-item log-${l.log_type || "note"}`;
      const dt = l.created_at ? l.created_at.replace("T", " ").slice(0, 16) : "";
      const typeTag = l.log_type === "note" ? "📝 Nota Operatore" : "⚙️ Sistema";
      div.innerHTML = `
        <div class="log-meta">
          <span>${typeTag}</span>
          <span>${escapeHtml(dt)}</span>
        </div>
        <div class="log-text">${escapeHtml(l.note)}</div>
      `;
      logsContainer.appendChild(div);
    });
  }
}

// --- TEMPLATES MANAGEMENT ---

function renderTemplatesControls() {
  const select = document.getElementById("drawerTemplateSelect");
  select.innerHTML = `<option value="">⚡ Inserisci Risposta Rapida...</option>`;
  state.templates.forEach(tpl => {
    const opt = document.createElement("option");
    opt.value = String(tpl.id);
    opt.textContent = `[${tpl.category}] ${tpl.title}`;
    select.appendChild(opt);
  });

  const grid = document.getElementById("templatesListContainer");
  if (!grid) return;
  grid.innerHTML = "";
  state.templates.forEach(tpl => {
    const card = document.createElement("div");
    card.className = "template-card";
    card.innerHTML = `
      <div class="template-card-head">
        <span>[${escapeHtml(tpl.category)}] ${escapeHtml(tpl.title)}</span>
        <button class="btn-icon btn-danger-ghost" data-del-tpl="${tpl.id}" title="Elimina">✕</button>
      </div>
      <div class="template-card-body">${escapeHtml(tpl.content)}</div>
    `;
    card.querySelector("[data-del-tpl]").addEventListener("click", async () => {
      await apiFetch(`/api/templates/${tpl.id}`, { method: "DELETE" });
      await fetchTemplates();
      showToast("Template rimosso");
    });
    grid.appendChild(card);
  });
}

function applyTemplateToNote(templateId) {
  const tpl = state.templates.find(t => String(t.id) === String(templateId));
  if (!tpl) return;
  const task = state.tasks.find(t => t.id === state.selectedTaskId);
  let text = tpl.content;
  if (task) {
    text = text
      .replace(/\{utente\}/gi, task.requester_name || "Utente")
      .replace(/\{ticket\}/gi, task.ticket_id || "")
      .replace(/\{titolo\}/gi, task.title || "")
      .replace(/\{priorita\}/gi, task.priority || "");
  }
  const area = document.getElementById("newNoteTextarea");
  area.value = text;
  area.focus();
}

// --- END OF DAY REPORT & EXPORT ---

function generateDailyReport() {
  const tasks = state.tasks;
  const resolved = tasks.filter(t => t.status === "resolved");
  const inProgress = tasks.filter(t => t.status === "in_progress");
  const waiting = tasks.filter(t => t.status === "waiting");
  const todo = tasks.filter(t => t.status === "todo");
  const totalSec = tasks.reduce((acc, t) => acc + getLiveSeconds(t), 0);

  const metricsEl = document.getElementById("reportSummaryMetrics");
  metricsEl.innerHTML = `
    <div class="report-stat"><strong>${tasks.length}</strong><span>Ticket Gestiti</span></div>
    <div class="report-stat"><strong>${resolved.length}</strong><span>Risolti / Chiusi</span></div>
    <div class="report-stat"><strong>${inProgress.length + waiting.length + todo.length}</strong><span>Passaggio Consegne</span></div>
    <div class="report-stat"><strong class="mono-clock">${formatDuration(totalSec)}</strong><span>Tempo Totale Tracciato</span></div>
  `;

  const opName = state.user ? `${state.user.full_name} (${state.user.email})` : "Operatore";
  const lines = [];
  lines.push(`=== REPORT GIORNALIERO HELP DESK — Data: ${state.workDate} ===`);
  lines.push(`Operatore: ${opName}`);
  lines.push(`Totale Ticket: ${tasks.length} | Risolti: ${resolved.length} | Tempo Lavorato: ${formatDuration(totalSec)}`);
  lines.push("");

  lines.push(`✅ TICKET RISOLTI (${resolved.length}):`);
  if (resolved.length === 0) lines.push("  - Nessuno");
  resolved.forEach(t => {
    lines.push(`  - [${t.ticket_id}] (${t.priority}) ${t.title} — Utente: ${t.requester_name || "N/D"} — Tempo: ${formatDuration(getLiveSeconds(t))}`);
  });
  lines.push("");

  const openList = [...inProgress, ...waiting, ...todo];
  lines.push(`🔄 PASSAGGIO CONSEGNE / TICKET APERTI (${openList.length}):`);
  if (openList.length === 0) lines.push("  - Nessun ticket aperto residuo.");
  openList.forEach(t => {
    const stLabel = STATUS_LABELS[t.status] || t.status;
    const lastLog = (t.logs && t.logs.length > 0) ? t.logs[0].note.replace(/\n/g, " ") : "Nessuna nota";
    lines.push(`  - [${t.ticket_id}] [${stLabel}] (${t.priority}) ${t.title} — Utente: ${t.requester_name || "N/D"}`);
    lines.push(`    Ultimo agg.: ${lastLog}`);
  });

  document.getElementById("reportMarkdownOutput").value = lines.join("\n");
}

function downloadCsv() {
  const headers = ["ID_Ticket", "Priorita", "Stato", "Categoria", "Titolo", "Utente", "Reparto", "Tempo_Speso", "Creato_Il", "Scadenza_SLA"];
  const rows = state.tasks.map(t => [
    t.ticket_id,
    t.priority,
    STATUS_LABELS[t.status] || t.status,
    t.category,
    `"${(t.title || "").replace(/"/g, '""')}"`,
    `"${(t.requester_name || "").replace(/"/g, '""')}"`,
    `"${(t.requester_dept || "").replace(/"/g, '""')}"`,
    formatDuration(getLiveSeconds(t)),
    t.created_at,
    t.sla_deadline
  ]);

  const csvContent = "\uFEFF" + [headers.join(";"), ...rows.map(r => r.join(";"))].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `report_helpdesk_${state.workDate}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// --- EVENT LISTENERS INITIALIZATION ---

document.addEventListener("DOMContentLoaded", () => {
  // Theme toggles
  document.getElementById("themeToggleBtn").addEventListener("click", toggleTheme);
  document.getElementById("authThemeToggleBtn").addEventListener("click", toggleTheme);

  // Auth Tabs Switch
  const tabLoginBtn = document.getElementById("tabLoginBtn");
  const tabRegisterBtn = document.getElementById("tabRegisterBtn");
  const loginForm = document.getElementById("loginForm");
  const registerForm = document.getElementById("registerForm");

  tabLoginBtn.addEventListener("click", () => {
    tabLoginBtn.classList.add("active");
    tabRegisterBtn.classList.remove("active");
    loginForm.classList.remove("hidden");
    registerForm.classList.add("hidden");
    showAuthError("");
  });

  tabRegisterBtn.addEventListener("click", () => {
    tabRegisterBtn.classList.add("active");
    tabLoginBtn.classList.remove("active");
    registerForm.classList.remove("hidden");
    loginForm.classList.add("hidden");
    showAuthError("");
  });

  // Login Submit
  loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    showAuthError("");
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || "Errore durante il login");
        return;
      }
      state.token = data.token;
      localStorage.setItem("hd_auth_token", data.token);
      loginForm.reset();
      switchToAppView(data.user);
      showToast(`Bentornato/a, ${data.user.full_name}!`);
    } catch (err) {
      showAuthError("Errore di connessione al server.");
    }
  });

  // Register Submit
  registerForm.addEventListener("submit", async e => {
    e.preventDefault();
    showAuthError("");
    const full_name = document.getElementById("regName").value.trim();
    const role = document.getElementById("regRole").value;
    const email = document.getElementById("regEmail").value.trim();
    const password = document.getElementById("regPassword").value;

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name,
          role,
          email,
          password,
          theme_preference: state.theme
        })
      });
      const data = await res.json();
      if (!res.ok) {
        showAuthError(data.error || "Errore durante la registrazione");
        return;
      }
      state.token = data.token;
      localStorage.setItem("hd_auth_token", data.token);
      registerForm.reset();
      switchToAppView(data.user);
      showToast(`Account creato! Benvenuto/a, ${data.user.full_name}!`);
    } catch (err) {
      showAuthError("Errore di connessione al server.");
    }
  });

  // Logout
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (e) {}
    handleUnauthorized();
    showToast("Disconnessione effettuata");
  });

  // Date & Carryover
  const dateInput = document.getElementById("workDateInput");
  dateInput.value = state.workDate;

  dateInput.addEventListener("change", e => {
    state.workDate = e.target.value;
    fetchTasks();
  });

  document.getElementById("carryoverToggle").addEventListener("change", e => {
    state.carryover = e.target.checked;
    fetchTasks();
  });

  // Filters
  document.getElementById("searchInput").addEventListener("input", e => {
    state.searchQuery = e.target.value.trim();
    renderAll();
  });
  document.getElementById("filterPriority").addEventListener("change", e => {
    state.filterPriority = e.target.value;
    renderAll();
  });
  document.getElementById("filterCategory").addEventListener("change", e => {
    state.filterCategory = e.target.value;
    renderAll();
  });

  // View Switcher
  document.getElementById("viewKanbanBtn").addEventListener("click", () => {
    state.currentView = "kanban";
    document.getElementById("viewKanbanBtn").classList.add("active");
    document.getElementById("viewListBtn").classList.remove("active");
    document.getElementById("kanbanView").classList.remove("hidden");
    document.getElementById("listView").classList.add("hidden");
  });

  document.getElementById("viewListBtn").addEventListener("click", () => {
    state.currentView = "list";
    document.getElementById("viewListBtn").classList.add("active");
    document.getElementById("viewKanbanBtn").classList.remove("active");
    document.getElementById("listView").classList.remove("hidden");
    document.getElementById("kanbanView").classList.add("hidden");
  });

  // Drag & Drop on Kanban Columns
  document.querySelectorAll(".kanban-col").forEach(col => {
    col.addEventListener("dragover", e => {
      e.preventDefault();
      col.classList.add("drag-over");
    });
    col.addEventListener("dragleave", () => {
      col.classList.remove("drag-over");
    });
    col.addEventListener("drop", e => {
      e.preventDefault();
      col.classList.remove("drag-over");
      const taskId = Number(e.dataTransfer.getData("text/plain"));
      const newStatus = col.dataset.status;
      if (taskId && newStatus) {
        updateTask(taskId, { status: newStatus });
      }
    });
  });

  // Modals Open/Close
  document.getElementById("newTaskBtn").addEventListener("click", () => {
    document.getElementById("newTaskModal").classList.remove("hidden");
    document.querySelector('#newTaskForm [name="title"]').focus();
  });

  document.getElementById("openTemplatesBtn").addEventListener("click", () => {
    document.getElementById("templatesModal").classList.remove("hidden");
  });

  document.getElementById("openReportBtn").addEventListener("click", () => {
    generateDailyReport();
    document.getElementById("reportModal").classList.remove("hidden");
  });

  document.querySelectorAll(".close-modal").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target;
      if (target) document.getElementById(target).classList.add("hidden");
    });
  });

  document.getElementById("newTaskPriority").addEventListener("change", e => {
    const mins = SLA_DEFAULTS[e.target.value] || 480;
    document.getElementById("newTaskSlaMinutes").value = mins;
  });

  document.getElementById("newTaskForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.work_date = state.workDate;
    await createTask(payload);
    e.target.reset();
    document.getElementById("newTaskSlaMinutes").value = 480;
    document.getElementById("newTaskModal").classList.add("hidden");
  });

  document.getElementById("newTemplateForm").addEventListener("submit", async e => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    await apiFetch("/api/templates", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    e.target.reset();
    await fetchTemplates();
    showToast("Nuovo template salvato!");
  });

  // Drawer Events
  document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);

  document.getElementById("saveDrawerChangesBtn").addEventListener("click", async () => {
    if (!state.selectedTaskId) return;
    const updates = {
      title: document.getElementById("drawerTitleInput").value.trim(),
      description: document.getElementById("drawerDescInput").value.trim(),
      status: document.getElementById("drawerStatusSelect").value,
      priority: document.getElementById("drawerPrioritySelect").value,
      category: document.getElementById("drawerCategorySelect").value,
      ticket_id: document.getElementById("drawerTicketIdInput").value.trim(),
      requester_name: document.getElementById("drawerRequesterInput").value.trim(),
      requester_dept: document.getElementById("drawerDeptInput").value.trim()
    };
    await updateTask(state.selectedTaskId, updates);
    const fb = document.getElementById("drawerSaveFeedback");
    fb.textContent = "✓ Salvato";
    setTimeout(() => { fb.textContent = ""; }, 2000);
  });

  document.getElementById("drawerStatusSelect").addEventListener("change", e => {
    if (state.selectedTaskId) {
      updateTask(state.selectedTaskId, { status: e.target.value });
    }
  });

  document.getElementById("drawerTimerToggleBtn").addEventListener("click", () => {
    if (state.selectedTaskId) {
      toggleTaskTimer(state.selectedTaskId, "toggle");
    }
  });

  document.querySelectorAll(".add-manual-time").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!state.selectedTaskId) return;
      const mins = Number(btn.dataset.mins);
      toggleTaskTimer(state.selectedTaskId, "add_manual", { minutes: mins });
      showToast(`+${mins} minuti aggiunti al ticket`);
    });
  });

  document.getElementById("drawerTemplateSelect").addEventListener("change", e => {
    if (e.target.value) {
      applyTemplateToNote(e.target.value);
      e.target.value = "";
    }
  });

  document.getElementById("copyNoteTextBtn").addEventListener("click", () => {
    const text = document.getElementById("newNoteTextarea").value;
    if (!text) return;
    navigator.clipboard.writeText(text);
    showToast("Testo copiato negli appunti!");
  });

  document.getElementById("addNoteBtn").addEventListener("click", async () => {
    if (!state.selectedTaskId) return;
    const area = document.getElementById("newNoteTextarea");
    const note = area.value.trim();
    if (!note) return;
    await addTaskLog(state.selectedTaskId, note);
    area.value = "";
  });

  document.getElementById("deleteTaskBtn").addEventListener("click", () => {
    if (!state.selectedTaskId) return;
    if (confirm("Vuoi davvero eliminare definitivamente questo ticket?")) {
      deleteTask(state.selectedTaskId);
    }
  });

  document.getElementById("copyReportBtn").addEventListener("click", () => {
    const text = document.getElementById("reportMarkdownOutput").value;
    navigator.clipboard.writeText(text);
    showToast("Report di fine turno copiato negli appunti!");
  });

  document.getElementById("exportCsvBtn").addEventListener("click", downloadCsv);

  // Keyboard shortcut: 'N' to open new ticket modal when logged in and not typing in an input
  document.addEventListener("keydown", e => {
    if (!state.user) return;
    const tag = (e.target.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      document.getElementById("newTaskModal").classList.remove("hidden");
      document.querySelector('#newTaskForm [name="title"]').focus();
    } else if (e.key === "Escape") {
      closeDrawer();
      document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.add("hidden"));
    }
  });

  // Check authentication and start live timer loop
  checkInitialAuth();
  setInterval(updateLiveClocks, 1000);
});
