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

const KEY_STORE = "praga.key";
const FAVS = "praga.favs";

const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hide", !on);

/* Escaping for both text and attributes.
 *
 * The old helper round-tripped through textContent, which escapes & < > and
 * leaves quotes alone — fine for text, wrong for the attributes these strings
 * actually land in. Nicknames are free-text registration input, so a single
 * double quote was enough to break out of data-fav="…" and inject markup. */
const esc = (t) => String(t ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// The live feed pads names to a fixed width and the records API may not, so
// both sides are squeezed through here before anything compares or stores
// them. Otherwise starring somebody live would not star them on the board.
const norm = (n) => String(n ?? "").replace(/\s+/g, " ").trim();

const state = { rscId: "", resources: null, live: null, key: "" };

/* A heat is the default: "which sessions did I drive" is the question people
 * arrive with, and the coarse-to-fine scan made it cheap enough to ask without
 * being asked to. */
const SIZES = [
  ["heat", "Po jízdách"], ["day", "Po dnech"], ["week", "Po týdnech"], ["month", "Po měsících"],
];
const SIZE_DEFAULT = "heat";


/* ---------------------------- track time -----------------------------
 *
 * Every time in this app is track wall-clock, never the reader's. A phone in
 * another timezone must still say that a heat ran at 20:35, and "today" must
 * mean today at the track. So: one conversion at the edges, into a Date whose
 * *UTC* fields hold Prague wall-clock, and plain UTC arithmetic from there.
 * Nothing in between ever touches a local getter. */
const TZ = "Europe/Prague";
const TZ_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ, hour12: false, year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

function wallOf(d) {
  const p = {};
  for (const { type, value } of TZ_PARTS.formatToParts(d)) p[type] = value;
  // Some engines render midnight as hour 24 under hour12:false.
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second));
}

const nowWall = () => wallOf(new Date());

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const ZONED = /([Zz]|[+-]\d{2}:?\d{2})$/;

// A timestamp from the API. Naive strings are track wall-clock already and
// must not be reinterpreted; a string that does carry an offset is converted.
function wall(s) {
  if (s instanceof Date) return isNaN(+s) ? null : wallOf(s);
  const t = String(s ?? "").trim();
  const m = t.match(NAIVE);
  if (m && !ZONED.test(t)) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  const d = new Date(t);
  return isNaN(+d) ? null : wallOf(d);
}

// "YYYY-MM-DD" (a date input) -> wall midnight. The old code passed this same
// string to new Date() in one place and to new Date(s+"T00:00:00") in another,
// which are a day apart west of Greenwich.
function wallDay(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const stamp = (d) => `${iso(d)}T${hhmm(d)}:00`;
const addDays = (d, n) => { const x = new Date(+d); x.setUTCDate(x.getUTCDate() + n); return x; };
const addMin = (d, n) => new Date(+d + n * 60000);

const today = () => iso(nowWall());
const shiftDays = (n) => iso(addDays(nowWall(), n));
const startOfMonth = () => { const d = nowWall(); d.setUTCDate(1); return iso(d); };
const startOfYear = () => nowWall().getUTCFullYear() + "-01-01";
// Monday of the current week (getUTCDay is Sunday-based, so rotate it).
const mondayThisWeek = () => { const d = nowWall(); return iso(addDays(d, -((d.getUTCDay() + 6) % 7))); };

const czDate = (s) => { const d = wall(s); return d ? `${d.getUTCDate()}.${d.getUTCMonth() + 1}. ${hhmm(d)}` : ""; };
const czDay = (s) => { const d = wall(s); return d ? `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}` : ""; };

// "16.341" -> 16.341 ; "1:00.796" -> 60.796
function toSeconds(s) {
  if (!s) return null;
  const p = String(s).split(":").map(parseFloat);
  return p.some(isNaN) ? null : p.reduce((a, n) => a * 60 + n, 0);
}

/* -------------------------------- api -------------------------------- */

async function connect() {
  const r = await fetch(HANDSHAKE, { headers: { Authorization: "Basic " + state.key } });
  if (!r.ok) throw new Error("Nepřipojil jsem se (HTTP " + r.status + "). Zkontroluj odkaz.");
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
      : "Nepodařilo se načíst data (HTTP " + r.status + ").");
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

const query = (p) => records({ rscId: state.rscId, scgId: view.scg, ...p });

/* ------------------------------ windows ------------------------------ */

// The track is open roughly 10:00-22:00; the hour either side is slack, so a
// heat that started early or ran long is still inside a window.
const OPEN_FROM = 9;
const OPEN_TO = 23;
// Under the length of a heat, so two heats never land in one window. The API
// answers with one best time per participant per window, and a window holding
// two heats reports the better of them and silently drops the other.
const HEAT_MINUTES = 9;

const winOf = (a, b) => ({ from: stamp(a), to: stamp(b), a, b });

function heatWindows(from, to) {
  const out = [], end = wallDay(to);
  for (let d = wallDay(from); d && d <= end; d = addDays(d, 1))
    for (let m = OPEN_FROM * 60; m < OPEN_TO * 60; m += HEAT_MINUTES) {
      const a = addMin(d, m);
      out.push(winOf(a, addMin(a, HEAT_MINUTES)));
    }
  return out;
}

// Whole days, as full stamps rather than bare dates, so every window in the
// app is expressed the same way.
function dayWindows(from, to) {
  const out = [], end = wallDay(to);
  for (let d = wallDay(from); d && d <= end; d = addDays(d, 1))
    out.push({ ...winOf(d, addDays(d, 1)), day: iso(d) });
  return out;
}

function buckets(from, to, size) {
  if (size === "heat") return heatWindows(from, to);
  if (size === "day") return dayWindows(from, to);
  const out = [], end = wallDay(to);
  let cur = wallDay(from);
  if (!cur || !end) return out;
  while (cur <= end) {
    const next = size === "week" ? addDays(cur, 7)
      : (() => { const n = new Date(+cur); n.setUTCMonth(n.getUTCMonth() + 1); return n; })();
    out.push(winOf(cur, next > end ? addDays(end, 1) : next));
    cur = next;
  }
  return out;
}

/* ----------------------------- favourites ----------------------------
 *
 * There is no account and no server, so "our group" cannot be anything but a
 * list this browser remembers. Names are the only handle the API gives — they
 * are registration nicknames, stable enough for an evening and for a season of
 * driving with the same people. */
const favKey = (name) => norm(name).toLowerCase();

/* Stored as the names you actually typed, matched on a squashed lowercase key.
 * Keeping only the key meant the group panel listed "petra" — a list of your
 * friends should spell them the way they spell themselves. Older browsers hold
 * the key-only array, which reads back as a list of names and needs no
 * migration beyond looking a little shouty until re-added. */
function favs() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(FAVS) || "[]"); } catch { /* corrupt */ }
  const m = new Map();
  if (Array.isArray(raw)) for (const n of raw) {
    const name = norm(n);
    if (name) m.set(favKey(name), name);
  }
  return m;
}

function toggleFav(name) {
  const set = favs(), k = favKey(name);
  if (!k) return;
  set.has(k) ? set.delete(k) : set.set(k, norm(name));
  setFavs(set);
}

const isFav = (set, name) => set.has(favKey(name));

function setFavs(set) {
  try { localStorage.setItem(FAVS, JSON.stringify([...set.values()])); } catch { /* private mode */ }
  renderFavPanel();
}

/* Favourites, as a thing you can look at and edit.
 *
 * Starring people built a list that only existed as scattered gold stars in
 * whichever list you happened to be looking at: no way to see who was on it, no
 * way to take somebody off without hunting them down, and no way to give it to
 * the friend standing next to you. */
