// ── Settings ──────────────────────────────────────────────
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get("pagewise_config", data =>
      resolve(data.pagewise_config || { backend: "ollama" }));
  });
}

// ── AI: getSummary ────────────────────────────────────────
async function getSummary(text) {
  if (!text || text.trim().length < 20) return "⚠️ Not enough text on this page to summarize.";
  const config = await getSettings();
  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Summarize into bullet points for exam revision. Each bullet starts with •\n\n${text.slice(0, 3000)}` }],
          max_tokens: 1000
        })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch { return "❌ Groq API call failed."; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/summarize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      return data.summary;
    } catch { return "❌ Ollama server not running."; }
  }
}

// ── AI: getKeywords ───────────────────────────────────────
async function getKeywords(text) {
  if (!text || text.trim().length < 20) return [];
  const config = await getSettings();
  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [{ role: "user", content: `Extract 8 keywords. Return ONLY a JSON array. Example: ["word1","word2"]\n\n${text.slice(0, 1500)}` }],
          max_tokens: 100
        })
      });
      const data = await res.json();
      const raw = data.choices[0].message.content;
      const match = raw.match(/\[.*?\]/s);
      return match ? JSON.parse(match[0]) : [];
    } catch { return []; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/keywords`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      const data = await res.json();
      return data.keywords || [];
    } catch { return []; }
  }
}

// ── App State ─────────────────────────────────────────────
const summaryCache = {};
const textCache    = {};
const chatHistory  = {};
let tabs        = [];
let activeTabId = null;
let isLight     = false;

// ── Highlight State ───────────────────────────────────────
let highlights    = {};         // { pdfKey: [{ id, page, color, rect, note }] }
let hlMode        = false;      // are we in highlight mode?
let selectedColor = "yellow";
let isDragging    = false;
let dragStart     = null;       // { x, y } in canvas coords
let dragEnd       = null;

// ── DOM refs ──────────────────────────────────────────────
const statusEl    = document.getElementById("status");
const canvas      = document.getElementById("pdf-canvas");
const hlCanvas    = document.getElementById("highlight-canvas");
const dragCanvas  = document.getElementById("drag-canvas");
const ctx         = canvas.getContext("2d");
const hlCtx       = hlCanvas.getContext("2d");
const dragCtx     = dragCanvas.getContext("2d");
const summaryBox  = document.getElementById("summary-box");
const pageInfo    = document.getElementById("page-info");
const loader      = document.getElementById("loader");
const summScroll  = document.getElementById("summary-scroll");
const cacheTag    = document.getElementById("cache-tag");
const pageSlider  = document.getElementById("page-slider");
const kwWrap      = document.getElementById("keywords-wrap");
const pageFlash   = document.getElementById("page-flash");
const tabsWrap    = document.getElementById("tabs-wrap");
const canvasWrap  = document.getElementById("canvas-wrap");
const hlActionBar = document.getElementById("hl-action-bar");
const hlModeBtn   = document.getElementById("hl-mode-btn");

pdfjsLib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";

// ── Panel switching ───────────────────────────────────────
document.querySelectorAll(".panel-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("panel-" + btn.dataset.panel).classList.add("active");
  });
});

// ── Theme ─────────────────────────────────────────────────
document.getElementById("theme-btn").addEventListener("click", () => {
  isLight = !isLight;
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  document.getElementById("theme-btn").textContent = isLight ? "🌑" : "🌙";
  redrawHighlights();
});

// ══════════════════════════════════════════════════════════
// HIGHLIGHT MODE
// ══════════════════════════════════════════════════════════

// Enter / exit highlight mode
hlModeBtn.addEventListener("click", () => {
  hlMode = true;
  hlActionBar.classList.remove("hidden");
  hlModeBtn.style.background = "var(--accent)";
  hlModeBtn.style.color = "#fff";
  hlModeBtn.style.borderColor = "var(--accent)";
  canvasWrap.classList.add("hl-mode");
  dragCanvas.style.pointerEvents = "auto";
  statusEl.textContent = "✏ Highlight mode ON — drag over text to highlight";
});

