"use strict";

const FLAGS = {
  canTranslit: document.body.dataset.canTranslit === "true",
  canAddress: document.body.dataset.canAddress === "true",
  isSuperAdmin: document.body.dataset.isSuperAdmin === "true",
};

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

// ---- tabs (only those rendered) -----------------------------------------
const tabs = Array.from(document.querySelectorAll(".dt-tab"));
let addressLoaded = false;

function activateTab(name) {
  tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".dt-panel").forEach((p) => p.classList.remove("active"));
  const panel = document.getElementById("panel-" + name);
  if (panel) panel.classList.add("active");
  if (name === "address" && !addressLoaded) loadAddressAreas();
}

tabs.forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
if (tabs.length) activateTab(tabs[0].dataset.tab);

// =========================================================================
// TRANSLITERATION
// =========================================================================
if (FLAGS.canTranslit) {
  const translitList = document.getElementById("translitList");
  const translitStatus = document.getElementById("translitStatus");
  const startBtn = document.getElementById("startScan");
  const scanWrap = document.getElementById("scanProgressWrap");
  const scanBar = document.getElementById("scanProgressBar");
  const scanText = document.getElementById("scanProgressText");
  let scanning = false;
  let unalignedRows = [];

  async function runScan() {
    if (scanning) return;
    scanning = true;
    startBtn.disabled = true;
    startBtn.textContent = "Scanning…";
    translitStatus.textContent = "Scanning…";
    translitList.innerHTML = "";
    document.querySelector("#unalignedTable tbody").innerHTML = "";
    scanWrap.style.display = "block";
    scanBar.style.width = "0%";
    scanText.textContent = "Reading records…";
    let records = 0;
    try {
      const res = await fetch("/api/data-tools/translit/scan?t=" + Date.now(), {
        cache: "no-store",
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.records != null) records = msg.records;
          if (msg.phase === "fetch") {
            const pct = msg.total ? Math.round((msg.processed / msg.total) * 100) : 100;
            scanBar.style.width = pct + "%";
            scanText.textContent = msg.total
              ? `Scanning ${records} records · fetching transliterations ${msg.processed}/${msg.total}…`
              : `Scanning ${records} records · analysing…`;
          }
          if (msg.done) {
            scanBar.style.width = "100%";
            scanText.textContent = `Scanned ${records} records.`;
            renderResult(msg.result);
            setTimeout(() => { scanWrap.style.display = "none"; }, 1200);
          }
        }
      }
    } catch (e) {
      scanText.textContent = "Scan failed: " + e;
      translitStatus.textContent = "Scan failed.";
    } finally {
      scanning = false;
      startBtn.disabled = false;
      startBtn.textContent = "Re-scan entire database";
    }
  }

  startBtn.addEventListener("click", runScan);

  function renderResult(data) {
    const suspects = data.suspects || [];
    translitStatus.textContent =
      `${suspects.length} word(s) to review · ${data.okWords} OK · ${data.distinctWords} distinct words`;
    translitList.innerHTML = "";
    suspects.forEach((s) => {
      const card = document.createElement("div");
      card.className = "dt-card";
      const opts = s.options
        .map(
          (o) =>
            `<label class="dt-opt"><input type="radio" name="w_${escapeHtml(s.word)}" value="${escapeHtml(
              o.spelling
            )}" ${o.spelling === s.target ? "checked" : ""}>${escapeHtml(o.spelling)}<span class="dt-src">${o.source}</span></label>`
        )
        .join("");
      const reasonLabel = s.reason === "needs_apply"
        ? '<span class="dt-src" style="color:#fa6e39">saved · not applied yet → run Apply</span>'
        : (s.reason === "bad_override"
            ? '<span class="dt-src" style="color:#c00">saved spelling is wrong → pick correct, Save, Apply</span>'
            : (s.reason === "inconsistent"
                ? '<span class="dt-src">inconsistent spellings</span>'
                : '<span class="dt-src">invalid transliteration</span>'));
      card.innerHTML = `
        <div><span class="dt-tag">word</span><span class="dt-key">${escapeHtml(s.word)}</span>
          <span class="dt-muted"> · seen ${s.count}x${
            s.variants > 1 ? " · " + s.variants + " different spellings" : ""
          }</span> ${reasonLabel}</div>
        <div class="dt-opts">${opts || '<span class="dt-muted">no suggestions</span>'}</div>
        <div class="dt-custom">or type: <input type="text" data-custom="${escapeHtml(
          s.word
        )}" placeholder="custom Marathi"></div>`;
      translitList.appendChild(card);
    });
    renderUnaligned(data.unaligned || []);
  }

  function renderUnaligned(items) {
    document.getElementById("unalignedCount").textContent = items.length;
    const tbody = document.querySelector("#unalignedTable tbody");
    tbody.innerHTML = "";
    unalignedRows = [];
    items.forEach((u) => {
      const tr = document.createElement("tr");
      const initial = u.suggestion || u.mr || "";
      tr.innerHTML = `
        <td><div>${escapeHtml(u.label)}</div><div class="dt-muted">${escapeHtml(u.field)}</div></td>
        <td class="dt-en">${escapeHtml(u.en)}<div class="dt-muted">now: ${escapeHtml(u.mr || "—")}</div></td>
        <td class="dt-edit">
          <input type="text" value="${escapeHtml(initial)}">
          ${u.suggestion ? `<span class="dt-chip" title="use Google suggestion">${escapeHtml(u.suggestion)}</span>` : ""}
        </td>
        <td><button class="button-secondary" type="button">Save row</button>
            <span class="dt-saved"></span></td>`;
      const input = tr.querySelector("input");
      const chip = tr.querySelector(".dt-chip");
      const savedEl = tr.querySelector(".dt-saved");
      if (chip) chip.addEventListener("click", () => { input.value = chip.textContent; });
      tr.querySelector("button").addEventListener("click", () => saveOneRow(u, input, savedEl));
      unalignedRows.push({ item: u, input, savedEl });
      tbody.appendChild(tr);
    });
  }

  async function saveOneRow(u, input, savedEl) {
    const mr = input.value.trim();
    if (!mr) { alert("Enter the Marathi text first."); return false; }
    savedEl.textContent = "Saving…";
    const res = await fetch("/api/data-tools/translit/fix-record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: u.id, field: u.field, en: u.en, mr }),
    });
    const data = await res.json();
    savedEl.textContent = data.ok ? "Saved ✓" : ("Error: " + (data.error || ""));
    return !!data.ok;
  }

  function collectPicks() {
    const picks = {};
    document.querySelectorAll("[data-custom]").forEach((inp) => {
      const v = inp.value.trim();
      if (v) picks[inp.dataset.custom] = v;
    });
    document.querySelectorAll('#translitList input[type=radio]:checked').forEach((r) => {
      const word = r.name.slice(2);
      if (!(word in picks)) picks[word] = r.value;
    });
    return picks;
  }

  document.getElementById("inspectBtn").addEventListener("click", async () => {
    const q = document.getElementById("inspectQ").value.trim();
    const box = document.getElementById("inspectResult");
    if (!q) { box.textContent = "Enter a name to inspect."; return; }
    box.textContent = "Looking up…";
    try {
      const res = await fetch("/api/data-tools/translit/inspect?q=" + encodeURIComponent(q) + "&t=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      const results = data.results || [];
      if (!results.length) { box.textContent = "No matching records."; return; }
      box.innerHTML = results.map((r) => {
        const rows = r.fields.map((f) => {
          const align = f.aligned
            ? "aligned"
            : `<b style="color:#c00">NOT aligned (EN ${f.enWords} words, MR ${f.mrWords})</b>`;
          const words = f.aligned
            ? f.words.map((w) =>
                `<div style="margin-left:14px">${escapeHtml(w.en)} → <b>${escapeHtml(w.mr)}</b> · ${
                  w.valid ? "valid" : '<span style="color:#c00">INVALID</span>'
                }${w.override ? " · override=" + escapeHtml(w.override) : ""} · google: ${
                  (w.suggestions || []).map(escapeHtml).join(", ")
                }</div>`
              ).join("")
            : "";
          return `<div style="margin:6px 0"><code>${escapeHtml(f.field)}</code>: ${escapeHtml(f.en)} = <b>${escapeHtml(f.mr)}</b> — ${align}${words}</div>`;
        }).join("");
        return `<div class="dt-card"><div class="dt-key">${escapeHtml(r.label)}</div>${rows}</div>`;
      }).join("");
    } catch (e) {
      box.textContent = "Inspect failed: " + e;
    }
  });

  loadInspectorEnter();
  function loadInspectorEnter() {
    const inp = document.getElementById("inspectQ");
    if (inp) inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("inspectBtn").click();
    });
  }

  document.getElementById("saveAllRows").addEventListener("click", async () => {
    if (!unalignedRows.length) { alert("Nothing to save."); return; }
    if (!confirm(`Save Marathi for all ${unalignedRows.length} record(s) shown here? This updates the records directly.`)) return;
    const btn = document.getElementById("saveAllRows");
    const status = document.getElementById("saveAllRowsStatus");
    btn.disabled = true;
    let ok = 0, fail = 0;
    for (let i = 0; i < unalignedRows.length; i++) {
      const { item, input, savedEl } = unalignedRows[i];
      status.textContent = `Saving ${i + 1}/${unalignedRows.length}…`;
      try {
        const done = await saveOneRow(item, input, savedEl);
        done ? ok++ : fail++;
      } catch (e) {
        fail++;
      }
    }
    status.textContent = `Done — ${ok} saved${fail ? ", " + fail + " failed" : ""}.`;
    btn.disabled = false;
  });

  document.getElementById("suggestAll").addEventListener("click", async () => {
    const btn = document.getElementById("suggestAll");
    btn.disabled = true;
    const prevStatus = translitStatus.textContent;
    translitStatus.textContent = "Computing best spellings…";
    try {
      const res = await fetch("/api/data-tools/translit/auto-suggest?t=" + Date.now(), {
        cache: "no-store",
      });
      const data = await res.json();
      const map = data.suggestions || {};
      let filled = 0;
      Object.keys(map).forEach((word) => {
        const chosen = map[word];
        const radios = document.querySelectorAll(
          `#translitList input[type=radio][name="w_${word}"]`
        );
        let matched = false;
        radios.forEach((r) => {
          if (r.value === chosen) { r.checked = true; matched = true; }
        });
        if (!matched) {
          const custom = document.querySelector(
            `#translitList input[data-custom="${word}"]`
          );
          if (custom) { custom.value = chosen; matched = true; }
        }
        if (matched) filled += 1;
      });
      translitStatus.textContent =
        `Pre-filled ${filled} suggestion(s). Review the picks, then "Save picks" and "Apply corrections".`;
    } catch (e) {
      translitStatus.textContent = prevStatus;
      alert("Could not compute suggestions: " + e);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("saveTranslit").addEventListener("click", async () => {
    const picks = collectPicks();
    if (!Object.keys(picks).length) { alert("Pick or type at least one spelling first."); return; }
    const res = await fetch("/api/data-tools/translit/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ picks }),
    });
    const data = await res.json();
    if (data.ok) {
      runScan();
      if (confirm(`Saved ${data.saved} correction(s). They auto-apply to NEW registrations.\n\nApply them to EXISTING records now?`)) {
        runApply();
      }
    } else {
      alert("Save failed: " + (data.error || "unknown"));
    }
  });

  async function runApply() {
    const btn = document.getElementById("applyTranslit");
    const wrap = document.getElementById("applyProgressWrap");
    const bar = document.getElementById("applyProgressBar");
    const text = document.getElementById("applyProgressText");
    btn.disabled = true; btn.textContent = "Applying…";
    wrap.style.display = "block"; bar.style.width = "0%"; text.textContent = "Starting…";
    try {
      const res = await fetch("/api/data-tools/translit/apply", { method: "POST" });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "", total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.total != null) total = msg.total;
          if (msg.processed != null) {
            const pct = total ? Math.round((msg.processed / total) * 100) : 0;
            bar.style.width = pct + "%";
            text.textContent = `${msg.processed}/${total} scanned · ${msg.updated} updated`;
          }
          if (msg.done) {
            bar.style.width = "100%";
            text.textContent = `Done — ${msg.updated} record(s) updated out of ${msg.processed}.`;
          }
        }
      }
      runScan();
    } catch (e) {
      text.textContent = "Apply failed: " + e;
    } finally {
      btn.disabled = false; btn.textContent = "Apply corrections to existing records";
    }
  }

  document.getElementById("applyTranslit").addEventListener("click", () => {
    if (!confirm("Re-generate Marathi for existing records using saved corrections? Only words with a saved correction are changed.")) return;
    runApply();
  });
}