function renderFavPanel() {
  const names = [...favs().values()].sort((a, b) => a.localeCompare(b, "cs"));
  const el = $("favList");
  if (!el) return;
  el.innerHTML = names.length
    ? names.map((n) => `<div class="favrow"><span class="who">${esc(n)}</span>
        <button class="ghost" data-unfav="${esc(n)}" title="Odebrat">✕</button></div>`).join("")
    : `<p class="hint">Zatím nikdo.</p>`;
  show($("dGroup"), names.length > 0);
}

$("favList").onclick = (e) => {
  const b = e.target.closest("[data-unfav]");
  if (!b) return;
  const set = favs();
  set.delete(favKey(b.dataset.unfav));
  setFavs(set);
  repaintLists();
};

function addFav(raw) {
  const name = norm(raw);
  if (!name) return;
  const set = favs();
  set.set(favKey(name), name);
  setFavs(set);
  repaintLists();
}

$("favAdd").addEventListener("change", () => { addFav($("favAdd").value); $("favAdd").value = ""; });

$("favClear").onclick = () => {
  if (!favs().size) return;
  // Two taps, because this is the one control that throws away a season of
  // names and there is no server holding a copy.
  if ($("favClear").dataset.armed === "1") {
    setFavs(new Set());
    $("favClear").dataset.armed = "0";
    $("favClear").textContent = "Vymazat vše";
    repaintLists();
    return;
  }
  $("favClear").dataset.armed = "1";
  $("favClear").textContent = "Opravdu vymazat?";
  setTimeout(() => {
    $("favClear").dataset.armed = "0";
    $("favClear").textContent = "Vymazat vše";
  }, 4000);
};

$("favShare").onclick = () => {
  const names = [...favs().values()];
  if (!names.length) return;
  const u = new URL(location.href);
  u.search = new URLSearchParams({ favs: names.join(",") }).toString();
  shareThis("Oblíbení na Praga Timing", u.toString());
};

function favNote(text) {
  $("favNote").textContent = text || "";
  show($("favNote"), !!text);
}

// A shared group arrives as a parameter and is merged, never substituted: the
// friend who sent it should not wipe the list of the friend who opened it.
function importFavs() {
  const p = new URLSearchParams(location.search);
  const raw = p.get("favs");
  if (!raw) return;
  const set = favs();
  let added = 0;
  for (const n of raw.split(",")) {
    const name = norm(n), k = favKey(name);
    if (k && !set.has(k)) { set.set(k, name); added++; }
  }
  setFavs(set);
  p.delete("favs");
  try { history.replaceState({ app: 1 }, "", p.toString() ? "?" + p : location.pathname); } catch { /* opaque origin */ }
  if (added) {
    show($("groupPanel"), true);
    favNote(`Přidáno ${added} ${added === 1 ? "jméno" : added < 5 ? "jména" : "jmen"}.`);
  }
}

$("groupToggle").onclick = () => {
  const on = $("groupPanel").classList.contains("hide");
  show($("groupPanel"), on);
  if (on) { show($("keyPanel"), false); favNote(""); }
};

// Every list that draws a star has to hear about a change made somewhere else.
function repaintLists() {
  paintBest();
  if (dFound.length) paintDriver();
  if (heatRows.length) paintHeat();
  if (LIVE.shown) renderLive(LIVE.shown.data, LIVE.shown.ended);
}

/* ----------------------------- record list ---------------------------- */

function renderList(el, rows, opts = {}) {
  const { renumber = false, focus = "", plainWhen = false, favOnly = false, colorOf = null } = opts;
  const set = favs();
  if (favOnly) rows = rows.filter((r) => isFav(set, r.participant));
  if (!rows.length) {
    el.innerHTML = `<div class="empty">${favOnly
      ? "Nikdo z oblíbených tu není."
      : "Nic tu není. Zkus širší rozsah."}</div>`;
    return;
  }
  const focusKey = favKey(focus);
  el.innerHTML = rows.map((r, i) => {
    // Ranking within a filtered list is renumbered, so a starred group reads
    // as its own leaderboard rather than as gaps in somebody else's.
    const rank = renumber || favOnly ? i + 1 : (r.position ?? i + 1);
    const name = norm(r.participant);
    const on = isFav(set, name);
    const w = wall(r.date);
    const when = plainWhen
      ? `<span class="when">${w ? esc(hhmm(w)) : ""}</span>`
      : `<button class="when" data-at="${esc(r.date)}" data-who="${esc(name)}"
           title="Ukázat celou tuhle jízdu">${esc(czDate(r.date))}</button>`;
    return `<div class="rec" data-top="${rank === 1 ? 1 : 0}" data-focus="${focusKey && favKey(name) === focusKey ? 1 : 0}">
      <span class="pos">${rank}</span>
      <button class="star" data-fav="${esc(name)}" data-on="${on ? 1 : 0}"
        aria-pressed="${on}" title="Oblíbený">${on ? "★" : "☆"}</button>
      ${colorOf ? `<span class="swatch" style="background:${esc(colorOf(name)) || "transparent"}"></span>` : ""}
      <span class="who">${esc(name)}</span>
      ${when}
      <span class="score">${esc(r.score)}</span></div>`;
  }).join("");
}

// One handler per list rather than one per row: the lists are rebuilt on every
// repaint and per-row listeners would leak with them. The same handler carries
// the star toggle and the tap-through into a single heat.
function wireList(el, repaint) {
  el.addEventListener("click", (e) => {
    const star = e.target.closest("[data-fav]");
    if (star) { toggleFav(star.dataset.fav); repaint(); return; }
    const at = e.target.closest("[data-at]");
    if (at) openHeat(at.dataset.at, at.dataset.who);
  });
}

/* ------------------------------- url state ---------------------------
 *
 * Every view the app can be in is a query string, so the browser's own back
 * button is the only back button the app needs, a reload lands where you were,
 * and a view can be sent to somebody. Query string and not a path, because
 * GitHub Pages serves index.html for the directory and would 404 on a made-up
 * path segment. */
const DEFAULTS = () => ({
  tab: "best", scg: "", heat: "", who: "",
  from: today(), to: today(), clock: 0, ft: "00:00", tt: "23:59", max: 100, fav: 0, preset: 0,
  q: "", df: mondayThisWeek(), dt: today(), sz: SIZE_DEFAULT,
});

const PARAM = {
  tab: "tab", scg: "scg", heat: "heat", who: "who", from: "from", to: "to",
  clock: "t", ft: "ft", tt: "tt", max: "max", fav: "fav", preset: "p",
  q: "q", df: "df", dt: "dt", sz: "sz",
};

const view = DEFAULTS();

function readUrl() {
  const p = new URLSearchParams(location.search), d = DEFAULTS();
  for (const [k, name] of Object.entries(PARAM)) {
    if (!p.has(name)) { view[k] = d[k]; continue; }
    const raw = p.get(name);
    view[k] = typeof d[k] === "number" ? (Number.isFinite(+raw) ? +raw : d[k]) : raw;
  }
  if (!["best", "driver", "live"].includes(view.tab)) view.tab = "best";
  if (!SIZES.some(([v]) => v === view.sz)) view.sz = SIZE_DEFAULT;
  view.max = Math.min(500, Math.max(1, view.max || 100));
}