document.getElementById("hl-done-btn").addEventListener("click", exitHlMode);

function exitHlMode() {
  hlMode = false;
  hlActionBar.classList.add("hidden");
  hlModeBtn.style.background = "";
  hlModeBtn.style.color = "";
  hlModeBtn.style.borderColor = "";
  canvasWrap.classList.remove("hl-mode");
  dragCanvas.style.pointerEvents = "none";
  dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
  isDragging = false;
  dragStart = null;
  dragEnd   = null;
  const tab = activeTab();
  if (tab) statusEl.textContent = `✅ Page ${tab.currentPage} of ${tab.pdfDoc?.numPages}`;
}

// Color picker in action bar
document.querySelectorAll(".hl-color-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".hl-color-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedColor = btn.dataset.color;
  });
});

// ── Get mouse position relative to canvas ────────────────
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  // Scale mouse coords to canvas pixel space
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top)  * scaleY
  };
}

// ── Drag events on dragCanvas ─────────────────────────────
dragCanvas.addEventListener("mousedown", e => {
  if (!hlMode) return;
  e.preventDefault();
  isDragging = true;
  dragStart  = getCanvasPos(e);
  dragEnd    = { ...dragStart };
});

dragCanvas.addEventListener("mousemove", e => {
  if (!hlMode || !isDragging) return;
  dragEnd = getCanvasPos(e);
  drawDragRect();
});

dragCanvas.addEventListener("mouseup", e => {
  if (!hlMode || !isDragging) return;
  isDragging = false;
  dragEnd = getCanvasPos(e);

  const rect = normalizeRect(dragStart, dragEnd);

  // Only save if drag area is meaningful (not just a click)
  if (rect.w < 5 || rect.h < 5) {
    dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
    dragStart = null; dragEnd = null;
    return;
  }

  saveHighlightRect(rect);
  dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
  dragStart = null; dragEnd = null;
});

dragCanvas.addEventListener("mouseleave", e => {
  if (!hlMode || !isDragging) return;
  isDragging = false;
  dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
});

// Draw live preview rect while dragging
function drawDragRect() {
  dragCtx.clearRect(0, 0, dragCanvas.width, dragCanvas.height);
  if (!dragStart || !dragEnd) return;

  const rect = normalizeRect(dragStart, dragEnd);
  const colorMap = {
    yellow: "rgba(247,201,72,0.35)",
    green:  "rgba(74,222,128,0.3)",
    blue:   "rgba(79,195,247,0.3)",
    pink:   "rgba(248,113,113,0.3)"
  };
  const borderMap = {
    yellow: "rgba(247,201,72,0.9)",
    green:  "rgba(74,222,128,0.9)",
    blue:   "rgba(79,195,247,0.9)",
    pink:   "rgba(248,113,113,0.9)"
  };

  dragCtx.fillStyle   = colorMap[selectedColor];
  dragCtx.strokeStyle = borderMap[selectedColor];
  dragCtx.lineWidth   = 1.5;

  dragCtx.beginPath();
  dragCtx.rect(rect.x, rect.y, rect.w, rect.h);
  dragCtx.fill();
  dragCtx.stroke();
}

// Normalize rect so x/y is always top-left
function normalizeRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y)
  };
}

// Save the dragged rect as a highlight
function saveHighlightRect(rect) {
  const tab = activeTab();
  if (!tab) return;
  const key = getPdfKey();
  if (!highlights[key]) highlights[key] = [];

  // Extract text under the rect from PDF text items
  const note = extractTextFromRect(rect, tab.id, tab.currentPage);

  const hl = {
    id:    Date.now().toString(),
    page:  tab.currentPage,
    color: selectedColor,
    rect,
    note: note || `Highlighted area (page ${tab.currentPage})`
  };

  highlights[key].push(hl);
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();

  statusEl.textContent = `✅ Highlight saved!`;
  setTimeout(() => {
    if (hlMode) statusEl.textContent = "✏ Highlight mode ON — drag over text to highlight";
  }, 1500);
}

