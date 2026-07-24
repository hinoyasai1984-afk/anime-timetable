// 地上波(関東)+BSの主要チャンネル。しょぼいカレンダーのChIDに対応。
const WHITELIST_CH_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 13, 14, 19, 72, 100, 15, 16, 17, 18, 71, 128, 129, 179, 197, 285];
const STORAGE_KEY = "anime-timetable-checked-v1";
const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];
const API_BASE = "https://cal.syoboi.jp/json.php";

const state = { shows: [], checked: new Set(), dayFilter: "all" };

const els = {
  headerSubtitle: document.getElementById("header-subtitle"),
  dayFilter: document.getElementById("day-filter"),
  updateButton: document.getElementById("update-button"),
  status: document.getElementById("status-line"),
  showList: document.getElementById("show-list"),
  themeToggle: document.getElementById("theme-toggle"),
};

// ---- JSONP (しょぼいカレンダーのAPIはCORS非対応のため script タグ経由で取得) ----

let jsonpCounter = 0;
function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cbName = `__syoboiCb${jsonpCounter++}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("タイムアウトしました"));
    }, 15000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      script.remove();
    }
    window[cbName] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("データの取得に失敗しました"));
    };
    script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cbName}`;
    document.head.appendChild(script);
  });
}

// ---- 日付ユーティリティ(JST基準) ----

function jstDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jstWeekdayIdx(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0=日 .. 6=土
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtMD(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function jstInfo(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    dateStr,
    month: Number(get("month")),
    day: Number(get("day")),
    hour: get("hour"),
    minute: get("minute"),
    weekdayIdx: jstWeekdayIdx(dateStr),
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- データ取得 ----

async function fetchTitles(tids) {
  const map = {};
  const chunkSize = 60;
  for (let i = 0; i < tids.length; i += chunkSize) {
    const chunk = tids.slice(i, i + chunkSize);
    const data = await jsonp(`${API_BASE}?Req=TitleMedium&TID=${chunk.join(",")}`);
    const titles = Array.isArray(data) ? {} : data.Titles || {};
    Object.assign(map, titles);
  }
  return map;
}

function groupByTitle(programs, titleMap) {
  const byTid = new Map();
  programs.forEach((p) => {
    if (!byTid.has(p.TID)) byTid.set(p.TID, []);
    byTid.get(p.TID).push(p);
  });
  const shows = [];
  byTid.forEach((slots, tid) => {
    slots.sort((a, b) => Number(a.StTime) - Number(b.StTime));
    const title = (titleMap[tid] && titleMap[tid].Title) || `(不明な作品 TID:${tid})`;
    shows.push({ tid, title, slots, firstStTime: Number(slots[0].StTime) });
  });
  shows.sort((a, b) => a.firstStTime - b.firstStTime);
  return shows;
}

async function loadTimetable() {
  els.status.textContent = "番組表を取得中…";
  els.showList.innerHTML = "";
  try {
    const today = jstDateParts();
    const dow = jstWeekdayIdx(today);
    const daysUntilSunday = dow === 0 ? 0 : 7 - dow;
    const sunday = addDays(today, daysUntilSunday);
    const fetchDays = Math.min(32, daysUntilSunday + 2);

    const todayLabel = `${fmtMD(today)}(${WEEKDAY_JA[dow]})`;
    const sundayLabel = `${fmtMD(sunday)}(日)`;
    els.headerSubtitle.textContent =
      dow === 0
        ? `本日 ${todayLabel} の放送予定。地上波(関東)とBSの主要チャンネルが対象です。`
        : `${todayLabel}〜${sundayLabel}の放送予定。地上波(関東)とBSの主要チャンネルが対象です。`;

    const chidParam = WHITELIST_CH_IDS.join(",");
    const progData = await jsonp(`${API_BASE}?Req=ProgramByDate&Start=${today}&Days=${fetchDays}&ChID=${chidParam}`);
    const rawPrograms = Array.isArray(progData) ? [] : Object.values(progData.Programs || {});

    const programs = rawPrograms
      .map((p) => ({ ...p, ...jstInfo(Number(p.StTime)) }))
      .filter((p) => p.dateStr <= sunday);

    if (programs.length === 0) {
      state.shows = [];
      renderEmpty();
      els.dayFilter.innerHTML = "";
      els.status.textContent = `最終更新: ${new Date().toLocaleString("ja-JP")}`;
      return;
    }

    const tids = Array.from(new Set(programs.map((p) => p.TID)));
    const titleMap = await fetchTitles(tids);

    state.shows = groupByTitle(programs, titleMap);
    loadCheckedFromStorage();
    sortShowsByChecked();
    buildDayFilter();
    renderList();
    els.status.textContent = `対象 ${state.shows.length}作品 / ${programs.length}件の放送　最終更新: ${new Date().toLocaleString("ja-JP")}`;
  } catch (err) {
    els.status.textContent = `取得に失敗しました: ${err.message}`;
  }
}

// ---- チェック状態 ----

function loadCheckedFromStorage() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    state.checked = new Set(saved);
  } catch {
    state.checked = new Set();
  }
}

function saveChecked() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.checked)));
}