function urlSearch() {
  const p = new URLSearchParams(), d = DEFAULTS();
  for (const [k, name] of Object.entries(PARAM)) {
    // Defaults stay out, so the common case is a bare URL rather than a wall
    // of parameters that all say "unchanged".
    if (String(view[k]) !== String(d[k]) && view[k] !== "" && view[k] != null) p.set(name, view[k]);
  }
  if (state.key && state.key !== DEFAULT_KEY) p.set("key", state.key);
  const s = p.toString();
  return s ? "?" + s : location.pathname;
}

// file:// has an opaque origin and refuses pushState; the app still works, it
// just loses the back button there.
function writeUrl(push) {
  try { history[push ? "pushState" : "replaceState"]({ app: 1 }, "", urlSearch()); }
  catch { /* opaque origin */ }
}

// One entry point for "the view changed": update the URL, then make the DOM
// agree with it. Nothing else calls applyView directly.
function commit(push) {
  writeUrl(push);
  applyView();
}

let pushedHeat = false;
addEventListener("popstate", () => { pushedHeat = false; readUrl(); applyView(); });

/* ------------------------------- apply -------------------------------- */

const setVal = (id, v) => { if ($(id).value !== String(v)) $(id).value = String(v); };

function applyView() {
  const onHeat = !!view.heat;

  [...$("tabs").children].forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === view.tab)));
  show($("tabs"), !onHeat && !!state.rscId);
  show($("groups"), !onHeat && !!state.rscId && view.tab !== "live" && $("groups").children.length > 0);
  ["best", "driver", "live"].forEach((k) => show($("panel-" + k), !onHeat && k === view.tab && !!state.rscId));
  show($("panel-heat"), onHeat);
  if (onHeat || view.tab !== "best") show($("bSticky"), false);

  [...$("groups").children].forEach((c) => (c.dataset.on = c.dataset.scg === view.scg ? "1" : "0"));
  [...$("presets").children].forEach((c) => (c.dataset.on = +c.dataset.p === view.preset ? "1" : "0"));

  setVal("bFrom", view.from); setVal("bTo", view.to);
  setVal("bFromT", view.ft); setVal("bToT", view.tt); setVal("bMax", view.max);
  $("bClock").dataset.on = view.clock ? "1" : "0";
  for (const el of document.querySelectorAll("#bRange .tm")) show(el, !!view.clock);
  $("bFav").dataset.on = $("bStickyFav").dataset.on = view.fav ? "1" : "0";

  setVal("dName", view.q); setVal("dFrom", view.df); setVal("dTo", view.dt);
  [...$("dSize").children].forEach((c) => (c.dataset.on = c.dataset.s === view.sz ? "1" : "0"));
  updateDriverControls();

  if (!state.rscId) return;

  // Opening the live tab means you want the feed; the only reason not to start
  // it is that you pressed Odpojit yourself.
  if (!onHeat && view.tab === "live" && !LIVE.want && !LIVE.optedOut) {
    LIVE.want = true; LIVE.tries = 0;
    liveButton();
    liveConnect();
  }

  if (onHeat) { loadHeat(); return; }
  if (view.tab === "best") {
    describeRange();
    if (bestSig() !== bestLoaded) loadBest();
    else paintBest();
  }
}

/* -------------------------------- boot ------------------------------- */

function storedKey() {
  try { return localStorage.getItem(KEY_STORE) || ""; } catch { return ""; }
}

async function boot() {
  state.key = new URLSearchParams(location.search).get("key") || storedKey() || DEFAULT_KEY;
  $("keyInput").value = state.key;
  show($("keyReset"), state.key !== DEFAULT_KEY);
  show($("bootErr"), false);
  $("trackName").textContent = "Načítám";
  $("trackSub").textContent = "…";
  try {
    const conn = await token(true);
    state.resources = await api(conn, "besttimes/resources", { locale: "cs", rscId: "" });
    const r = state.resources[0];
    state.rscId = r.resourceId;
    $("trackName").textContent = state.key === DEFAULT_KEY ? VENUE : conn.ClientKey;
    // The resource id meant nothing to anybody standing at the track. The
    // track's own clock does, and it is also the honest label for every time
    // on the page, none of which are in the reader's timezone.
    state.venueLine = r.name;
    tickClock();
    renderGroups(r.scoregroups || []);
    applyView();
  } catch (e) {
    state.rscId = "";
    $("trackName").textContent = "Nepřipojeno";
    $("trackSub").textContent = "";
    $("bootMsg").textContent = e.message;
    show($("bootErr"), true);
    // The advice is "paste a key", so open the place where you paste it.
    show($("keyPanel"), true);
    applyView();
  }
}

function tickClock() {
  if (!state.venueLine) return;
  $("trackSub").textContent = state.venueLine + " · " + hhmm(nowWall());
}
setInterval(tickClock, 20000);

function renderGroups(gs) {
  const el = $("groups");
  if (gs.length < 2) { el.innerHTML = ""; return show(el, false); }
  el.innerHTML = `<button class="chip" data-scg="" data-on="1">Vše</button>` +
    gs.map((g) => `<button class="chip" data-scg="${esc(g.id)}" data-on="0">${esc(g.name)}</button>`).join("");
  el.onclick = (e) => {
    const b = e.target.closest("[data-scg]"); if (!b) return;
    view.scg = b.dataset.scg;
    commit(false);
  };
}

/* ----------------------------- best times ---------------------------- */

const PRESETS = [
  ["Dnes", () => shiftDays(0)], ["Tento týden", mondayThisWeek],
  ["7 dní", () => shiftDays(-7)], ["30 dní", () => shiftDays(-30)],
  ["Měsíc", startOfMonth], ["Rok", startOfYear], ["Vše", () => "2000-01-01"],
];

$("presets").innerHTML = PRESETS.map(([l], i) =>
  `<button class="chip" data-p="${i}" data-on="${i === 0 ? 1 : 0}">${esc(l)}</button>`).join("");

$("presets").onclick = (e) => {
  const b = e.target.closest("[data-p]"); if (!b) return;
  view.preset = +b.dataset.p;
  view.clock = 0;
  view.from = PRESETS[view.preset][1]();
  view.to = shiftDays(0);
  commit(false);
};

let bestRows = [], bestLoaded = null, bestAt = 0;

const bestSig = () => JSON.stringify([view.from, view.to, view.clock, view.ft, view.tt, view.max, view.scg]);

/* Our own time field rather than the browser's.
 *
 * A datetime-local input is drawn by the browser in the browser's language,
 * which is not something a page can override. On an English-language browser
 * that means AM/PM and a field too wide for a phone. Four digits and a colon
 * are the same in every locale. */
function clockTime(value, fallback) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 3) return fallback;
  const h = Math.min(23, +digits.slice(0, digits.length - 2));
  const m = Math.min(59, +digits.slice(-2));
  return pad(h) + ":" + pad(m);
}

/* "Do" means what it says.
 *
 * The API's endDate is exclusive, which is why this field used to hold
 * tomorrow's date and nobody could tell whether a range included its last day.
 * The field is inclusive and the exclusive end is worked out here — and
 * because a day with no time given runs to 23:59, both cases are the same
 * sum: take the last minute wanted and add one. */
function apiRange() {
  const firstMinute = view.clock ? clockTime(view.ft, "00:00") : "00:00";
  const lastMinute = view.clock ? clockTime(view.tt, "23:59") : "23:59";
  const start = wall(view.from + "T" + firstMinute + ":00");
  const end = wall(view.to + "T" + lastMinute + ":00");
  return {
    ok: !!(start && end && start <= end),
    filled: !!(start && end),
    from: start && stamp(start),
    to: end && stamp(addMin(end, 1)),
    endsAfter: end && addMin(end, 1),
    firstMinute, lastMinute,
  };
}