// Extract text items that fall within a canvas rect
function extractTextFromRect(rect, tabId, pageNum) {
  const items = textItemsCache[tabId]?.[pageNum];
  if (!items) return "";

  const matched = items.filter(item => {
    // item has { x, y, w, h, str } in canvas pixel coords
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    return cx >= rect.x && cx <= rect.x + rect.w &&
           cy >= rect.y && cy <= rect.y + rect.h;
  });

  return matched.map(i => i.str).join(" ").trim();
}

// ── Text items cache (for text extraction under rects) ────
const textItemsCache = {}; // { tabId: { pageNum: [{x,y,w,h,str}] } }

function cacheTextItems(textContent, viewport, tabId, pageNum) {
  if (!textItemsCache[tabId]) textItemsCache[tabId] = {};
  const canvasHeight = viewport.height;

  textItemsCache[tabId][pageNum] = textContent.items
    .filter(item => item.str.trim())
    .map(item => {
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const x  = tx[4];
      const y  = canvasHeight - tx[5];
      const h  = Math.abs(tx[3]);
      const w  = item.width * viewport.scale;
      return { x, y: y - h, w, h, str: item.str };
    });
}

// ── Draw saved highlights on hlCanvas ────────────────────
function redrawHighlights() {
  const tab = activeTab();
  if (!tab) return;
  hlCtx.clearRect(0, 0, hlCanvas.width, hlCanvas.height);

  const key = getPdfKey();
  if (!key || !highlights[key]) return;

  const colorMap = {
    yellow: "rgba(247,201,72,0.45)",
    green:  "rgba(74,222,128,0.4)",
    blue:   "rgba(79,195,247,0.4)",
    pink:   "rgba(248,113,113,0.4)"
  };

  highlights[key]
    .filter(h => h.page === tab.currentPage)
    .forEach(hl => {
      hlCtx.fillStyle = colorMap[hl.color] || colorMap.yellow;
      const r = hl.rect;
      hlCtx.beginPath();
      if (hlCtx.roundRect) hlCtx.roundRect(r.x, r.y, r.w, r.h, 3);
      else hlCtx.rect(r.x, r.y, r.w, r.h);
      hlCtx.fill();
    });
}

// ── Highlights list panel ─────────────────────────────────
function renderHighlightsList() {
  const hlList = document.getElementById("hl-list");
  const key = getPdfKey();
  const hls = (key && highlights[key]) ? highlights[key] : [];

  if (!hls.length) {
    hlList.innerHTML = `<div class="hl-empty"><div class="ei">🖊</div><div>No highlights yet.<br>Click 🖊 Highlight in toolbar,<br>then drag over PDF text.</div></div>`;
    return;
  }

  hlList.innerHTML = "";
  [...hls].sort((a, b) => a.page - b.page).forEach(hl => {
    const item = document.createElement("div");
    item.className = "hl-item";
    item.innerHTML = `
      <div class="hl-item-header">
        <div class="hl-item-dot dot-${hl.color}"></div>
        <span class="hl-item-page">Page ${hl.page}</span>
        <button class="hl-item-delete" data-id="${hl.id}">✕</button>
      </div>
      <div class="hl-item-text">${hl.note || "Highlighted region"}</div>
    `;
    item.querySelector(".hl-item-text").addEventListener("click", () => {
      renderPage(hl.page);
      document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
      document.querySelector("[data-panel='summary']").classList.add("active");
      document.getElementById("panel-summary").classList.add("active");
    });
    item.querySelector(".hl-item-delete").addEventListener("click", () => deleteHighlight(hl.id));
    hlList.appendChild(item);
  });
}

