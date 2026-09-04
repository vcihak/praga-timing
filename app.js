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
  if (!r.ok) {
    // The status travels with the error: whether this is worth retrying is a
    // decision for the caller, and matching on the message text would break
    // the moment the wording changed.
    const e = new Error(r.status === 401 || r.status === 403
      ? "Přihlášení vypršelo — zkouším znovu."
      : path + ": HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/* One token, renewed when the server rejects it.
 *
 * A scan of a single day is ninety-odd requests and will outlive a token. The
 * old code refreshed every twentieth request and hoped; this waits to be told.
 * The renewal is shared, so a burst of parallel requests that all get a 401
 * opens one handshake between them rather than one each. */
let liveConn = null, liveAt = 0, renewing = null;

// Tokens are short-lived and the handshake is one cheap request, so a tab left
// open overnight renews on its own rather than waiting to be refused. The
// retry below is the backstop for the token that dies early, not the plan.
const TOKEN_TTL = 4 * 60 * 1000;

async function token(force) {
  if (force || Date.now() - liveAt > TOKEN_TTL) liveConn = null;
  if (liveConn) return liveConn;
  renewing ??= connect()
    .then((c) => { liveConn = c; liveAt = Date.now(); renewing = null; return c; })
    .catch((e) => { renewing = null; throw e; });
  return renewing;
}

/* Windows are independent of each other, so they can be in flight together. A
 * handful at a time turns a day's scan from minutes into seconds; more than a
 * handful would be leaning on somebody else's public widget backend, which is
 * not ours to spend. */
const PARALLEL = 5;

async function pool(items, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) await worker(items[i], i);
    }),
  );
}

const getRecords = (conn, p) =>
  api(conn, "besttimes/records", {
    locale: "cs", rscId: p.rscId, scgId: p.scgId || "",
    startDate: p.from, endDate: p.to, maxResult: String(p.max || 200),
  }).then((d) => d.records || []);

// One window, with a single retry after the token has been renewed.
async function records(p) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await getRecords(await token(attempt > 0), p); }
    catch (e) { if (attempt || (e.status !== 401 && e.status !== 403)) throw e; }
  }
  return [];
}

/* ------------------------------- utils ------------------------------- */

// Local, not toISOString(): that converts to UTC first, so an evening in CEST
// comes out as the day before once the clock passes 22:00.
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = (d) => `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const shiftDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const startOfMonth = () => { const d = new Date(); d.setDate(1); return iso(d); };
const startOfYear = () => new Date().getFullYear() + "-01-01";
// Monday of the current week (getDay() is Sunday-based, so rotate it).
const mondayThisWeek = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return iso(d);
};

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

// The track is open roughly 10:00-22:00; the hour either side is slack, so a
// heat that started early or ran long is still inside a window. Everything
// outside is closed and asking about it is a request spent on nothing.
const OPEN_FROM = 9;
const OPEN_TO = 23;
// Under the length of a heat, so two heats never land in one window. The API
// answers with one best time per participant per window, and a window holding
// two heats reports the better of them and silently drops the other.
const HEAT_MINUTES = 9;

function heatWindows(from, to) {
  const out = [];
  const end = new Date(to + "T00:00:00");
  for (const d = new Date(from + "T00:00:00"); d <= end; d.setDate(d.getDate() + 1)) {
    for (let m = OPEN_FROM * 60; m < OPEN_TO * 60; m += HEAT_MINUTES) {
      const a = new Date(d); a.setHours(0, m, 0, 0);
      out.push({ from: stamp(a), to: stamp(new Date(+a + HEAT_MINUTES * 60000)) });
    }
  }
  return out;
}

function buckets(from, to, size) {
  if (size === "heat") return heatWindows(from, to);
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

/* Who you actually came with.
 *
 * There is no account and no server, so "our group" cannot be anything but a
 * list this browser remembers. Names are the only handle the API gives — they
 * are registration nicknames, stable enough for an evening and for a season of
 * driving with the same people.
 */
const FAVS = "praga.favs";

function favs() {
  try { return new Set(JSON.parse(localStorage.getItem(FAVS) || "[]")); }
  catch { return new Set(); }
}

function toggleFav(name) {
  const set = favs(), k = (name || "").toLowerCase();
  if (!k) return;
  set.has(k) ? set.delete(k) : set.add(k);
  try { localStorage.setItem(FAVS, JSON.stringify([...set])); } catch { /* private mode */ }
}

const isFav = (set, name) => set.has((name || "").toLowerCase());

const escaped = (t) => { const d = document.createElement("div"); d.textContent = t || ""; return d.innerHTML; };

function renderList(el, rows, highlight) {
  const set = favs();
  if (el.dataset.favOnly === "1") rows = rows.filter((r) => isFav(set, r.participant));
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${el.dataset.favOnly === "1"
      ? "Nikdo z oblíbených tu není. Označ lidi hvězdičkou v seznamu."
      : "Nic tu není. Zkus širší rozsah."}</div>`;
    return;
  }
  el.innerHTML = rows.map((r, i) => {
    // Ranking within a filtered list is renumbered, so a starred group reads
    // as its own leaderboard rather than as gaps in somebody else's.
    const rank = highlight || el.dataset.favOnly === "1" ? i + 1 : (r.position ?? i + 1);
    const on = isFav(set, r.participant);
    return `<div class="rec" data-top="${rank === 1 ? 1 : 0}">
      <span class="pos">${rank}</span>
      <button class="star" data-fav="${escaped(r.participant)}" data-on="${on ? 1 : 0}"
        title="Oblíbený">${on ? "★" : "☆"}</button>
      <span class="who" ${highlight ? 'style="color:var(--accent)"' : ""}>${escaped(r.participant)}</span>
      <button class="when at" data-at="${escaped(r.date)}"
        title="Ukázat celou tuhle jízdu">${czDate(r.date)}</button>
      <span class="score">${r.score}</span></div>`;
  }).join("");
}