// Says out loud what was asked for, because a range with times in it is not
// something you can read off two input boxes at a glance.
function describeRange() {
  const r = apiRange();
  const cz = (d, t) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.split("-").reverse().map(Number).join(".") : "?")
    + (view.clock ? " " + t : "");
  const text = `${cz(view.from, r.firstMinute)} — ${cz(view.to, r.lastMinute)}`
    + (autoRefreshes() ? " · obnovuje se" : "");
  $("bWhat").textContent = text;
  $("bStickyWhat").textContent = text;
}

const paintBest = () =>
  renderList($("bList"), bestRows, { favOnly: !!view.fav });

async function loadBest(quiet) {
  const sig = bestSig();
  const r = apiRange();
  show($("bErr"), false);
  describeRange();
  if (!r.ok) {
    // Not marked as loaded: an unusable range should keep saying so rather
    // than fall through to the empty-list message on the next repaint.
    bestRows = []; bestLoaded = null;
    $("bList").innerHTML = "";
    $("bErr").textContent = r.filled ? "„Do“ je dřív než „Od“. Prohoď je." : "Doplň oba dny.";
    return show($("bErr"), true);
  }
  bestLoaded = sig;
  if (!quiet) $("bList").innerHTML = '<div class="empty">Načítám…</div>';
  try {
    const rows = await query({ from: r.from, to: r.to, max: view.max });
    if (bestSig() !== sig) return; // the view moved on while this was in flight
    bestRows = rows;
    bestAt = Date.now();
    paintBest();
  } catch (e) {
    if (bestSig() !== sig) return;
    bestLoaded = null;
    bestAt = Date.now();   // an error must not turn the auto-refresh into a hammer
    if (!quiet) $("bList").innerHTML = "";
    $("bErr").textContent = e.message;
    show($("bErr"), true);
  }
}

wireList($("bList"), paintBest);

const toggleFavOnly = () => { view.fav = view.fav ? 0 : 1; commit(false); };
$("bFav").onclick = toggleFavOnly;
$("bStickyFav").onclick = toggleFavOnly;

$("bClock").onclick = () => { view.clock = view.clock ? 0 : 1; view.preset = -1; commit(false); };

// Typing in a filter loads the result; the button is a refresh, not a submit.
let typeTimer = null;
function fromInputs(delay) {
  clearTimeout(typeTimer);
  typeTimer = setTimeout(() => {
    view.from = $("bFrom").value; view.to = $("bTo").value;
    view.ft = clockTime($("bFromT").value, "00:00");
    view.tt = clockTime($("bToT").value, "23:59");
    view.max = Math.min(500, Math.max(1, +$("bMax").value || 100));
    view.preset = -1;
    commit(false);
  }, delay);
}
for (const id of ["bFrom", "bTo", "bMax"]) $(id).addEventListener("change", () => fromInputs(0));
for (const id of ["bFromT", "bToT"]) {
  // Tidied when you leave the field, so "2035" and "20.35" both become 20:35.
  $(id).addEventListener("blur", () => fromInputs(0));
  $(id).addEventListener("change", () => fromInputs(0));
}
// Refreshing a list you are already reading should not blank it and drop you
// back at the top of the page; the rows stay until the new ones arrive.
const refreshBest = () => { bestLoaded = null; loadBest(bestRows.length > 0); };
$("bGo").onclick = refreshBest;
$("bStickyGo").onclick = refreshBest;
$("bStickyWhat").onclick = () => $("bFilters").scrollIntoView({ behavior: "smooth", block: "start" });

/* A range that runs up to now is a range that changes while you look at it —
 * you have just come off the track and your lap is not on the board yet. */
const REFRESH_EVERY = 30000;

function autoRefreshes() {
  const r = apiRange();
  return !!(r.ok && view.tab === "best" && !view.heat && r.endsAfter >= nowWall());
}

setInterval(() => {
  if (document.hidden || !state.rscId || !autoRefreshes()) return;
  if (Date.now() - bestAt < REFRESH_EVERY) return;
  loadBest(true);
}, 5000);

// The filters are a screenful on a phone, so once they are scrolled away a
// compact bar carries the two things you still need: what you are looking at,
// and a way to refresh it.
if ("IntersectionObserver" in window) {
  new IntersectionObserver(
    ([e]) => show($("bSticky"), !e.isIntersecting && view.tab === "best" && !view.heat),
    { threshold: 0 },
  ).observe($("bFilters"));
}

/* -------------------------------- heat -------------------------------
 *
 * A heat is a view of its own, not a rearrangement of the leaderboard's
 * filters. The old version rewrote the date range in the "best times" tab and
 * offered a bespoke "back to range" button, which left you on a tab you had
 * not asked for, with a back button that did not go back where you came from.
 * Now the heat is a URL of its own on top of whatever you were doing, and
 * "back" is the browser's own — from the driver page it returns to the driver
 * page, results and all. */
const HEAT_ZOOM = 6;

let heatLoaded = null, heatRows = [];

function openHeat(at, who) {
  if (!wall(at)) return;
  view.heat = at;
  view.who = who || "";
  pushedHeat = true;
  commit(true);
}

const paintHeat = () => renderList($("hList"), heatRows, { focus: view.who, plainWhen: true });

async function loadHeat() {
  const t = wall(view.heat);
  if (!t) return;
  const a = addMin(t, -HEAT_ZOOM), b = addMin(t, HEAT_ZOOM);
  $("hTitle").textContent = "Jízda " + hhmm(t);
  $("hSub").textContent = czDay(view.heat) + " · okno " + hhmm(a) + "–" + hhmm(b);
  const sig = view.heat + "|" + view.scg;
  if (heatLoaded === sig) return paintHeat();
  show($("hErr"), false);
  $("hList").innerHTML = '<div class="empty">Načítám…</div>';
  try {
    const rows = await query({ from: stamp(a), to: stamp(b), max: 200 });
    if (view.heat + "|" + view.scg !== sig) return;
    heatLoaded = sig; heatRows = rows;
    paintHeat();
  } catch (e) {
    $("hList").innerHTML = "";
    $("hErr").textContent = e.message;
    show($("hErr"), true);
  }
}

wireList($("hList"), paintHeat);

$("hBack").onclick = () => {
  // Same thing the browser's back does, so the two cannot disagree. A heat
  // opened from a pasted link has nothing behind it, so it closes in place.
  if (pushedHeat) history.back();
  else { view.heat = ""; view.who = ""; commit(false); }
};

/* ---------------------------- driver hunt ---------------------------- */

$("dSize").innerHTML = SIZES.map(([v, l]) =>
  `<button class="chip" data-s="${v}" data-on="${v === SIZE_DEFAULT ? 1 : 0}">${esc(l)}</button>`).join("");
$("dSize").onclick = (e) => {
  const b = e.target.closest("[data-s]"); if (!b) return;
  view.sz = b.dataset.s;
  commit(false);
};
$("dName").addEventListener("input", updateDriverControls);
for (const id of ["dFrom", "dTo", "dName"]) {
  $(id).addEventListener("change", () => {
    view.q = $("dName").value; view.df = $("dFrom").value; view.dt = $("dTo").value;
    commit(false);
  });
}