function deleteHighlight(id) {
  const key = getPdfKey();
  if (!key) return;
  highlights[key] = highlights[key].filter(h => h.id !== id);
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();
}

function updateHighlightCount() {
  const key   = getPdfKey();
  const count = (key && highlights[key]) ? highlights[key].length : 0;
  document.getElementById("hl-count-badge").textContent  = `${count} saved`;
  document.getElementById("hl-tab-count").textContent    = count > 0 ? `${count} ` : "";
}

function saveHighlights() {
  chrome.storage.local.set({ pagewise_highlights: highlights });
}

async function loadHighlights() {
  return new Promise(resolve => {
    chrome.storage.local.get("pagewise_highlights", data => {
      highlights = data.pagewise_highlights || {};
      resolve();
    });
  });
}

// ── Export highlights ─────────────────────────────────────
document.getElementById("hl-export-btn").addEventListener("click", () => {
  const key = getPdfKey();
  const hls = (key && highlights[key]) ? highlights[key] : [];
  if (!hls.length) { alert("No highlights to export."); return; }

  let out = `PageWise AI — Highlights\n${key}\n${"=".repeat(40)}\n\n`;
  const byPage = {};
  hls.forEach(h => { if (!byPage[h.page]) byPage[h.page] = []; byPage[h.page].push(h); });
  Object.keys(byPage).sort((a,b)=>a-b).forEach(pg => {
    out += `PAGE ${pg}\n${"-".repeat(20)}\n`;
    byPage[pg].forEach(h => { out += `[${h.color.toUpperCase()}] ${h.note}\n`; });
    out += "\n";
  });

  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([out], { type: "text/plain" })),
    download: "pagewise-highlights.txt"
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("hl-clear-btn").addEventListener("click", () => {
  const key = getPdfKey();
  if (!key) return;
  if (!confirm("Clear all highlights for this PDF?")) return;
  highlights[key] = [];
  saveHighlights();
  redrawHighlights();
  renderHighlightsList();
  updateHighlightCount();
});

// ══════════════════════════════════════════════════════════
// PDF LOADING & RENDERING
// ══════════════════════════════════════════════════════════

function createTab(url) {
  const id    = Date.now().toString();
  const label = decodeURIComponent(url.split("/").pop() || "PDF").slice(0, 24);
  tabs.push({ id, label, url, pdfDoc: null, currentPage: 1 });
  summaryCache[id] = {};
  textCache[id]    = {};
  chatHistory[id]  = [];
  renderTabs();
  switchTab(id);
}

function renderTabs() {
  tabsWrap.innerHTML = "";
  tabs.forEach(tab => {
    const el = document.createElement("div");
    el.className = "tab" + (tab.id === activeTabId ? " active" : "");
    el.innerHTML = `<span class="tab-name" title="${tab.label}">📄 ${tab.label}</span><span class="tab-x" data-id="${tab.id}">✕</span>`;
    el.addEventListener("click", e => { if (!e.target.classList.contains("tab-x")) switchTab(tab.id); });
    el.querySelector(".tab-x").addEventListener("click", e => { e.stopPropagation(); closeTab(tab.id); });
    tabsWrap.appendChild(el);
  });
}

function switchTab(id) {
  activeTabId = id;
  renderTabs();
  const tab = tabs.find(t => t.id === id);
  if (!tab) return;
  renderChatHistory(id);
  renderHighlightsList();
  updateHighlightCount();
  if (tab.pdfDoc) {
    pageSlider.max   = tab.pdfDoc.numPages;
    pageSlider.value = tab.currentPage;
    renderPage(tab.currentPage);
  } else {
    loadPDF(tab.url, id);
  }
}

function closeTab(id) {
  tabs = tabs.filter(t => t.id !== id);
  delete summaryCache[id];
  delete textCache[id];
  delete chatHistory[id];
  if (tabs.length === 0) {
    statusEl.textContent = "No PDFs open.";
    canvas.width = 0; canvas.height = 0;
    hlCanvas.width = 0; hlCanvas.height = 0;
    dragCanvas.width = 0; dragCanvas.height = 0;
    summaryBox.innerHTML = "";
    kwWrap.innerHTML = "";
    activeTabId = null;
    renderTabs();
    return;
  }
  switchTab(tabs[tabs.length - 1].id);
}

function activeTab() { return tabs.find(t => t.id === activeTabId); }
function getPdfKey() {
  const tab = activeTab();
  if (!tab) return null;
  return decodeURIComponent(tab.url.split("/").pop() || tab.url);
}

async function loadPDF(url, tabId) {
  statusEl.textContent = "📄 Loading PDF...";
  showLoader();
  try {
    const pdf = await pdfjsLib.getDocument(url).promise;
    const tab = tabs.find(t => t.id === tabId);
    if (!tab) return;
    tab.pdfDoc = pdf;
    pageSlider.max   = pdf.numPages;
    pageSlider.value = 1;
    statusEl.textContent = `✅ Loaded — ${pdf.numPages} pages`;
    renderPage(1);
  } catch (err) {
    statusEl.textContent = "❌ Error loading PDF: " + err.message;
    hideLoader();
  }
}

async function renderPage(pageNum) {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;

  tab.currentPage = pageNum;
  flashPage();
  statusEl.textContent = `📄 Rendering page ${pageNum}...`;
  pageInfo.textContent  = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value      = pageNum;

  document.getElementById("prev-page").disabled = pageNum <= 1;
  document.getElementById("next-page").disabled = pageNum >= tab.pdfDoc.numPages;

  try {
    const page     = await tab.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });

    canvas.height    = viewport.height;
    canvas.width     = viewport.width;
    hlCanvas.height  = viewport.height;
    hlCanvas.width   = viewport.width;
    dragCanvas.height = viewport.height;
    dragCanvas.width  = viewport.width;

    // dragCanvas pointer events only active in hl mode
    dragCanvas.style.pointerEvents = hlMode ? "auto" : "none";

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Extract and cache text content
    const textContent = await page.getTextContent();
    const pageText    = textContent.items.map(i => i.str).join(" ");
    textCache[tab.id][pageNum] = pageText;

    // Cache text item positions for text extraction under highlights
    cacheTextItems(textContent, viewport, tab.id, pageNum);

    statusEl.textContent = hlMode
      ? "✏ Highlight mode ON — drag over text to highlight"
      : `✅ Page ${pageNum} of ${tab.pdfDoc.numPages}`;

    redrawHighlights();

    if (summaryCache[tab.id][pageNum]) {
      showSummary(summaryCache[tab.id][pageNum], true);
    } else {
      showLoader();
      const [summary, keywords] = await Promise.all([getSummary(pageText), getKeywords(pageText)]);
      summaryCache[tab.id][pageNum] = summary;
      showSummary(summary, false);
      renderKeywords(keywords);
    }
  } catch (err) {
    console.error(err);
    statusEl.textContent = "❌ " + err.message;
    hideLoader();
  }
}

