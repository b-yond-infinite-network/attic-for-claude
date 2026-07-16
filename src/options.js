// SPDX-License-Identifier: MIT
// Copyright (c) 2026 B-Yond

const $ = (s) => document.querySelector(s);
const setStatus = (m) => ($("#status").textContent = m);

async function refresh() {
  const [index, consumed, s] = await Promise.all([
    CLHStore.getIndex(),
    CLHStore.getConsumed(),
    CLHStore.getSettings(),
  ]);
  $("#stat-total").textContent = String(index.length);
  $("#stat-consumed").textContent = String(Object.keys(consumed).length);
  $("#enabled").checked = !!s.enabled;
  $("#includeatt").checked = s.includeAttachments !== false;
  $("#model").value = s.continueModel || "";
  $("#sidebarlimit").value = s.sidebarLimit == null ? 30 : s.sidebarLimit;
  $("#from").value = s.dateFrom || "";
  $("#to").value = s.dateTo || "";

  if (index.length) {
    const ds = index.map((e) => e.updated_at || e.created_at).filter(Boolean).sort();
    $("#span").textContent =
      new Date(ds[0]).toLocaleDateString() + " → " + new Date(ds[ds.length - 1]).toLocaleDateString();
  } else {
    $("#span").textContent = "—";
  }
}

$("#import").addEventListener("click", async () => {
  const f = $("#file").files[0];
  if (!f) return setStatus("Choose a conversations.json file first.");
  setStatus("Reading file…");
  let data;
  try {
    data = JSON.parse(await f.text());
  } catch (e) {
    return setStatus("Could not parse JSON: " + e.message);
  }
  if (!Array.isArray(data)) return setStatus("Expected a JSON array of conversations.");
  setStatus("Importing " + data.length + " conversations…");
  try {
    const n = await CLHStore.importData(data, (done) =>
      setStatus("Imported " + done + " / " + data.length + "…")
    );
    setStatus("✓ Imported " + n + " conversations. Open (or reload) claude.ai to see them.");
  } catch (e) {
    setStatus("Import failed: " + e.message);
  }
  refresh();
});

$("#save").addEventListener("click", async () => {
  const s = await CLHStore.getSettings();
  s.enabled = $("#enabled").checked;
  s.includeAttachments = $("#includeatt").checked;
  s.continueModel = $("#model").value || null;
  s.sidebarLimit = Math.max(0, parseInt($("#sidebarlimit").value, 10) || 0);
  s.dateFrom = $("#from").value || null;
  s.dateTo = $("#to").value || null;
  await CLHStore.setSettings(s);
  setStatus("✓ Settings saved.");
});

$("#reset-consumed").addEventListener("click", async () => {
  await CLHStore.resetConsumed();
  setStatus("✓ Restored — continued conversations will show again.");
  refresh();
});

$("#clear").addEventListener("click", async () => {
  if (!confirm("Delete ALL imported conversations from this extension? (Your claude.ai account is untouched.)")) return;
  await CLHStore.clearAll();
  setStatus("✓ Cleared all local data.");
  refresh();
});

refresh();