/* The coarse-to-fine scan.
 *
 * Asking about every nine minutes of every day is how you find the individual
 * heats, and it is also ninety-odd requests per day spent almost entirely on
 * windows where the name never appears. So the scan narrows instead:
 *
 *   1. one request per day
 *   2. for the days the name turns up in, one request per three-hour block
 *   3. nine-minute windows over the hot blocks, padded generously
 *
 * Nothing is lost by narrowing. The API answers a window with each
 * participant's best time inside it, so a driver who turned a single lap
 * anywhere in a block appears in that block's answer — a block is either hot
 * or provably empty. Every hot block is then tiled in full, plus an hour of
 * slack on each side, plus half an hour around every timestamp already found.
 * The slack is what makes it safe: heats sit near block edges, and the day and
 * block passes both cover the whole 24 hours rather than the opening hours, so
 * a session outside them is still found. Only the final tiling is bounded by
 * what the coarse passes actually turned up. */
const PROBE_BLOCK = 180;
const PROBE_PAD = 60;
const SEED_PAD = 30;
const FINE_CAP = 1500;

function dayBlocks(dayIso) {
  const d = wallDay(dayIso), out = [];
  for (let m = 0; m < 24 * 60; m += PROBE_BLOCK) out.push(winOf(addMin(d, m), addMin(d, Math.min(m + PROBE_BLOCK, 24 * 60))));
  return out;
}

function mergeRanges(rs) {
  const sorted = rs.filter((r) => r.a && r.b).sort((x, y) => x.a - y.a);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.a <= last.b) last.b = new Date(Math.max(+last.b, +r.b));
    else out.push({ a: new Date(+r.a), b: new Date(+r.b) });
  }
  return out;
}

function tile(regions, minutes) {
  const out = [];
  for (const r of regions)
    for (let t = new Date(+r.a); t < r.b; t = addMin(t, minutes))
      out.push(winOf(t, addMin(t, minutes)));
  return out;
}

let scanRun = 0;
let dFound = [];

function idleScanButton() {
  $("dGo").dataset.running = "0";
  $("dGo").classList.remove("quiet");
  $("dGo").textContent = "Projet";
}

// What the scan is doing is the scan's business; the button says how far it has
// got while it runs, and that is the whole of what anybody wanted to know.
function updateDriverControls() {
  show($("dClear"), !!$("dName").value.trim());
}

/* Several names cost the same as one.
 *
 * A window is fetched whole and filtered here, so asking "was anybody from my
 * group out?" is the same request as asking about one person — the needles just
 * grow. What does grow is the hot region the coarse passes turn up, since a
 * block is hot if anyone in the group was in it; that is the honest cost of the
 * question and it is still far under a flat grid. */
const needlesFrom = (text) => [...new Set(
  String(text || "").split(",").map((n) => norm(n).toLowerCase()).filter(Boolean))];

const matches = (name, needles) => {
  const n = norm(name).toLowerCase();
  return needles.some((x) => n.includes(x));
};

$("dGroup").onclick = () => {
  const names = [...favs().values()].sort((a, b) => a.localeCompare(b, "cs"));
  if (!names.length) return;
  $("dName").value = names.join(", ");
  view.q = $("dName").value;
  commit(false);
};

$("dClear").onclick = () => { $("dName").value = ""; view.q = ""; commit(false); };

$("dGo").onclick = async () => {
  // Second click while running means stop. Bumping the id makes the live
  // loop bail on its next check, so no two scans can ever share the list.
  if ($("dGo").dataset.running === "1") { scanRun++; idleScanButton(); return; }

  const needles = needlesFrom($("dName").value);
  show($("dErr"), false);
  const fail = (m) => { $("dErr").textContent = m; show($("dErr"), true); };
  if (!needles.length) return fail("Napiš aspoň část jména.");
  const a = wallDay($("dFrom").value), b = wallDay($("dTo").value);
  if (!a || !b) return fail("Doplň oba dny.");
  if (a > b) return fail("„Do“ je dřív než „Od“. Prohoď je.");

  const run = ++scanRun;
  const alive = () => run === scanRun;
  $("dGo").dataset.running = "1";
  $("dGo").classList.add("quiet");
  $("dTrend").innerHTML = "";
  $("dList").innerHTML = "";

  const found = dFound = [];
  const seen = new Set();   // windows overlap by design now, so drop repeats
  const seeds = [];
  let failed = 0;

  scanNeedles = needles;
  const paint = () => paintDriver();

  const hit = (r) => {
    const k = norm(r.participant) + "|" + r.date + "|" + r.score;
    if (seen.has(k)) return false;
    seen.add(k);
    found.push({ ...r, secs: toSeconds(r.score) });
    const t = wall(r.date);
    if (t) seeds.push(t);
    return true;
  };

  // One pass over a set of windows: collects matches and reports back which
  // windows contained any, so the next pass knows where to look closer.
  async function probe(wins) {
    const hot = [];
    await pool(wins, async (w) => {
      if (!alive()) return;
      let recs;
      try { recs = await query({ from: w.from, to: w.to, max: 2000 }); }
      catch { failed++; return; }
      if (!alive()) return;
      let added = 0, any = false;
      for (const r of recs) {
        if (!matches(r.participant, needles)) continue;
        any = true;
        if (hit(r)) added++;
      }
      if (any) hot.push(w);
      $("dGo").textContent = `Zastavit — nalezeno ${found.length}`;
      // Only repaint when something actually changed, otherwise it flickers.
      if (added) paint();
    });
    return hot;
  }

  try {
    if (view.sz !== "heat") {
      const wins = buckets($("dFrom").value, $("dTo").value, view.sz);
      if (wins.length > FINE_CAP) throw new Error("Moc dlouhý rozsah. Zkrať ho, nebo zvol Po týdnech či Po měsících.");
      await probe(wins);
    } else {
      const hotDays = await probe(dayWindows($("dFrom").value, $("dTo").value));
      if (!alive()) return;

      const hotBlocks = hotDays.length
        ? await probe(hotDays.flatMap((d) => dayBlocks(d.day)))
        : [];
      if (!alive()) return;

      const regions = mergeRanges([
        ...hotBlocks.map((w) => ({ a: addMin(w.a, -PROBE_PAD), b: addMin(w.b, PROBE_PAD) })),
        ...seeds.map((t) => ({ a: addMin(t, -SEED_PAD), b: addMin(t, SEED_PAD) })),
      ]);
      const fine = tile(regions, HEAT_MINUTES);
      if (fine.length > FINE_CAP) throw new Error("Moc dlouhý rozsah. Zkrať ho, nebo zvol Po týdnech či Po měsících.");
      if (fine.length) await probe(fine);
    }

    if (!alive()) return;

    trend($("dTrend"), found.filter((f) => f.secs != null));
    if (!found.length)
      $("dList").innerHTML = '<div class="empty">Nic. Jména jsou přezdívky z registrace, zkus kratší kus.</div>';
    else paint();
    if (failed) fail("Část dat se nepodařilo načíst, zbytek je níž.");
  } catch (e) {
    if (alive()) fail(e.message);
  } finally {
    if (alive()) idleScanButton();
  }
};

/* Who gets which colour, fixed by the order you asked about them rather than by
 * who happens to be quickest today — a colour that moves when the standings do
 * is a colour that tells you nothing. */
let scanNeedles = [];

function seriesOrder(rows) {
  const names = [...new Set(rows.map((r) => norm(r.participant)))];
  const rank = (n) => {
    const i = scanNeedles.findIndex((x) => n.toLowerCase().includes(x));
    return i < 0 ? scanNeedles.length : i;
  };
  return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, "cs"));
}

const colorOf = (order) => (name) => {
  const i = order.indexOf(norm(name));
  return i >= 0 && i < SERIES.length ? SERIES[i] : "";
};

function paintDriver() {
  const rows = [...dFound].sort((x, y) => (x.secs ?? 1e9) - (y.secs ?? 1e9));
  const order = seriesOrder(rows);
  renderList($("dList"), rows, {
    renumber: true,
    colorOf: order.length > 1 ? colorOf(order) : null,
  });
}