// ── Summary helpers ───────────────────────────────────────
function showLoader() {
  loader.classList.add("active");
  summScroll.style.display = "none";
  cacheTag.style.display   = "none";
}
function hideLoader() { loader.classList.remove("active"); }

function showSummary(text, fromCache) {
  hideLoader();
  summScroll.style.display = "block";
  cacheTag.style.display   = fromCache ? "inline" : "none";
  renderHighlighted(text);
}

function renderHighlighted(text) {
  summaryBox.innerHTML = "";
  text.split("\n").forEach((line, i) => {
    const span    = document.createElement("span");
    const trimmed = line.trim();
    span.className = (trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*") || /^\d+\./.test(trimmed))
      ? "hl-line" : "pl-line";
    span.style.animationDelay = `${i * 35}ms`;
    span.textContent = line || "\u00A0";
    summaryBox.appendChild(span);
  });
}

function renderKeywords(keywords) {
  kwWrap.innerHTML = "";
  (keywords || []).forEach(word => {
    const tag = document.createElement("span");
    tag.className   = "kw-tag";
    tag.textContent = word;
    kwWrap.appendChild(tag);
  });
}

function flashPage() {
  pageFlash.classList.add("flash");
  setTimeout(() => pageFlash.classList.remove("flash"), 180);
}

// ── Navigation ────────────────────────────────────────────
document.getElementById("prev-page").addEventListener("click", () => {
  const tab = activeTab();
  if (tab && tab.currentPage > 1) renderPage(tab.currentPage - 1);
});
document.getElementById("next-page").addEventListener("click", () => {
  const tab = activeTab();
  if (tab && tab.pdfDoc && tab.currentPage < tab.pdfDoc.numPages) renderPage(tab.currentPage + 1);
});
pageSlider.addEventListener("input", () => {
  const tab = activeTab();
  const val = parseInt(pageSlider.value);
  if (tab && val !== tab.currentPage) renderPage(val);
});

// ── Copy ──────────────────────────────────────────────────
document.getElementById("copy-btn").addEventListener("click", () => {
  navigator.clipboard.writeText(summaryBox.innerText).then(() => {
    const btn = document.getElementById("copy-btn");
    btn.textContent = "✅ Copied!";
    setTimeout(() => btn.textContent = "📋 Copy Summary", 2000);
  });
});

// ── Export summaries ──────────────────────────────────────
function buildExportText(tabId) {
  const cache = summaryCache[tabId] || {};
  if (!Object.keys(cache).length) return null;
  let out = "PageWise AI — Summaries\n" + "=".repeat(40) + "\n\n";
  Object.keys(cache).sort((a,b)=>a-b).forEach(pg => {
    out += `PAGE ${pg}\n${"-".repeat(20)}\n${cache[pg]}\n\n`;
  });
  return out;
}

document.getElementById("export-btn").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  const text = buildExportText(tab.id);
  if (!text) { alert("Navigate some pages first."); return; }
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], { type: "text/plain" })),
    download: "pagewise-summary.txt"
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Summarize All ─────────────────────────────────────────
document.getElementById("summarize-all-btn").addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;
  const modal = document.getElementById("all-pages-modal");
  const body  = document.getElementById("all-pages-body");
  modal.classList.add("open");
  body.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:30px">⏳ Processing ${tab.pdfDoc.numPages} pages...</div>`;
  const results = {};
  for (let pg = 1; pg <= tab.pdfDoc.numPages; pg++) {
    if (summaryCache[tab.id][pg]) {
      results[pg] = summaryCache[tab.id][pg];
    } else {
      const page = await tab.pdfDoc.getPage(pg);
      const tc   = await page.getTextContent();
      const text = tc.items.map(i => i.str).join(" ");
      textCache[tab.id][pg]    = text;
      const summary = await getSummary(text);
      summaryCache[tab.id][pg] = summary;
      results[pg] = summary;
    }
    body.innerHTML = "";
    Object.keys(results).sort((a,b)=>a-b).forEach(p => {
      const block = document.createElement("div");
      block.className = "page-block";
      block.innerHTML = `<div class="page-block-h">PAGE ${p}</div><div class="page-block-b">${results[p]}</div>`;
      body.appendChild(block);
    });
    if (pg < tab.pdfDoc.numPages) {
      const prog = Object.assign(document.createElement("div"), {
        style: "color:var(--text-muted);font-size:11.5px;text-align:center;padding:8px",
        textContent: `Processing page ${pg+1} of ${tab.pdfDoc.numPages}...`
      });
      body.appendChild(prog);
    }
  }
});