// One handler per list rather than one per row: the lists are rebuilt on every
// repaint and per-row listeners would leak with them.
function wireStars(el, repaint) {
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-fav]");
    if (!b) return;
    toggleFav(b.dataset.fav);
    repaint();
  });
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
    const conn = await token(true);
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
    $("bootErr").textContent = e.message +
      " Klíč Praga zveřejňuje v odkazu na registraci na pragaarena.cz — vezmi z něj parametr ?key= a vlož ho nahoře pod „klíč“." +
      " Pokud jde o síťovou chybu, otevři stránku přes https, ne ze souboru.";
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

const PRESET_DEFAULT = "Dnes";
$("presets").innerHTML = PRESETS.map(([l], i) =>
  `<button class="chip" data-p="${i}" data-on="${l === PRESET_DEFAULT ? 1 : 0}">${l}</button>`).join("");

$("presets").onclick = (e) => {
  const b = e.target.closest("[data-p]"); if (!b) return;
  [...$("presets").children].forEach(c => c.dataset.on = c === b ? "1" : "0");
  // A preset is a span of whole days, so it also leaves the heat view.
  rangeBefore = null;
  show($("bBack"), false);
  setClock(false);
  $("bFrom").value = PRESETS[+b.dataset.p][1]();
  $("bTo").value = shiftDays(0);
  loadBest();
};

// Kept so starring somebody can repaint the list without asking again.
let bestRows = [];

const withTime = () => $("bClock").dataset.on === "1";

/* "Do" means what it says.
 *
 * The API's endDate is exclusive, which is why this field used to hold
 * tomorrow's date and nobody could tell whether a range included its last day.
 * The field is inclusive now and the exclusive end is worked out here: the day
 * after when there is no time, the minute after when there is.
 */
function apiRange() {
  if (!withTime()) {
    const end = new Date($("bTo").value + "T00:00:00");
    end.setDate(end.getDate() + 1);
    return { from: $("bFrom").value + "T00:00:00", to: stamp(end) };
  }
  const end = new Date($("bTo").value);
  end.setMinutes(end.getMinutes() + 1);
  return { from: stamp(new Date($("bFrom").value)), to: stamp(end) };
}