wireList($("dList"), paintDriver);

/* ------------------------------- trend -------------------------------
 *
 * Points are evenly spaced by session rather than by date: the question is
 * "am I getting quicker", and a three-month gap drawn to scale would squash
 * everything worth reading into the right-hand edge. With a group on the chart
 * the x position is the session's place in the merged list of everybody's
 * sessions, which keeps the even spacing and still lines the drivers up against
 * each other. The axes say what the numbers are — a line with no scale on it is
 * decoration. */
const CH = { w: 340, h: 150, l: 40, r: 10, t: 12, b: 22 };

/* Validated against this page's surface for the dark lightness band, the chroma
 * floor, protan/deutan separation and contrast — not chosen by eye. Fixed
 * order, never cycled: a seventh driver does not get an invented hue, it stays
 * in the list below the chart. */
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300"];
const MAX_SERIES = SERIES.length;

function trend(el, pts) {
  $("dLegend").innerHTML = "";
  if (pts.length < 2) { el.innerHTML = ""; return; }

  const order = seriesOrder(pts);
  const shown = order.slice(0, MAX_SERIES);
  const multi = order.length > 1;
  const rows = pts.filter((p) => !multi || shown.includes(norm(p.participant)));
  if (rows.length < 2) { el.innerHTML = ""; return; }

  // One x per session across everybody, so two drivers in the same heat sit in
  // the same column instead of drifting apart by session count.
  const times = [...new Set(rows.map((p) => +wall(p.date)))].sort((a, b) => a - b);
  const secs = rows.map((p) => p.secs);
  const lo = Math.min(...secs), hi = Math.max(...secs);
  // A flat set of times would otherwise divide by zero and draw on the axis.
  const span = hi - lo || Math.max(0.5, lo * 0.01);
  const top = hi + span * 0.12, bottom = lo - span * 0.12;
  const span_x = Math.max(1, times.length - 1);
  const x = (t) => CH.l + (times.indexOf(+wall(t)) / span_x) * (CH.w - CH.l - CH.r);
  const y = (v) => CH.t + ((top - v) / (top - bottom)) * (CH.h - CH.t - CH.b);

  const ticks = [lo, (lo + hi) / 2, hi];
  const grid = ticks.map((v) => `
    <line x1="${CH.l}" y1="${y(v).toFixed(1)}" x2="${CH.w - CH.r}" y2="${y(v).toFixed(1)}"
      stroke="var(--line)" stroke-width="1"/>
    <text x="${CH.l - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v.toFixed(3)}</text>`).join("");

  // Three date labels at most: the ends always, the middle when it fits.
  const at = times.length > 3 ? [0, Math.floor(span_x / 2), times.length - 1] : [0, times.length - 1];
  const dates = [...new Set(at)].map((i) => {
    const d = new Date(times[i]);
    const anchor = i === 0 ? "start" : i === times.length - 1 ? "end" : "middle";
    const px = CH.l + (i / span_x) * (CH.w - CH.l - CH.r);
    return `<text x="${px.toFixed(1)}" y="${CH.h - 6}" text-anchor="${anchor}">${d.getUTCDate()}.${d.getUTCMonth() + 1}.</text>`;
  }).join("");

  const paint = colorOf(order);
  const best = Math.min(...rows.map((p) => p.secs));
  const series = (multi ? shown : [order[0]]).map((name, i) => {
    const mine = rows.filter((p) => norm(p.participant) === name)
      .sort((a, b) => wall(a.date) - wall(b.date));
    if (!mine.length) return "";
    const stroke = multi ? paint(name) : "var(--accent)";
    const path = mine.map((p, j) => (j ? "L" : "M") + x(p.date).toFixed(1) + "," + y(p.secs).toFixed(1)).join(" ");
    const last = mine[mine.length - 1];
    // Direct labels while there is room for them, so identity is never colour
    // alone; past four the legend carries it.
    const label = multi && shown.length <= 4
      ? `<text class="tip" x="${(x(last.date) - 4).toFixed(1)}" y="${(y(last.secs) - 7).toFixed(1)}"
           text-anchor="end">${esc(name)}</text>` : "";
    return `<path d="${path}" fill="none" stroke="${stroke}" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>
      ${mine.map((p) => `<circle cx="${x(p.date).toFixed(1)}" cy="${y(p.secs).toFixed(1)}" r="3"
         fill="${!multi && p.secs === best ? "var(--gold)" : stroke}"
         stroke="var(--bg)" stroke-width="2"/>`).join("")}
      ${label}`;
  }).join("");

  const taps = rows.map((p) => `<circle class="tap" cx="${x(p.date).toFixed(1)}" cy="${y(p.secs).toFixed(1)}"
     r="11" fill="transparent" data-at="${esc(p.date)}" data-who="${esc(norm(p.participant))}"
     ><title>${esc(norm(p.participant))} · ${esc(czDate(p.date))} · ${esc(p.score)}</title></circle>`).join("");

  el.innerHTML = `<svg viewBox="0 0 ${CH.w} ${CH.h}" preserveAspectRatio="xMidYMid meet" role="img"
      aria-label="Vývoj časů, nejlepší ${best.toFixed(3)} s">
    <g class="axis">${grid}${dates}</g>
    <line x1="${CH.l}" y1="${CH.t}" x2="${CH.l}" y2="${CH.h - CH.b}" stroke="var(--line)"/>
    ${series}${taps}
  </svg>`;

  // A legend whenever there is more than one line; a single line is named by
  // the field you typed it into.
  $("dLegend").innerHTML = multi
    ? shown.map((n) => `<span class="legend-item"><span class="swatch" style="background:${paint(n)}"></span>${esc(n)}</span>`).join("")
      + (order.length > shown.length
        ? `<span class="legend-item more">+${order.length - shown.length} dalších v seznamu níž</span>` : "")
    : "";
}

// The points are the same doorway into a heat as a timestamp in a list.
$("dTrend").addEventListener("click", (e) => {
  const c = e.target.closest("[data-at]");
  if (c) openHeat(c.dataset.at, c.dataset.who);
});

/* -------------------------------- live ------------------------------- */

/* The feed speaks in single letters and the module's own settings translate
 * them: translationAverage, translationBest, translationLast, translationGap
 * and so on come back from livetiming/settings alongside the socket details.
 * So these are read off the source, not guessed:
 *
 *   session   N name · C milliseconds left · L laps left · S/E running or not
 *   driver    P position · N name · K kart · L laps · B best · T last · A average · G gap
 */

// 67889 -> "1:07.889", 43010 -> "43.010"
function lap(ms) {
  // Zero is "no lap yet", not a lap of no time: at the start of a heat every
  // driver has one and a column of 0.000 says nothing.
  if (!ms) return "—";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(3);
  return Math.floor(s / 60) + ":" + (s % 60).toFixed(3).padStart(6, "0");
}

// "01.043" -> "+1.043", "" -> "" (the leader has no gap)
const gap = (g) => (g ? "+" + String(g).replace(/^0+(?=\d)/, "") : "");

function clock(ms) {
  if (ms == null || ms < 0) return "—";
  const t = Math.floor(ms / 1000);
  return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0");
}