document.getElementById("export-all-btn").addEventListener("click", () => {
  const tab = activeTab();
  if (!tab) return;
  const text = buildExportText(tab.id);
  if (!text) return;
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([text], {type:"text/plain"})),
    download: "pagewise-all-summaries.txt"
  });
  a.click();
});

["close-all-modal","close-all-modal2"].forEach(id =>
  document.getElementById(id).addEventListener("click", () =>
    document.getElementById("all-pages-modal").classList.remove("open")));

// ── Add PDF modal ─────────────────────────────────────────
document.getElementById("add-tab-btn").addEventListener("click", () => {
  document.getElementById("add-pdf-modal").classList.add("open");
  document.getElementById("new-pdf-url").value = "";
  setTimeout(() => document.getElementById("new-pdf-url").focus(), 100);
});
document.getElementById("close-add-modal").addEventListener("click", () =>
  document.getElementById("add-pdf-modal").classList.remove("open"));
document.getElementById("open-new-pdf").addEventListener("click", () => {
  const url = document.getElementById("new-pdf-url").value.trim();
  if (!url) { alert("Please enter a PDF URL."); return; }
  document.getElementById("add-pdf-modal").classList.remove("open");
  createTab(url);
});
document.getElementById("new-pdf-url").addEventListener("keydown", e => {
  if (e.key === "Enter") document.getElementById("open-new-pdf").click();
});