function sortShowsByChecked() {
  state.shows.sort((a, b) => {
    const aC = state.checked.has(a.tid) ? 0 : 1;
    const bC = state.checked.has(b.tid) ? 0 : 1;
    if (aC !== bC) return aC - bC;
    return a.firstStTime - b.firstStTime;
  });
}

// ---- 描画 ----

function buildDayFilter() {
  const daySet = new Set();
  state.shows.forEach((s) => s.slots.forEach((slot) => daySet.add(slot.dateStr)));
  const days = Array.from(daySet).sort();

  els.dayFilter.innerHTML = "";
  els.dayFilter.appendChild(makeDayChip("all", "すべて"));
  days.forEach((d) => {
    const idx = jstWeekdayIdx(d);
    els.dayFilter.appendChild(makeDayChip(d, `${fmtMD(d)}(${WEEKDAY_JA[idx]})`));
  });
  updateDayChipSelection();
}

function makeDayChip(value, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "day-chip";
  btn.dataset.value = value;
  btn.textContent = label;
  btn.addEventListener("click", () => {
    state.dayFilter = value;
    updateDayChipSelection();
    renderList();
  });
  return btn;
}

function updateDayChipSelection() {
  els.dayFilter.querySelectorAll(".day-chip").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.value === state.dayFilter);
  });
}

function renderEmpty() {
  els.showList.innerHTML = `<div class="empty-state">対象チャンネルの番組データがまだ見つかりませんでした。<br>しょぼいカレンダー側の登録状況によっては、放送が近づくと表示されるようになります。</div>`;
}

function renderList() {
  const filtered =
    state.dayFilter === "all"
      ? state.shows
      : state.shows.filter((s) => s.slots.some((slot) => slot.dateStr === state.dayFilter));

  els.showList.innerHTML = "";
  if (filtered.length === 0) {
    renderEmpty();
    return;
  }

  filtered.forEach((show) => {
    const isChecked = state.checked.has(show.tid);
    const card = document.createElement("div");
    card.className = "show-card" + (isChecked ? " is-checked" : "");

    const slotHtml = show.slots
      .map((slot) => {
        const ep = slot.Count ? `第${slot.Count}話` : slot.SubTitle2 || "";
        return `<span class="slot-chip"><span class="slot-time">${slot.month}/${slot.day}(${WEEKDAY_JA[slot.weekdayIdx]}) ${slot.hour}:${slot.minute}</span> ${escapeHtml(slot.ChName)}${ep ? ` <span class="slot-ep">${escapeHtml(ep)}</span>` : ""}</span>`;
      })
      .join("");

    card.innerHTML = `
      <label class="show-check">
        <input type="checkbox" ${isChecked ? "checked" : ""} data-tid="${show.tid}" />
      </label>
      <div class="show-body">
        <h3 class="show-title">${escapeHtml(show.title)}</h3>
        <div class="slot-list">${slotHtml}</div>
      </div>
    `;
    card.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.checked.add(show.tid);
      else state.checked.delete(show.tid);
      card.classList.toggle("is-checked", e.target.checked);
      saveChecked();
    });
    els.showList.appendChild(card);
  });
}

// ---- イベント ----

els.updateButton.addEventListener("click", () => {
  sortShowsByChecked();
  renderList();
});

els.themeToggle.addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  if (current === "dark") root.setAttribute("data-theme", "light");
  else if (current === "light") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", "dark");
});

loadTimetable();