function renderLive(d, ended) {
  // The feed's own order is not a promise. Position is a field, so sort by it
  // and the tower cannot be wrong even if a push arrives out of order.
  const drivers = (Array.isArray(d.D) ? [...d.D] : [])
    .sort((a, b) => (a.P ?? 1e9) - (b.P ?? 1e9));
  const running = !ended && d.S === 1 && drivers.length > 0;

  $("lHead").dataset.live = running ? "1" : "0";
  $("lName").textContent = d.N || "Jízda";
  // Laps-limited heats count laps, timed ones count down; show whichever the
  // heat is actually being run to.
  $("lClock").textContent = d.L > 0 ? d.L + " kol" : clock(d.C);
  $("lSub").textContent = [
    drivers.length ? drivers.length + " na trati" : "",
    running ? "" : "dojeto",
  ].filter(Boolean).join(" · ");
  show($("lHead"), true);
  show($("lTableWrap"), true);

  const set = favs();
  // The quickest lap anybody has done in this heat, which is what makes a time
  // purple rather than merely green.
  const fastest = Math.min(...drivers.map((r) => r.B || Infinity));
  if (!ended) alertOnPurple(drivers, fastest, set, d.N);

  $("lList").innerHTML = drivers.map((r) => {
    /* Timing-screen colours, as everybody expects them — and applied to the
     * lap that just happened, never to the running best: a tower colours the
     * event, not the record book.
     *   purple  quickest lap of the heat, by anyone
     *   green   that driver's own best
     *   yellow  an ordinary lap
     * Only from the second lap on. A first lap is always its driver's best,
     * and painting the whole field green at the green light says nothing. */
    const mark = !r.T || r.L < 2 ? ""
      : r.T === fastest ? "purple"
      : r.T === r.B ? "green"
      : "yellow";
    const name = norm(r.N);
    /* Always, whenever the feed sends one.
     *
     * This used to hide the badge when the name ended with the kart number, on
     * the theory that "Jezdec 8" in kart 8 would print the 8 twice. But a
     * public session is a field of Jezdec 1..8 mostly sitting in the kart of
     * the same number, so the rule blanked nearly every row and left a badge
     * only on the two drivers whose kart happened not to match their name. In
     * a column headed Kart, an empty cell reads as "the feed did not say",
     * which is a worse lie than repeating a digit. */
    const badge = r.K ? `<span class="kart">${esc(r.K)}</span>` : "";
    const on = isFav(set, name);
    return `<tr data-mark="${mark}" data-fav="${on ? 1 : 0}" data-alert="${alerting(name) ? 1 : 0}">
      <td class="c-pos"><span class="poscell">
        <button class="star" data-fav="${esc(name)}" data-on="${on ? 1 : 0}"
          aria-pressed="${on}" title="Oblíbený">${on ? "★" : "☆"}</button>${esc(r.P ?? "")}
      </span></td>
      <td class="c-kart">${badge}</td>
      <td class="c-who">${esc(name)}</td>
      <td class="c-time last">${lap(r.T)}</td>
      <td class="c-time">${lap(r.B)}</td>
      <td class="c-gap">${esc(gap(r.G))}</td>
      <td class="c-laps">${esc(r.L ?? 0)}</td>
    </tr>`;
  }).join("");
}

/* Somebody in your group has just gone quickest in the heat. You are holding
 * the phone at the fence, not reading it, so the row lights up and — where the
 * browser has it — the phone buzzes. Once per lap, never for a lap already
 * announced. */
const ALERT = { at: new Map(), heat: "" };
const ALERT_MS = 6000;

const alerting = (name) => Date.now() - (ALERT.at.get(favKey(name)) || 0) < ALERT_MS;

function alertOnPurple(drivers, fastest, set, heatName) {
  // A new heat is a clean slate: the same lap time again is news again.
  if (heatName && heatName !== ALERT.heat) { ALERT.heat = heatName; ALERT.at.clear(); ALERT.seen = new Map(); }
  ALERT.seen ||= new Map();
  for (const r of drivers) {
    const name = norm(r.N);
    if (!r.T || r.L < 2 || r.T !== fastest || !isFav(set, name)) continue;
    const k = favKey(name);
    if (ALERT.seen.get(k) === r.T) continue;
    ALERT.seen.set(k, r.T);
    ALERT.at.set(k, Date.now());
    // Absent on iOS and refused by browsers without a prior interaction — the
    // row lighting up is the signal that always lands, the buzz is a bonus.
    try { navigator.vibrate?.([40, 60, 40]); } catch { /* not supported */ }
    // Repaint once the highlight has expired, so it clears on a quiet feed too.
    setTimeout(() => LIVE.shown && renderLive(LIVE.shown.data, LIVE.shown.ended), ALERT_MS + 100);
  }
}

$("lList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-fav]");
  if (!b) return;
  toggleFav(b.dataset.fav);
  if (LIVE.shown) renderLive(LIVE.shown.data, LIVE.shown.ended);
});

/* A socket that is only ever opened once is a socket that is open until the
 * first tunnel, then silently dead with a stale heat on screen. Wanting the
 * feed and having it are separate things: `want` survives a drop, the socket
 * does not, and everything in between is retries. */
const LIVE = { sock: null, want: false, tries: 0, timer: null, settings: null,
  last: null, shown: null, msgs: 0, seenAt: 0, watch: null, raw: null };

const BACKOFF = [1000, 2000, 4000, 8000, 15000];
// Long enough that a quiet track is not mistaken for a dead socket, short
// enough that a phone coming back from a tunnel does not sit there stale.
const SILENCE = 120000;

function liveNote(text, bad) {
  $("lNote").textContent = text || "";
  $("lNote").className = "note" + (bad ? " bad" : "");
  show($("lNote"), !!text);
}

function liveButton() {
  const open = LIVE.sock && LIVE.sock.readyState === 1;
  $("lGo").textContent = !LIVE.want ? "Připojit" : open ? "Odpojit" : "Připojuji…";
  $("lGo").classList.toggle("quiet", LIVE.want);
}

function liveStop() {
  LIVE.want = false;
  clearTimeout(LIVE.timer); LIVE.timer = null;
  clearInterval(LIVE.watch); LIVE.watch = null;
  const s = LIVE.sock; LIVE.sock = null;
  if (s) { s.onclose = null; try { s.close(); } catch { /* already gone */ } }
  dropScreen();
  liveNote("");
  liveButton();
}

function liveRetry() {
  clearTimeout(LIVE.timer);
  const wait = BACKOFF[Math.min(LIVE.tries++, BACKOFF.length - 1)];
  liveNote(`Spojení přerušeno. Obnovuji za ${Math.round(wait / 1000)} s…`, true);
  LIVE.timer = setTimeout(liveConnect, wait);
  liveButton();
}

async function liveConnect() {
  if (!LIVE.want || LIVE.sock) return;
  try {
    const conn = await token();
    LIVE.settings ||= await api(conn, "livetiming/settings", { locale: "cs", styleId: "", resourceId: state.rscId });
    if (!LIVE.want) return;
    const s = LIVE.settings;
    const ws = new WebSocket(`wss://${s.liveServerHost}:${s.liveServerWssPort}`);
    LIVE.sock = ws;
    liveButton();
    ws.onopen = () => {
      LIVE.tries = 0; LIVE.seenAt = Date.now();
      liveNote(""); liveButton();
      ws.send("START " + s.liveServerKey);
      holdScreen();
      clearInterval(LIVE.watch);
      // A socket the network dropped without telling us looks exactly like a
      // socket with nothing to say, until you notice it has said nothing for
      // two minutes after saying plenty.
      LIVE.watch = setInterval(() => {
        if (LIVE.sock === ws && LIVE.msgs > 1 && Date.now() - LIVE.seenAt > SILENCE) {
          try { ws.close(); } catch { /* already gone */ }
        }
      }, 10000);
    };
    ws.onmessage = (e) => { LIVE.seenAt = Date.now(); LIVE.msgs++; onLiveMessage(e.data); };
    ws.onerror = () => { /* a close always follows, and that is where retry lives */ };
    ws.onclose = () => {
      if (LIVE.sock !== ws) return;
      LIVE.sock = null;
      clearInterval(LIVE.watch); LIVE.watch = null;
      if (LIVE.want) liveRetry(); else liveButton();
    };
  } catch (e) {
    LIVE.settings = null; LIVE.sock = null;
    if (!LIVE.want) return liveButton();
    liveNote(e.message, true);
    liveRetry();
  }
}