// Says out loud what was asked for, because a range with times in it is not
// something you can read off two input boxes at a glance.
function describeRange() {
  const r = apiRange();
  const nice = (t) => t.replace("T", " ").slice(0, withTime() ? 16 : 10);
  const end = new Date(r.to);
  end.setMinutes(end.getMinutes() - (withTime() ? 1 : 0));
  if (!withTime()) end.setDate(end.getDate() - 1);
  $("bWhat").textContent = `${nice(r.from)} — ${nice(stamp(end))} včetně`;
}

async function loadBest() {
  show($("bErr"), false);
  describeRange();
  $("bList").innerHTML = '<div class="empty">Načítám…</div>';
  try {
    const r = apiRange();
    bestRows = await records({
      rscId: state.rscId, scgId: state.scgId,
      from: r.from, to: r.to, max: +$("bMax").value || 100,
    });
    renderList($("bList"), bestRows, false);
  } catch (e) {
    $("bList").innerHTML = "";
    $("bErr").textContent = e.message;
    show($("bErr"), true);
  }
}

/* Switching the two boxes between a day and a moment.
 *
 * Same two fields either way rather than four: a range with times is the rare
 * case, and making it visible all the time would mean typing an hour you do
 * not care about every time you look at a week.
 */
function setClock(on) {
  $("bClock").dataset.on = on ? "1" : "0";
  $("bRange").classList.toggle("stack", on);
  for (const id of ["bFrom", "bTo"]) {
    const el = $(id), day = (el.value || "").slice(0, 10);
    el.type = on ? "datetime-local" : "date";
    el.value = on ? day + (id === "bFrom" ? "T00:00" : "T23:59") : day;
  }
  describeRange();
}

$("bClock").onclick = () => { setClock(!withTime()); loadBest(); };

/* Tap a time to see the heat it belongs to.
 *
 * "Who did I drive with" is the question this page could not answer without
 * typing two timestamps, and typing them is exactly what nobody does standing
 * in the paddock. Six minutes either side of the lap is the whole heat and
 * usually nothing else; heats do not start on a grid, so the odd neighbour
 * from the session before can slip in. Better that than missing half a heat.
 */
const HEAT_ZOOM = 6;
const localMin = (d) => stamp(d).slice(0, 16);

let rangeBefore = null;

function zoomToHeat(when) {
  const t = new Date(when);
  if (isNaN(+t)) return;
  if (!rangeBefore) {
    rangeBefore = { clock: withTime(), from: $("bFrom").value, to: $("bTo").value };
  }
  // No preset describes one heat, so stop claiming one does.
  [...$("presets").children].forEach((c) => (c.dataset.on = "0"));
  setClock(true);
  $("bFrom").value = localMin(new Date(+t - HEAT_ZOOM * 60000));
  $("bTo").value = localMin(new Date(+t + HEAT_ZOOM * 60000));
  show($("bBack"), true);
  selectTab("best");
  loadBest();
}

$("bBack").onclick = () => {
  if (!rangeBefore) return;
  // Values after the switch, not before: setClock rewrites them from the day.
  setClock(rangeBefore.clock);
  $("bFrom").value = rangeBefore.from;
  $("bTo").value = rangeBefore.to;
  rangeBefore = null;
  show($("bBack"), false);
  loadBest();
};

for (const id of ["bList", "dList"]) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("[data-at]");
    if (b) zoomToHeat(b.dataset.at);
  });
}

wireStars($("bList"), () => renderList($("bList"), bestRows, false));

$("bFav").onclick = () => {
  const el = $("bList");
  const on = el.dataset.favOnly !== "1";
  el.dataset.favOnly = on ? "1" : "0";
  $("bFav").dataset.on = on ? "1" : "0";
  renderList(el, bestRows, false);
};

/* ---------------------------- driver hunt ---------------------------- */

const SIZES = [
  ["heat", "Po jízdách"], ["day", "Po dnech"], ["week", "Po týdnech"], ["month", "Po měsících"],
];
let dGranularity = "day";
$("dSize").innerHTML = SIZES.map(([v, l]) =>
  `<button class="chip" data-s="${v}" data-on="${v === dGranularity ? 1 : 0}">${l}</button>`).join("");
$("dSize").onclick = (e) => {
  const b = e.target.closest("[data-s]"); if (!b) return;
  dGranularity = b.dataset.s;
  [...$("dSize").children].forEach(c => c.dataset.on = c === b ? "1" : "0");
  updateHint();
};

