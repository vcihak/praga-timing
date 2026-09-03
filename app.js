/* --------------------------------------------------------------------
 * SMS-Timing (BMI Leisure) modules client — static, no backend needed.
 * The base64 key from a public module link is a Basic credential for the
 * handshake, which returns a short-lived token that rotates every call.
 * -------------------------------------------------------------------- */

const DEFAULT_KEY = "cHJhZ2FhcmVuYTowN2EzMzc2My0yYjdiLTRhYzktOTgzZS1jZDljMWQzOGRmODU=";
const HANDSHAKE = "https://backend.sms-timing.com/api/connectioninfo?type=modules";

// Shown in the header. The API only knows the resource as "Karting", which
// reads oddly as a page title, so name the venue here.
const VENUE = "Praga Arena";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hide", !on);

const state = {
  key: new URLSearchParams(location.search).get("key") || DEFAULT_KEY,
  rscId: "", scgId: "", resources: null, tab: "best", abort: false, sock: null, live: null,
};

async function connect() {
  const r = await fetch(HANDSHAKE, { headers: { Authorization: "Basic " + state.key } });
  if (!r.ok) throw new Error("Handshake selhal (HTTP " + r.status + "). Zkontroluj klíč.");
  return r.json();
}

// Routing is param-sensitive: a missing key yields 404, not 400. Send them all.
async function api(conn, path, params) {
  const q = new URLSearchParams({ ...params, accessToken: conn.AccessToken });
  const r = await fetch(`https://${conn.ServiceAddress}/api/${path}/${conn.ClientKey}?${q}`);
  if (r.status === 401) throw new Error("Token vypršel — zkus to znovu.");
  if (!r.ok) throw new Error(path + ": HTTP " + r.status);
  return r.json();
}

const getRecords = (conn, p) =>
  api(conn, "besttimes/records", {
    locale: "cs", rscId: p.rscId, scgId: p.scgId || "",
    startDate: p.from, endDate: p.to, maxResult: String(p.max || 200),
  }).then((d) => d.records || []);

/* ------------------------------- utils ------------------------------- */

const iso = (d) => d.toISOString().slice(0, 10);
const shiftDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const startOfMonth = () => { const d = new Date(); d.setDate(1); return iso(d); };
const startOfYear = () => new Date().getFullYear() + "-01-01";
// Monday of the current week (getDay() is Sunday-based, so rotate it).
const mondayThisWeek = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "16.341" -> 16.341 ; "1:00.796" -> 60.796
function toSeconds(s) {
  if (!s) return null;
  const p = String(s).split(":").map(parseFloat);
  return p.some(isNaN) ? null : p.reduce((a, n) => a * 60 + n, 0);
}

function czDate(s) {
  const d = new Date(s);
  return `${d.getDate()}.${d.getMonth() + 1}. ` +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function buckets(from, to, size) {
  const out = []; const end = new Date(to); let cur = new Date(from);
  while (cur <= end) {
    const next = new Date(cur);
    if (size === "day") next.setDate(next.getDate() + 1);
    else if (size === "week") next.setDate(next.getDate() + 7);
    else next.setMonth(next.getMonth() + 1);
    out.push({ from: iso(cur), to: iso(next > end ? new Date(+end + 864e5) : next) });
    cur = next;
  }
  return out;
}

function renderList(el, rows, highlight) {
  if (!rows.length) { el.innerHTML = '<div class="empty">Nic tu není. Zkus širší rozsah.</div>'; return; }
  el.innerHTML = rows.map((r, i) => {
    const rank = highlight ? i + 1 : (r.position ?? i + 1);
    const div = document.createElement("div");
    div.textContent = r.participant || "";
    return `<div class="rec" data-top="${rank === 1 ? 1 : 0}">
      <span class="pos">${rank}</span>
      <span class="who" ${highlight ? 'style="color:var(--accent)"' : ""}>${div.innerHTML}</span>
      <span class="when">${czDate(r.date)}</span>
      <span class="score">${r.score}</span></div>`;
  }).join("");
}

function trend(el, pts) {
  if (pts.length < 2) { el.innerHTML = ""; return; }
  const W = 340, H = 100, lo = Math.min(...pts.map(p => p.secs)), hi = Math.max(...pts.map(p => p.secs));
  const span = hi - lo || 1;
  const x = (i) => (i / (pts.length - 1)) * (W - 16) + 8;
  const y = (s) => H - 14 - ((s - lo) / span) * (H - 32);
  const d = pts.map((p, i) => (i ? "L" : "M") + x(i) + "," + y(p.secs)).join(" ");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.secs)}" r="2.5"
       fill="${p.secs === lo ? "var(--gold)" : "var(--accent)"}"/>`).join("")}
    <text x="8" y="11" font-size="9" fill="var(--faint)" font-family="var(--mono)">
      nejlepší ${lo.toFixed(3)}s</text></svg>`;
}

/* -------------------------------- boot ------------------------------- */