function onLiveMessage(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { msg = { _text: String(raw) }; }
  // Not every message carries the session block — many are the driver array
  // and a couple of counters. Merging keeps the heat name and the clock on
  // screen instead of blanking them between updates.
  const data = state.live = { ...(state.live || {}), ...msg };
  LIVE.raw = msg;
  // Formatting a debug dump nobody is looking at, forty times a heat.
  if (!$("lDump").classList.contains("hide")) $("lDump").textContent = JSON.stringify(msg, null, 2);
  show($("lRaw"), true);

  const live = Array.isArray(data.D) && data.D.length;
  if (live) {
    LIVE.last = data;
    liveNote("");
    LIVE.shown = { data, ended: false };
    renderLive(data, false);
    return;
  }
  // The heat ending is the moment everybody wants to read the result, which is
  // exactly when the old version cleared the table.
  if (LIVE.last) {
    // Their own Czech for this is "Žádné závody běžecké" — a machine that read
    // "running" as jogging. Ours instead.
    liveNote("Zrovna nikdo nejede. Níž je poslední dojetá jízda.");
    LIVE.shown = { data: LIVE.last, ended: true };
    renderLive(LIVE.last, true);
  } else {
    liveNote("Zrovna nikdo nejede.");
    LIVE.shown = null;
    show($("lHead"), false); show($("lTableWrap"), false);
    $("lList").innerHTML = "";
  }
}

/* The screen going dark halfway through a heat is the single most annoying
 * thing about watching timing on a phone. The lock is only grantable while the
 * page is visible and it is dropped the moment it is not, so it is taken when
 * the feed comes up and taken again every time you come back to the tab. */
let wakeLock = null;

async function holdScreen() {
  if (!("wakeLock" in navigator) || wakeLock || document.hidden || !LIVE.want) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch { wakeLock = null; }   // refused: low battery, policy, or no support
}

function dropScreen() {
  const w = wakeLock;
  wakeLock = null;
  if (w) w.release().catch(() => { /* already gone */ });
}

$("lGo").onclick = () => {
  if (LIVE.want) { LIVE.optedOut = true; return liveStop(); }
  LIVE.optedOut = false;
  LIVE.want = true; LIVE.tries = 0;
  liveButton();
  liveConnect();
};

// A backgrounded tab on a phone loses its socket without an event anybody can
// rely on, so coming back is its own reason to check.
addEventListener("visibilitychange", () => {
  if (document.hidden || !LIVE.want) return;
  holdScreen();                       // the lock does not survive being hidden
  if (LIVE.sock) return;
  clearTimeout(LIVE.timer); LIVE.tries = 0; liveConnect();
});
addEventListener("online", () => {
  if (!LIVE.want || LIVE.sock) return;
  clearTimeout(LIVE.timer); LIVE.tries = 0; liveConnect();
});

$("lRaw").onclick = () => {
  const on = $("lDump").classList.contains("hide");
  if (on) $("lDump").textContent = JSON.stringify(LIVE.raw, null, 2);
  show($("lDump"), on);
  $("lRaw").textContent = on ? "Skrýt surová data" : "Ukázat surová data";
};

/* -------------------------------- key -------------------------------- */

/* The hint tells people to fish the key out of a link, so the field takes the
 * link as well, and says which half of "clientKey:guid" is missing rather than
 * letting the handshake fail with a number. */
function parseKey(raw) {
  let s = String(raw || "").trim();
  const m = s.match(/[?&]key=([^&#\s]+)/);
  if (m) { try { s = decodeURIComponent(m[1]); } catch { s = m[1]; } }
  s = s.replace(/\s+/g, "");
  if (!s) return { err: "Vlož odkaz na modul." };
  let decoded;
  try { decoded = atob(s); } catch { return { err: "Tomuhle nerozumím — vlož odkaz na modul." }; }
  if (!/^[^:]+:[0-9a-f-]{8,}$/i.test(decoded))
    return { err: "Tohle není platný klíč." };
  return { key: s };
}

$("keyToggle").onclick = () => {
  const on = $("keyPanel").classList.contains("hide");
  show($("keyPanel"), on);
  if (on) show($("groupPanel"), false);
};

function useKey(raw) {
  const r = parseKey(raw);
  if (r.err) { $("keyErr").textContent = r.err; return show($("keyErr"), true); }
  show($("keyErr"), false);
  state.key = r.key;
  // Otherwise a different track lasts exactly until the page reloads.
  try {
    if (r.key === DEFAULT_KEY) localStorage.removeItem(KEY_STORE);
    else localStorage.setItem(KEY_STORE, r.key);
  } catch { /* private mode */ }
  show($("keyPanel"), false);
  bestRows = []; bestLoaded = null; heatLoaded = null;
  $("bList").innerHTML = "";
  liveStop(); LIVE.settings = null; LIVE.last = null; LIVE.shown = null; state.live = null;
  writeUrl(false);
  boot();
}

$("keyApply").onclick = () => useKey($("keyInput").value);
$("keyReset").onclick = () => { $("keyInput").value = DEFAULT_KEY; useKey(DEFAULT_KEY); };
$("bootRetry").onclick = () => boot();

$("tabs").onclick = (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  view.tab = b.dataset.tab;
  commit(false);
};

/* ------------------------------- sharing ----------------------------- */

/* Every view is already a URL, so sharing one is mostly a matter of handing it
 * over. navigator.share is the good path on a phone; the clipboard is the
 * fallback; showing the thing is the last resort, because a share button that
 * silently does nothing is worse than no button. */
let toastTimer = null;

function toast(text) {
  let el = $("toast");
  if (!el) {
    // Purely transient, owned by nothing, gone in three seconds — it would only
    // ever be empty markup in the document.
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.on = "1";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.dataset.on = "0"; }, 3000);
}

async function shareThis(title, url) {
  if (navigator.share) {
    try { await navigator.share({ title, url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }   // they changed their mind
  }
  try { await navigator.clipboard.writeText(url); return toast("Odkaz zkopírován."); }
  catch { /* no clipboard permission, or no clipboard */ }
  toast(url);
}

$("bShare").onclick = () => shareThis("Praga Timing", location.href);
$("hShare").onclick = () => shareThis("Jízda " + $("hTitle").textContent, location.href);

/* ------------------------------ installing ---------------------------- */

/* The shell is cached so the page opens at the track without waiting on a
 * signal, and so a deploy can never pair a new app.js with a stale style.css.
 * Secure context only, which on GitHub Pages means always. */
if ("serviceWorker" in navigator && window.isSecureContext) {
  addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").then((reg) => {
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener("statechange", () => {
          // A worker that installs while another already controls the page is a
          // new version waiting, not a first install.
          if (sw.state === "installed" && navigator.serviceWorker.controller)
            toast("Nová verze je stažená — projeví se po obnovení.");
        });
      });
    }).catch(() => { /* unregistered, blocked, or a file:// open */ });
  });
}

/* ------------------------------- wiring ------------------------------ */

importFavs();
renderFavPanel();
readUrl();
writeUrl(false);
applyView();
boot();