// =========================================================================
// ADDRESS AREAS
// =========================================================================
async function loadAddressAreas() {
  const status = document.getElementById("addressStatus");
  status.textContent = "Classifying addresses…";
  const res = await fetch("/api/data-tools/address-areas");
  const data = await res.json();
  addressLoaded = true;
  status.textContent = `${data.totalFamilies} families across ${data.summary.length} areas`;

  const tbody = document.querySelector("#areaSummary tbody");
  tbody.innerHTML = "";
  data.summary.forEach((s) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><span class="dt-area-link">${escapeHtml(s.area)}</span></td>
      <td>${s.families}</td><td>${s.members}</td>`;
    tr.querySelector(".dt-area-link").addEventListener("click", () => loadAreaDetail(s.area));
    tbody.appendChild(tr);
  });
}

async function loadAreaDetail(area) {
  document.getElementById("areaDetailTitle").textContent = area;
  const res = await fetch("/api/data-tools/address-areas?area=" + encodeURIComponent(area));
  const data = await res.json();
  const tbody = document.querySelector("#areaDetail tbody");
  tbody.innerHTML = "";
  (data.rows || []).forEach((r) => {
    const addr = [r.address1_clean, r.address2_clean].filter(Boolean).join(", ");
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(r.name)}</td><td>${escapeHtml(addr)}</td>`;
    tbody.appendChild(tr);
  });
}

// ---- grouped PDF export (with circular progress while it builds) ---------
const exportBtn = document.getElementById("exportPdfBtn");
if (exportBtn) {
  exportBtn.addEventListener("click", async () => {
    if (exportBtn.classList.contains("is-loading")) return;
    const label = document.getElementById("exportPdfLabel");
    const original = label.textContent;
    exportBtn.classList.add("is-loading");
    exportBtn.disabled = true;
    label.textContent = "Preparing…";
    try {
      const res = await fetch("/api/data-tools/address-areas/export");
      if (!res.ok) {
        let msg = "Export failed (" + res.status + ")";
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
        alert(msg);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const name = match ? match[1] : "samaj-address-areas.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Export failed: " + e.message);
    } finally {
      exportBtn.classList.remove("is-loading");
      exportBtn.disabled = false;
      label.textContent = original;
    }
  });
}