async function boot() {
  $("keyInput").value = state.key;
  show($("bootErr"), false);
  $("trackName").textContent = "Načítám";
  $("trackSub").textContent = "…";
  try {
    const conn = await connect();
    state.resources = await api(conn, "besttimes/resources", { locale: "cs", rscId: "" });
    const r = state.resources[0];
    state.rscId = r.resourceId;
    $("trackName").textContent = state.key === DEFAULT_KEY ? VENUE : conn.ClientKey;
    $("trackSub").textContent = r.name + " · okruh " + r.resourceId;
    renderGroups(r.scoregroups || []);
    show($("tabs"), true);
    selectTab(state.tab);
  } catch (e) {
    $("trackName").textContent = "Nepřipojeno";
    $("trackSub").textContent = "";
    $("bootErr").textContent = e.message + " Pokud jde o síťovou chybu, otevři stránku přes https, ne ze souboru.";
    $("bootErr").className = "pad note bad";
    show($("bootErr"), true);
  }
}

function renderGroups(gs) {
  const el = $("groups");
  if (gs.length < 2) return show(el, false);
  el.innerHTML = `<button class="chip" data-scg="" data-on="1">Vše</button>` +
    gs.map(g => `<button class="chip" data-scg="${g.id}" data-on="0">${g.name}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("[data-scg]"); if (!b) return;
    state.scgId = b.dataset.scg;
    [...el.children].forEach(c => c.dataset.on = c === b ? "1" : "0");
    if (state.tab === "best") loadBest();
  };
  show(el, true);
}

function selectTab(t) {
  state.tab = t;
  [...$("tabs").children].forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t));
  ["best", "driver", "live"].forEach(k => show($("panel-" + k), k === t));
  show($("groups"), t !== "live" && $("groups").children.length > 0);
  if (t === "best" && !$("bList").children.length) loadBest();
}

/* ----------------------------- best times ---------------------------- */

const PRESETS = [
  ["Dnes", () => shiftDays(0)], ["Tento týden", mondayThisWeek],
  ["7 dní", () => shiftDays(-7)], ["30 dní", () => shiftDays(-30)],
  ["Měsíc", startOfMonth], ["Rok", startOfYear], ["Vše", () => "2000-01-01"],
];

$("presets").innerHTML = PRESETS.map(([l], i) =>
  `<button class="chip" data-p="${i}" data-on="${l === "Měsíc" ? 1 : 0}">${l}</button>`).join("");

$("presets").onclick = (e) => {
  const b = e.target.closest("[data-p]"); if (!b) return;
  [...$("presets").children].forEach(c => c.dataset.on = c === b ? "1" : "0");
  $("bFrom").value = PRESETS[+b.dataset.p][1]();
  $("bTo").value = shiftDays(1);
  loadBest();
};

async function loadBest() {
  show($("bErr"), false);
  $("bList").innerHTML = '<div class="empty">Načítám…</div>';
  try {
    const conn = await connect();
    const rows = await getRecords(conn, {
      rscId: state.rscId, scgId: state.scgId,
      from: $("bFrom").value, to: $("bTo").value, max: +$("bMax").value || 100,
    });
    renderList($("bList"), rows, false);
  } catch (e) {
    $("bList").innerHTML = "";
    $("bErr").textContent = e.message;
    show($("bErr"), true);
  }
}

/* ---------------------------- driver hunt ---------------------------- */

const SIZES = [["day", "Po dnech"], ["week", "Po týdnech"], ["month", "Po měsících"]];
$("dSize").innerHTML = SIZES.map(([v, l], i) =>
  `<button class="chip" data-s="${v}" data-on="${i === 1 ? 1 : 0}">${l}</button>`).join("");

let dGranularity = "week";
$("dSize").onclick = (e) => {
  const b = e.target.closest("[data-s]"); if (!b) return;
  dGranularity = b.dataset.s;
  [...$("dSize").children].forEach(c => c.dataset.on = c === b ? "1" : "0");
  updateHint();
};

function updateHint() {
  const n = buckets($("dFrom").value, $("dTo").value, dGranularity).length;
  $("dHint").textContent =
    `API vrací jeden nejlepší čas na jezdce za dotázané okno, takže jemnější dělení znamená hustší historii a víc dotazů. Teď ${n}.`;
  return n;
}
["dFrom", "dTo"].forEach(id => $(id).addEventListener("change", updateHint));

let scanRun = 0;

function idleScanButton() {
  $("dGo").dataset.running = "0";
  $("dGo").classList.remove("quiet");
  $("dGo").textContent = "Projet";
}

$("dGo").onclick = async () => {
  // Second click while running means stop. Bumping the id makes the live
  // loop bail on its next check, so no two scans can ever share the list.
  if ($("dGo").dataset.running === "1") { scanRun++; idleScanButton(); return; }

  const needle = $("dName").value.trim().toLowerCase();
  show($("dErr"), false);
  if (!needle) { $("dErr").textContent = "Napiš aspoň část jména."; return show($("dErr"), true); }

  const wins = buckets($("dFrom").value, $("dTo").value, dGranularity);
  if (wins.length > 400) {
    $("dErr").textContent = "Přes 400 kroků. Zvol hrubší dělení nebo kratší rozsah.";
    return show($("dErr"), true);
  }

  const run = ++scanRun;
  $("dGo").dataset.running = "1";
  $("dGo").classList.add("quiet");
  $("dTrend").innerHTML = "";
  $("dList").innerHTML = "";

  const found = [];
  const seen = new Set(); // consecutive windows share an edge day, so drop repeats

  try {
    let conn = await connect();
    for (let i = 0; i < wins.length; i++) {
      if (run !== scanRun) break;
      $("dGo").textContent = `Zastavit — ${i + 1}/${wins.length}, nalezeno ${found.length}`;
      // Refresh the token periodically so long scans don't expire mid-run.
      if (i && i % 20 === 0) conn = await connect();
      const recs = await getRecords(conn, {
        rscId: state.rscId, scgId: state.scgId, from: wins[i].from, to: wins[i].to, max: 2000,
      });
      if (run !== scanRun) break;

      let added = 0;
      for (const r of recs) {
        if (!(r.participant || "").toLowerCase().includes(needle)) continue;
        const k = r.participant + "|" + r.date + "|" + r.score;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ ...r, secs: toSeconds(r.score) });
        added++;
      }
      // Only repaint when something actually changed, otherwise it flickers.
      if (added) renderList($("dList"), [...found].sort((a, b) => (a.secs ?? 1e9) - (b.secs ?? 1e9)), true);
      await sleep(180); // be gentle, this is their public widget backend
    }

    trend($("dTrend"), found.filter(f => f.secs != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date)));
    if (!found.length)
      $("dList").innerHTML = '<div class="empty">Nic. Jména jsou přezdívky z registrace, zkus kratší kus.</div>';
  } catch (e) {
    if (run === scanRun) { $("dErr").textContent = e.message; show($("dErr"), true); }
  } finally {
    if (run === scanRun) idleScanButton();
  }
};

/* -------------------------------- live ------------------------------- */

$("lGo").onclick = async () => {
  if (state.sock) {
    state.sock.close(); state.sock = null;
    $("lGo").textContent = "Připojit"; $("lGo").classList.remove("quiet");
    return;
  }
  $("lGo").textContent = "Připojuji…";
  try {
    const conn = await connect();
    const s = await api(conn, "livetiming/settings", { locale: "cs", styleId: "", resourceId: state.rscId });
    const ws = new WebSocket(`wss://${s.liveServerHost}:${s.liveServerWssPort}`);
    state.sock = ws;
    ws.onopen = () => {
      $("lGo").textContent = "Odpojit"; $("lGo").classList.add("quiet");
      ws.send("START " + s.liveServerKey);
    };
    ws.onmessage = (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = { _text: e.data }; }
      state.live = data;
      $("lDump").textContent = JSON.stringify(data, null, 2);
      show($("lRaw"), true);
      const empty = data && Object.keys(data).length === 0;
      $("lNote").textContent = empty ? "Připojeno. Zrovna neběží žádná jízda." : "";
      show($("lNote"), empty);
      // Message shape is undocumented: show the first array of objects we find.
      const arr = Object.values(data).find(v => Array.isArray(v) && v.length && typeof v[0] === "object");
      $("lList").innerHTML = !arr ? "" : arr.map(row =>
        `<div class="rec">` + Object.values(row).slice(0, 5)
          .map(v => `<span class="who" style="font-family:var(--mono);font-size:13px">${String(v)}</span>`)
          .join("") + `</div>`).join("");
    };
    ws.onerror = () => {
      $("lNote").textContent = "Spojení selhalo. Prohlížeč nemusí pustit port " + s.liveServerWssPort + ".";
      $("lNote").className = "note bad"; show($("lNote"), true);
    };
    ws.onclose = () => {
      state.sock = null;
      $("lGo").textContent = "Připojit"; $("lGo").classList.remove("quiet");
    };
  } catch (e) {
    $("lNote").textContent = e.message; $("lNote").className = "note bad"; show($("lNote"), true);
    $("lGo").textContent = "Připojit";
  }
};

$("lRaw").onclick = () => {
  const on = $("lDump").classList.contains("hide");
  show($("lDump"), on);
  $("lRaw").textContent = on ? "Skrýt surová data" : "Ukázat surová data";
};

/* ------------------------------- wiring ------------------------------ */

$("keyToggle").onclick = () => show($("keyPanel"), $("keyPanel").classList.contains("hide"));
$("keyApply").onclick = () => {
  state.key = $("keyInput").value.trim();
  show($("keyPanel"), false);
  $("bList").innerHTML = "";
  boot();
};
$("tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) selectTab(b.dataset.tab); };
$("bGo").onclick = loadBest;

$("bFrom").value = startOfMonth(); $("bTo").value = shiftDays(1);
$("dFrom").value = startOfYear();  $("dTo").value = shiftDays(1);
updateHint();
boot();