// ── Chat ──────────────────────────────────────────────────
async function askChat(question, context) {
  const config = await getSettings();
  const tab = activeTab();
  if (!tab) return "No PDF loaded.";
  if (config.backend === "groq") {
    try {
      const history  = chatHistory[tab.id] || [];
      const messages = [
        { role: "system", content: `Answer based ONLY on this page:\n\n${context.slice(0, 2000)}` },
        ...history.map(h => ([{ role: "user", content: h.user }, { role: "assistant", content: h.assistant }])).flat(),
        { role: "user", content: question }
      ];
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.groqModel || "llama-3.1-8b-instant", messages, max_tokens: 500 })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch { return "❌ Groq chat failed."; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, context, history: chatHistory[tab.id] || [] }) });
      const data = await res.json();
      return data.answer;
    } catch { return "❌ Ollama server not running."; }
  }
}

function renderChatHistory(tabId) {
  const msgs = document.getElementById("chat-messages");
  const hist = chatHistory[tabId] || [];
  if (!hist.length) {
    msgs.innerHTML = `<div class="chat-empty"><div class="ei">💬</div><div>Ask anything about this page.<br>AI answers from the page content.</div></div>`;
    return;
  }
  msgs.innerHTML = "";
  hist.forEach(h => { appendBubble("user", h.user); appendBubble("ai", h.assistant); });
}

function appendBubble(role, text) {
  const msgs = document.getElementById("chat-messages");
  const empty = msgs.querySelector(".chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = "bubble " + role;
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

document.getElementById("chat-send").addEventListener("click", sendChat);
document.getElementById("chat-input").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});

async function sendChat() {
  const input = document.getElementById("chat-input");
  const send  = document.getElementById("chat-send");
  const question = input.value.trim();
  if (!question) return;
  const tab = activeTab();
  if (!tab) return;
  const context = textCache[tab.id]?.[tab.currentPage] || "";
  input.value = "";
  send.disabled = true;
  appendBubble("user", question);
  const thinking = appendBubble("thinking", "⏳ thinking...");
  const answer = await askChat(question, context);
  thinking.remove();
  appendBubble("ai", answer);
  chatHistory[tab.id].push({ user: question, assistant: answer });
  send.disabled = false;
}

// ── Init ──────────────────────────────────────────────────
async function init() {
  await loadHighlights();
  const params  = new URLSearchParams(window.location.search);
  const fileUrl = params.get("file");
  if (fileUrl) createTab(fileUrl);
  else statusEl.textContent = "❌ No PDF URL found.";
}

init();