function updateHint() {
  const n = buckets($("dFrom").value, $("dTo").value, dGranularity).length;
  const heat = dGranularity === "heat"
    ? ` Po jízdách se ptá jen na otevírací dobu (${OPEN_FROM}–${OPEN_TO} h), po ${HEAT_MINUTES} minutách.`
    : "";
  $("dHint").textContent =
    `API vrací jeden nejlepší čas na jezdce za dotázané okno, takže jemnější dělení znamená hustší historii a víc dotazů.` +
    ` Teď ${n}, po ${PARALLEL} současně.${heat}`;
  return n;
}
["dFrom", "dTo"].forEach(id => $(id).addEventListener("change", updateHint));

let scanRun = 0;
let dFound = [];

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
  // Raised now that windows go out in parallel: a week by heat is ~660 of them
  // and finishes in well under a minute.
  if (wins.length > 1500) {
    $("dErr").textContent = `Přes 1500 kroků (${wins.length}). Zvol hrubší dělení nebo kratší rozsah.`;
    return show($("dErr"), true);
  }

  const run = ++scanRun;
  $("dGo").dataset.running = "1";
  $("dGo").classList.add("quiet");
  $("dTrend").innerHTML = "";
  $("dList").innerHTML = "";

  const found = dFound = [];
  const seen = new Set(); // consecutive windows share an edge day, so drop repeats

  let done = 0, failed = 0;

  try {
    // One window failing does not end the scan. Over hundreds of requests a
    // stray timeout is ordinary, and throwing away everything already found
    // because of one would be the wrong trade.
    await pool(wins, async (win) => {
      if (run !== scanRun) return;
      let recs;
      try {
        recs = await records({
          rscId: state.rscId, scgId: state.scgId, from: win.from, to: win.to, max: 2000,
        });
      } catch { failed++; return; }
      if (run !== scanRun) return;

      let added = 0;
      for (const r of recs) {
        if (!(r.participant || "").toLowerCase().includes(needle)) continue;
        const k = r.participant + "|" + r.date + "|" + r.score;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push({ ...r, secs: toSeconds(r.score) });
        added++;
      }
      $("dGo").textContent = `Zastavit — ${++done}/${wins.length}, nalezeno ${found.length}`;
      // Only repaint when something actually changed, otherwise it flickers.
      if (added) renderList($("dList"), [...found].sort((a, b) => (a.secs ?? 1e9) - (b.secs ?? 1e9)), true);
    });

    if (run !== scanRun) return;

    trend($("dTrend"), found.filter(f => f.secs != null)
      .sort((a, b) => new Date(a.date) - new Date(b.date)));
    if (!found.length)
      $("dList").innerHTML = '<div class="empty">Nic. Jména jsou přezdívky z registrace, zkus kratší kus.</div>';
    if (failed) {
      $("dErr").textContent = `${failed} z ${wins.length} oken se nepodařilo načíst; zbytek je výš.`;
      show($("dErr"), true);
    }
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
      // The shape is undocumented. The old version printed the first five
      // values of each row, which is why this read as unexplained numbers:
      // without the field names there was no telling a lap time from a kart
      // number. Names and values together are at least debuggable at the track.
      const arr = Object.values(data).find(v => Array.isArray(v) && v.length && typeof v[0] === "object");
      $("lList").innerHTML = !arr ? "" : arr.map((row) =>
        `<div class="rec kv">` + Object.entries(row)
          .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
          .map(([k, v]) => `<span class="pair"><b>${escaped(k)}</b>${escaped(String(v))}</span>`)
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

wireStars($("dList"), () =>
  renderList($("dList"), [...dFound].sort((a, b) => (a.secs ?? 1e9) - (b.secs ?? 1e9)), true));

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

// Today on the leaderboard, this week on the driver page: both are what you
// want when you have just got off the track, and both are cheap to ask for.
$("bFrom").value = shiftDays(0);      $("bTo").value = shiftDays(0);
$("dFrom").value = mondayThisWeek();  $("dTo").value = shiftDays(0);
updateHint();
boot();
