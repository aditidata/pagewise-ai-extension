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
  hlModeBtn.style.background  = "var(--accent)";
  hlModeBtn.style.color       = "#fff";
  hlModeBtn.style.borderColor = "var(--accent)";
  document.querySelectorAll(".drag-overlay").forEach(d => {
    d.style.pointerEvents = "auto";
    d.style.cursor = "crosshair";
  });
  statusEl.textContent = "✏ Highlight mode ON — drag over text to highlight";
});

document.getElementById("hl-done-btn").addEventListener("click", exitHlMode);

function exitHlMode() {
  hlMode = false;
  hlActionBar.classList.add("hidden");
  hlModeBtn.style.background  = "";
  hlModeBtn.style.color       = "";
  hlModeBtn.style.borderColor = "";
  document.querySelectorAll(".drag-overlay").forEach(d => {
    d.style.pointerEvents = "none";
    d.style.cursor        = "";
    d.getContext("2d").clearRect(0, 0, d.width, d.height);
  });
  isDragging = false;
  const tab = activeTab();
  if (tab) statusEl.textContent = `✅ ${tab.pdfDoc?.numPages} pages loaded`;
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
// Uses overlap detection instead of center-point — catches partial words at edges
function extractTextFromRect(rect, tabId, pageNum) {
  const items = textItemsCache[tabId]?.[pageNum];
  if (!items) return "";

  // Expand rect slightly to catch items at boundaries
  const pad = 4;
  const rx1 = rect.x - pad, ry1 = rect.y - pad;
  const rx2 = rect.x + rect.w + pad, ry2 = rect.y + rect.h + pad;

  const matched = items.filter(item => {
    // Check if item rect overlaps with selection rect
    const ix1 = item.x, iy1 = item.y;
    const ix2 = item.x + item.w, iy2 = item.y + item.h;
    return ix1 < rx2 && ix2 > rx1 && iy1 < ry2 && iy2 > ry1;
  });

  // Sort by y (line) then x (reading order)
  matched.sort((a, b) => {
    const lineDiff = Math.round(a.y / 8) - Math.round(b.y / 8);
    return lineDiff !== 0 ? lineDiff : a.x - b.x;
  });

  return matched.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
}

// ── RAG State ─────────────────────────────────────────────
let ragMode     = false;  // false = this page, true = full-PDF RAG
let ragIndexing = {};     // { tabId: true } while indexing

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
const colorMap = {
  yellow: "rgba(247,201,72,0.45)",
  green:  "rgba(74,222,128,0.4)",
  blue:   "rgba(79,195,247,0.4)",
  pink:   "rgba(248,113,113,0.4)"
};

function drawHighlightOnCanvas(hlc, hl) {
  const hctx = hlc.getContext("2d");
  hctx.fillStyle = colorMap[hl.color] || colorMap.yellow;
  const r = hl.rect;
  hctx.beginPath();
  if (hctx.roundRect) hctx.roundRect(r.x, r.y, r.w, r.h, 3);
  else hctx.rect(r.x, r.y, r.w, r.h);
  hctx.fill();
}

function redrawHighlights() {
  const key = getPdfKey();
  if (!key || !highlights[key]) return;

  // Group by page
  const byPage = {};
  highlights[key].forEach(hl => {
    if (!byPage[hl.page]) byPage[hl.page] = [];
    byPage[hl.page].push(hl);
  });

  // Draw on each page's hl canvas
  Object.entries(byPage).forEach(([pg, hls]) => {
    const block = document.getElementById(`page-block-${pg}`);
    if (!block) return;
    const hlc  = block.querySelector(".hl-overlay");
    if (!hlc) return;
    const hctx = hlc.getContext("2d");
    hctx.clearRect(0, 0, hlc.width, hlc.height);
    hls.forEach(hl => drawHighlightOnCanvas(hlc, hl));
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

    // Color map for the text background
    const bgMap = {
      yellow: "rgba(247,201,72,0.22)",
      green:  "rgba(74,222,128,0.18)",
      blue:   "rgba(79,195,247,0.18)",
      pink:   "rgba(248,113,113,0.18)"
    };
    const borderMap = {
      yellow: "#f7c948",
      green:  "#4ade80",
      blue:   "#4fc3f7",
      pink:   "#f87171"
    };

    const hasText  = hl.note && !hl.note.startsWith("Highlighted area");
    const textHtml = hasText
      ? `<div class="hl-item-text-block" style="background:${bgMap[hl.color]};border-left:3px solid ${borderMap[hl.color]}">${hl.note}</div>`
      : `<div class="hl-item-text-block hl-item-no-text" style="border-left:3px solid ${borderMap[hl.color]}">⚠ No text extracted — image or non-selectable region</div>`;

    item.innerHTML = `
      <div class="hl-item-header">
        <div class="hl-item-dot dot-${hl.color}"></div>
        <span class="hl-item-page">Page ${hl.page}</span>
        <span class="hl-item-color-label">${hl.color}</span>
        <button class="hl-item-delete" data-id="${hl.id}">✕</button>
      </div>
      ${textHtml}
    `;

    item.querySelector(".hl-item-text-block").addEventListener("click", () => {
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
  // Load flashcard cache for this tab
  const pdfKey = getPdfKeyForTab(tab);
  loadFcCache(id, pdfKey);
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

    // Kick off background RAG indexing (non-blocking)
    indexPDFForRAG(tab);
  } catch (err) {
    statusEl.textContent = "❌ Error loading PDF: " + err.message;
    hideLoader();
  }
}

// ── RAG: extract all pages then index ─────────────────────
async function indexPDFForRAG(tab) {
  if (ragIndexing[tab.id]) return;
  ragIndexing[tab.id] = true;
  updateRagStatus("⏳ Preparing RAG index...");

  try {
    const pageTexts = {};
    // Extract text from all pages (runs alongside normal rendering)
    for (let pg = 1; pg <= tab.pdfDoc.numPages; pg++) {
      if (textCache[tab.id]?.[pg]) {
        pageTexts[pg] = textCache[tab.id][pg];
      } else {
        const page    = await tab.pdfDoc.getPage(pg);
        const tc      = await page.getTextContent();
        const text    = tc.items.map(i => i.str).join(" ");
        textCache[tab.id][pg] = text;
        pageTexts[pg] = text;
      }
    }

    // Index using RAG engine
    const pdfKey = getPdfKeyForTab(tab);
    await RAG.indexDocument(pdfKey, pageTexts);

    // Update UI
    const stats = RAG.getStats(pdfKey);
    updateRagStatus(`✅ RAG ready — ${stats?.chunks || 0} chunks indexed`);
    updateRagBadge(true);
  } catch (err) {
    console.error("RAG indexing failed:", err);
    updateRagStatus("⚠️ RAG indexing failed");
  } finally {
    ragIndexing[tab.id] = false;
  }
}

function getPdfKeyForTab(tab) {
  return decodeURIComponent(tab.url.split("/").pop() || tab.url);
}

function updateRagStatus(msg) {
  const el = document.getElementById("rag-status");
  if (el) el.textContent = msg;
}

function updateRagBadge(ready) {
  const badge = document.getElementById("rag-badge");
  if (!badge) return;
  badge.className = "rag-badge " + (ready ? "ready" : "loading");
  badge.title     = ready ? "RAG index ready — full PDF chat enabled" : "Building RAG index...";
}

async function renderPage(pageNum) {
  const tab = activeTab();
  if (!tab || !tab.pdfDoc) return;

  tab.currentPage = pageNum;
  pageInfo.textContent = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value     = pageNum;
  document.getElementById("prev-page").disabled = pageNum <= 1;
  document.getElementById("next-page").disabled = pageNum >= tab.pdfDoc.numPages;

  // If all pages already rendered, just scroll to that page
  const existing = document.getElementById(`page-block-${pageNum}`);
  if (existing) {
    existing.scrollIntoView({ behavior: "smooth", block: "start" });
    updateCurrentPageFromScroll(pageNum, tab);
    return;
  }

  // First load — render all pages
  await renderAllPages(tab);
}

async function renderAllPages(tab) {
  if (!tab || !tab.pdfDoc) return;
  const pdfPane = document.querySelector(".pdf-pane");
  pdfPane.innerHTML = ""; // clear

  const numPages = tab.pdfDoc.numPages;
  statusEl.textContent = `📄 Loading ${numPages} pages...`;

  for (let pg = 1; pg <= numPages; pg++) {
    // Page wrapper
    const block = document.createElement("div");
    block.id        = `page-block-${pg}`;
    block.className = "page-scroll-block";
    block.dataset.page = pg;

    // Page number label
    const label = document.createElement("div");
    label.className   = "page-scroll-label";
    label.textContent = `Page ${pg}`;
    block.appendChild(label);

    // Canvas wrap with 3 canvases
    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";

    const cv  = document.createElement("canvas");
    const hlc = document.createElement("canvas");
    const dgc = document.createElement("canvas");
    hlc.className = "hl-overlay";
    dgc.className = "drag-overlay";
    hlc.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    dgc.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";

    wrap.appendChild(cv);
    wrap.appendChild(hlc);
    wrap.appendChild(dgc);
    block.appendChild(wrap);
    pdfPane.appendChild(block);

    // Render page into canvas
    try {
      const page     = await tab.pdfDoc.getPage(pg);
      const paneW    = pdfPane.clientWidth - 40;
      const unscaled = page.getViewport({ scale: 1 });
      const scale    = Math.min(paneW / unscaled.width, 1.8);
      const viewport = page.getViewport({ scale });

      cv.width  = hlc.width  = dgc.width  = viewport.width;
      cv.height = hlc.height = dgc.height = viewport.height;

      await page.render({ canvasContext: cv.getContext("2d"), viewport }).promise;

      // Cache text
      const textContent = await page.getTextContent();
      const pageText    = textContent.items.map(i => i.str).join(" ");
      textCache[tab.id][pg] = pageText;
      cacheTextItems(textContent, viewport, tab.id, pg);

      // Store refs for highlights
      tab.canvases = tab.canvases || {};
      tab.canvases[pg] = { cv, hlc, dgc, viewport };

      statusEl.textContent = `📄 Rendered ${pg} / ${numPages}`;
    } catch (e) { console.error("Page render error pg", pg, e); }
  }

  statusEl.textContent = `✅ ${numPages} pages loaded — scroll to read`;

  // Draw highlights on all pages
  redrawHighlights();

  // Setup scroll observer to update current page + summary
  setupScrollObserver(tab);

  // Scroll to currentPage
  const target = document.getElementById(`page-block-${tab.currentPage}`);
  if (target) target.scrollIntoView({ block: "start" });

  // Load summary for first page
  loadSummaryForPage(tab, tab.currentPage);

  // Setup drag highlight on all pages
  setupDragOnAllPages(tab);
}

// ── Scroll observer — updates page number as user scrolls ─
function setupScrollObserver(tab) {
  const pdfPane = document.querySelector(".pdf-pane");
  const observer = new IntersectionObserver((entries) => {
    let best = null, bestRatio = 0;
    entries.forEach(e => {
      if (e.isIntersecting && e.intersectionRatio > bestRatio) {
        bestRatio = e.intersectionRatio;
        best = e.target;
      }
    });
    if (best) {
      const pg = parseInt(best.dataset.page);
      if (pg !== tab.currentPage) {
        tab.currentPage = pg;
        pageInfo.textContent = `${pg} / ${tab.pdfDoc.numPages}`;
        pageSlider.value     = pg;
        document.getElementById("prev-page").disabled = pg <= 1;
        document.getElementById("next-page").disabled = pg >= tab.pdfDoc.numPages;
        loadSummaryForPage(tab, pg);
      }
    }
  }, { root: pdfPane, threshold: [0.3, 0.6] });

  document.querySelectorAll(".page-scroll-block").forEach(b => observer.observe(b));
  tab._scrollObserver = observer;
}

function updateCurrentPageFromScroll(pageNum, tab) {
  tab.currentPage = pageNum;
  pageInfo.textContent = `${pageNum} / ${tab.pdfDoc.numPages}`;
  pageSlider.value     = pageNum;
  loadSummaryForPage(tab, pageNum);
}

async function loadSummaryForPage(tab, pg) {
  const pageText = textCache[tab.id]?.[pg];
  if (!pageText) return;
  if (summaryCache[tab.id][pg]) {
    showSummary(summaryCache[tab.id][pg], true);
    return;
  }
  showLoader();
  const [summary, keywords] = await Promise.all([getSummary(pageText), getKeywords(pageText)]);
  summaryCache[tab.id][pg] = summary;
  showSummary(summary, false);
  renderKeywords(keywords);
}

// ── Setup drag highlight events on all page canvases ──────
function setupDragOnAllPages(tab) {
  document.querySelectorAll(".page-scroll-block").forEach(block => {
    const pg  = parseInt(block.dataset.page);
    const dgc = block.querySelector(".drag-overlay");
    const hlc = block.querySelector(".hl-overlay");
    if (!dgc) return;

    let dragging = false, start = null;
    const dctx = dgc.getContext("2d");

    dgc.addEventListener("mousedown", e => {
      if (!hlMode) return;
      dragging = true;
      const r  = dgc.getBoundingClientRect();
      start    = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    dgc.addEventListener("mousemove", e => {
      if (!dragging || !hlMode) return;
      const r   = dgc.getBoundingClientRect();
      const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
      dctx.clearRect(0, 0, dgc.width, dgc.height);
      dctx.fillStyle = colorMap[selectedColor] + "55";
      dctx.fillRect(start.x, start.y, cur.x - start.x, cur.y - start.y);
    });
    dgc.addEventListener("mouseup", e => {
      if (!dragging || !hlMode) return;
      dragging = false;
      const r   = dgc.getBoundingClientRect();
      const end = { x: e.clientX - r.left, y: e.clientY - r.top };
      dctx.clearRect(0, 0, dgc.width, dgc.height);
      const rect = {
        x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
        w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y)
      };
      if (rect.w > 5 && rect.h > 5) saveHighlightRectOnPage(rect, pg, hlc, tab);
    });
    dgc.addEventListener("mouseleave", () => {
      if (dragging) { dragging = false; dctx.clearRect(0, 0, dgc.width, dgc.height); }
    });

    // Enable/disable pointer events based on hlMode
    dgc.style.pointerEvents = hlMode ? "auto" : "none";
  });
}

function saveHighlightRectOnPage(rect, pg, hlc, tab) {
  const key = getPdfKey();
  if (!highlights[key]) highlights[key] = [];
  const note = extractTextFromRect(rect, tab.id, pg);
  const hl   = { id: Date.now().toString(), page: pg, color: selectedColor, rect, note: note || `Highlighted area (page ${pg})` };
  highlights[key].push(hl);
  saveHighlights();
  drawHighlightOnCanvas(hlc, hl);
  renderHighlightsList();
  updateHighlightCount();
  statusEl.textContent = `✅ Highlight saved on page ${pg}!`;
  setTimeout(() => { statusEl.textContent = hlMode ? "✏ Highlight mode ON" : `✅ ${tab.pdfDoc.numPages} pages loaded`; }, 1500);
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
  const config  = await getSettings();
  const tab     = activeTab();
  if (!tab) return "No PDF loaded.";

  // ── RAG MODE: retrieve relevant chunks from full document ──
  if (ragMode) {
    const pdfKey = getPdfKeyForTab(tab);
    let retrieved = [];
    try {
      retrieved = await RAG.retrieve(pdfKey, question);
    } catch (e) { console.warn("RAG retrieve failed", e); }

    if (retrieved.length) {
      context = RAG.buildContext(retrieved);
      const sourcePages = RAG.getSourcePages(retrieved);
      // Tag answer with source pages after LLM responds
      tab._lastSourcePages = sourcePages;
    } else {
      // Fallback to current page if RAG failed
      context = textCache[tab.id]?.[tab.currentPage] || "";
      tab._lastSourcePages = [tab.currentPage];
    }
  } else {
    tab._lastSourcePages = [tab.currentPage];
  }

  // ── Call LLM ───────────────────────────────────────────────
  const modeNote = ragMode
    ? "Answer based on the document excerpts below. Cite page numbers when relevant."
    : "Answer based ONLY on this page text.";

  if (config.backend === "groq") {
    try {
      const history  = chatHistory[tab.id] || [];
      const messages = [
        { role: "system", content: `${modeNote}\n\n${context.slice(0, 3500)}` },
        ...history.slice(-6).map(h => ([
          { role: "user",      content: h.user      },
          { role: "assistant", content: h.assistant }
        ])).flat(),
        { role: "user", content: question }
      ];
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.groqModel || "llama-3.1-8b-instant", messages, max_tokens: 600 })
      });
      const data = await res.json();
      return data.choices[0].message.content;
    } catch { return "❌ Groq chat failed."; }
  } else {
    try {
      const url = config.ollamaUrl || "http://localhost:5000";
      const res = await fetch(`${url}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, context, history: chatHistory[tab.id] || [] })
      });
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
  const input    = document.getElementById("chat-input");
  const send     = document.getElementById("chat-send");
  const question = input.value.trim();
  if (!question) return;
  const tab = activeTab();
  if (!tab) return;
  const context = textCache[tab.id]?.[tab.currentPage] || "";
  input.value   = "";
  send.disabled = true;
  appendBubble("user", question);
  const thinking = appendBubble("thinking", "⏳ thinking...");
  const answer   = await askChat(question, context);
  thinking.remove();
  appendBubble("ai", answer);

  // Show source page citations if in RAG mode
  if (ragMode && tab._lastSourcePages?.length) {
    appendSourceCitation(tab._lastSourcePages);
  }

  chatHistory[tab.id].push({ user: question, assistant: answer });
  send.disabled = false;
}

function appendSourceCitation(pages) {
  const msgs = document.getElementById("chat-messages");
  const div  = document.createElement("div");
  div.className = "bubble-citation";
  div.innerHTML = `📄 Sources: ${pages.map(p =>
    `<span class="cite-page" data-page="${p}">p.${p}</span>`
  ).join(" ")}`;
  // Click page citation → jump to that page
  div.querySelectorAll(".cite-page").forEach(el => {
    el.addEventListener("click", () => {
      renderPage(parseInt(el.dataset.page));
      // Switch back to summary tab
      document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
      document.querySelector("[data-panel='summary']").classList.add("active");
      document.getElementById("panel-summary").classList.add("active");
    });
  });
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

// ══════════════════════════════════════════════════════════
// FLASHCARD GENERATOR
// ══════════════════════════════════════════════════════════

const flashcardCache = {}; // { tabId: { pageNum: [{q, a}] } }
let fcCards      = [];     // current deck
let fcIndex      = 0;      // current card index
let fcFlipped    = false;

// ── Generate flashcards via AI ────────────────────────────
async function generateFlashcards(text, pageNum) {
  const config = await getSettings();
  const prompt = `Generate exactly 6 flashcards from this text for exam revision.
Return ONLY a valid JSON array, no explanation, no markdown, no backticks.
Format exactly like this: [{"q":"question here","a":"answer here"},{"q":"...","a":"..."}]

Text:
${text.slice(0, 2500)}`;

  if (config.backend === "groq") {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.groqKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: config.groqModel || "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You are a flashcard generator. Always respond with ONLY a JSON array, nothing else." },
            { role: "user", content: prompt }
          ],
          max_tokens: 1000
        })
      });
      const data = await res.json();
      console.log("Groq flashcard raw:", data.choices?.[0]?.message?.content);
      return parseFlashcardJSON(data.choices[0].message.content);
    } catch (e) { console.error("Groq FC error:", e); return []; }

  } else {
    // Ollama — call the model directly via /api/generate, not the backend /chat
    try {
      const ollamaBase = (config.ollamaUrl || "http://localhost:11434").replace("localhost:5000", "localhost:11434");
      const model      = config.ollamaModel || "llama3.2:1b";

      const res = await fetch(`${ollamaBase}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          stream: false,
          options: { temperature: 0.3 }
        })
      });
      const data = await res.json();
      console.log("Ollama flashcard raw:", data.response);
      return parseFlashcardJSON(data.response);
    } catch (e) {
      console.error("Ollama FC error:", e);
      // Fallback: try via backend server
      try {
        const url = config.ollamaUrl || "http://localhost:5000";
        const res = await fetch(`${url}/summarize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: prompt })
        });
        const data = await res.json();
        console.log("Backend FC fallback raw:", data.summary);
        return parseFlashcardJSON(data.summary);
      } catch (e2) { console.error("Backend FC fallback error:", e2); return []; }
    }
  }
}

function parseFlashcardJSON(raw) {
  if (!raw) return [];

  // Strip markdown fences
  let clean = raw.replace(/```json|```/gi, "").trim();

  // Try direct parse
  try {
    const direct = JSON.parse(clean);
    if (Array.isArray(direct)) return direct.filter(c => c.q && c.a).slice(0, 8);
  } catch {}

  // Find [ ... ] block
  const start = clean.indexOf("[");
  const end   = clean.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const arr = JSON.parse(clean.slice(start, end + 1));
      if (Array.isArray(arr)) return arr.filter(c => c.q && c.a).slice(0, 8);
    } catch {}
  }

  // Regex: extract every {"q":"...","a":"..."} object individually
  const cards = [];
  const re = /\{\s*"q"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    cards.push({ q: m[1].replace(/\\"/g, '"'), a: m[2].replace(/\\"/g, '"') });
  }
  if (cards.length) return cards.slice(0, 8);

  console.error("Flashcard parse failed. Raw:", clean.slice(0, 400));
  return [];
}

// ── Trigger generation from Summary tab button ────────────
document.getElementById("generate-fc-btn")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  const pageNum = tab.currentPage;
  const text    = textCache[tab.id]?.[pageNum] || "";

  if (!text || text.trim().length < 50) {
    alert("Not enough text on this page to generate flashcards.");
    return;
  }

  // Switch to flashcards tab
  switchToPanel("flashcards");

  // Check cache first
  if (!flashcardCache[tab.id]) flashcardCache[tab.id] = {};
  if (flashcardCache[tab.id][pageNum]) {
    loadDeck(flashcardCache[tab.id][pageNum], pageNum);
    return;
  }

  // Show loader
  showFcLoader(true);

  try {
    const cards = await generateFlashcards(text, pageNum);
    if (!cards.length) {
      showFcLoader(false);
      showFcEmpty("AI couldn't generate cards.\nTry a different page.");
      return;
    }
    flashcardCache[tab.id][pageNum] = cards;
    saveFcCache();
    loadDeck(cards, pageNum);
  } catch (err) {
    console.error("FC generation error:", err);
    showFcLoader(false);
    showFcEmpty("Generation failed. Check your AI settings.");
  }
});

// ── Load a deck into the UI ───────────────────────────────
function loadDeck(cards, pageNum) {
  fcCards   = cards;
  fcIndex   = 0;
  fcFlipped = false;

  showFcLoader(false);
  document.getElementById("fc-empty").style.display  = "none";
  document.getElementById("fc-stage").style.display  = "flex";
  document.getElementById("fc-footer").style.display = "flex";

  const tab = activeTab();
  document.getElementById("fc-page-badge").textContent = `Page ${pageNum}`;
  document.getElementById("fc-count-badge").textContent = `${cards.length} cards`;
  document.getElementById("fc-tab-count").textContent   = cards.length > 0 ? `${cards.length} ` : "";

  renderFcCard();
  renderFcDots();
}

// ── Render current card ───────────────────────────────────
function renderFcCard() {
  const card = fcCards[fcIndex];
  if (!card) return;

  document.getElementById("fc-question").textContent = card.q;
  document.getElementById("fc-answer").textContent   = card.a;

  // Reset flip
  fcFlipped = false;
  document.getElementById("fc-card").classList.remove("flipped");

  // Progress
  document.getElementById("fc-progress-text").textContent = `${fcIndex + 1} / ${fcCards.length}`;
  const pct = ((fcIndex + 1) / fcCards.length) * 100;
  document.getElementById("fc-progress-bar").style.width = pct + "%";

  // Nav buttons
  document.getElementById("fc-prev").disabled = fcIndex === 0;
  document.getElementById("fc-next").disabled = fcIndex === fcCards.length - 1;

  // Dots
  document.querySelectorAll(".fc-dot").forEach((d, i) => {
    d.classList.toggle("active", i === fcIndex);
  });
}

// ── Render dot indicators ─────────────────────────────────
function renderFcDots() {
  const wrap = document.getElementById("fc-dots");
  wrap.innerHTML = "";
  fcCards.forEach((_, i) => {
    const dot = document.createElement("div");
    dot.className = "fc-dot" + (i === fcIndex ? " active" : "");
    dot.addEventListener("click", () => { fcIndex = i; renderFcCard(); });
    wrap.appendChild(dot);
  });
}

// ── Flip card on click ────────────────────────────────────
document.getElementById("fc-card")?.addEventListener("click", () => {
  fcFlipped = !fcFlipped;
  document.getElementById("fc-card").classList.toggle("flipped", fcFlipped);
});

// ── Navigation ────────────────────────────────────────────
document.getElementById("fc-prev")?.addEventListener("click", () => {
  if (fcIndex > 0) { fcIndex--; renderFcCard(); }
});
document.getElementById("fc-next")?.addEventListener("click", () => {
  if (fcIndex < fcCards.length - 1) { fcIndex++; renderFcCard(); }
});

// Keyboard navigation (← →  space)
document.addEventListener("keydown", (e) => {
  const fcPanel = document.getElementById("panel-flashcards");
  if (!fcPanel?.classList.contains("active")) return;
  if (e.key === "ArrowRight" && fcIndex < fcCards.length - 1) { fcIndex++; renderFcCard(); }
  if (e.key === "ArrowLeft"  && fcIndex > 0)                  { fcIndex--; renderFcCard(); }
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    fcFlipped = !fcFlipped;
    document.getElementById("fc-card").classList.toggle("flipped", fcFlipped);
  }
});

// ── Regenerate ────────────────────────────────────────────
document.getElementById("fc-regen-btn")?.addEventListener("click", async () => {
  const tab = activeTab();
  if (!tab) return;
  const pageNum = tab.currentPage;
  // Clear cache for this page
  if (flashcardCache[tab.id]) delete flashcardCache[tab.id][pageNum];

  document.getElementById("fc-stage").style.display  = "none";
  document.getElementById("fc-footer").style.display = "none";
  showFcLoader(true);

  try {
    const text  = textCache[tab.id]?.[pageNum] || "";
    const cards = await generateFlashcards(text, pageNum);
    if (!cards.length) { showFcLoader(false); showFcEmpty("Couldn't generate cards."); return; }
    if (!flashcardCache[tab.id]) flashcardCache[tab.id] = {};
    flashcardCache[tab.id][pageNum] = cards;
    saveFcCache();
    loadDeck(cards, pageNum);
  } catch { showFcLoader(false); showFcEmpty("Generation failed."); }
});

// ── Export to Anki-compatible .txt ────────────────────────
document.getElementById("fc-export-btn")?.addEventListener("click", () => {
  if (!fcCards.length) return;
  const tab     = activeTab();
  const pdfName = getPdfKey() || "pagewise";
  const pageNum = tab?.currentPage || "?";

  // Anki format: Q[tab]A  (importable as Basic note type)
  let out = `#separator:tab\n#html:false\n#notetype:Basic\n`;
  out    += `#deck:PageWise - ${pdfName} - Page ${pageNum}\n\n`;
  fcCards.forEach(c => { out += `${c.q}\t${c.a}\n`; });

  const a = Object.assign(document.createElement("a"), {
    href:     URL.createObjectURL(new Blob([out], { type: "text/plain" })),
    download: `pagewise-flashcards-p${pageNum}.txt`
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Helpers ───────────────────────────────────────────────
function showFcLoader(show) {
  document.getElementById("fc-loader").style.display = show ? "flex" : "none";
  if (show) {
    document.getElementById("fc-stage").style.display  = "none";
    document.getElementById("fc-footer").style.display = "none";
    document.getElementById("fc-empty").style.display  = "none";
  }
}

function showFcEmpty(msg) {
  const el = document.getElementById("fc-empty");
  el.style.display = "flex";
  el.innerHTML     = `<div class="ei">🃏</div><div>${msg.replace(/\n/g, "<br>")}</div>`;
}

function switchToPanel(name) {
  document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
  document.querySelector(`[data-panel='${name}']`).classList.add("active");
  document.getElementById(`panel-${name}`).classList.add("active");
}

// Persist flashcard cache across sessions
function saveFcCache() {
  // Store per pdfKey in chrome.storage
  const key = getPdfKey();
  if (!key) return;
  const tab = activeTab();
  if (!tab) return;
  const data = flashcardCache[tab.id] || {};
  chrome.storage.local.set({ [`fc_${key}`]: data });
}

async function loadFcCache(tabId, pdfKey) {
  return new Promise(resolve => {
    chrome.storage.local.get(`fc_${pdfKey}`, data => {
      if (data[`fc_${pdfKey}`]) flashcardCache[tabId] = data[`fc_${pdfKey}`];
      resolve();
    });
  });
}

// ══════════════════════════════════════════════════════════
// SEMANTIC SEARCH
// ══════════════════════════════════════════════════════════

let searchDebounceTimer = null;
let lastSearchQuery     = "";
let activeResultCard    = null;

// Open search panel when toolbar button clicked
document.getElementById("search-open-btn")?.addEventListener("click", () => {
  document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".panel-section").forEach(s => s.classList.remove("active"));
  document.querySelector("[data-panel='search']").classList.add("active");
  document.getElementById("panel-search").classList.add("active");
  setTimeout(() => document.getElementById("search-input")?.focus(), 80);
});

// Live search with 350ms debounce
document.getElementById("search-input")?.addEventListener("input", (e) => {
  const q = e.target.value.trim();
  const clearBtn = document.getElementById("search-clear-btn");
  if (clearBtn) clearBtn.style.display = q ? "block" : "none";

  clearTimeout(searchDebounceTimer);
  if (!q) {
    showSearchEmpty();
    lastSearchQuery = "";
    return;
  }
  // Show spinner immediately
  showSearchSpinner();
  searchDebounceTimer = setTimeout(() => runSemanticSearch(q), 350);
});

// Clear button
document.getElementById("search-clear-btn")?.addEventListener("click", () => {
  const input = document.getElementById("search-input");
  if (input) input.value = "";
  document.getElementById("search-clear-btn").style.display = "none";
  showSearchEmpty();
  lastSearchQuery = "";
});

// Also allow Enter key to search immediately
document.getElementById("search-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchDebounceTimer);
    const q = e.target.value.trim();
    if (q) runSemanticSearch(q);
  }
});

async function runSemanticSearch(query) {
  if (query === lastSearchQuery) return;
  lastSearchQuery = query;

  const tab = activeTab();
  if (!tab) { showSearchMeta("❌ No PDF loaded"); return; }

  if (!RAG.isReady()) {
    showSearchMeta("⏳ RAG engine still loading...");
    showSearchEmpty("RAG index not ready yet.\nWait for the green dot in Chat tab.");
    return;
  }

  const pdfKey = getPdfKeyForTab(tab);
  const hasIdx = await RAG.hasIndex(pdfKey);
  if (!hasIdx) {
    showSearchMeta("⏳ Indexing in progress...");
    showSearchEmpty("PDF is still being indexed.\nTry again in a moment.");
    return;
  }

  showSearchSpinner();

  try {
    // Retrieve top 6 chunks
    const retrieved = await RAG.retrieve(pdfKey, query, 6);

    if (!retrieved.length) {
      showSearchMeta("No results found");
      showSearchEmpty("No matching content found.\nTry different keywords.");
      return;
    }

    // De-duplicate by page — keep best score per page
    const byPage = {};
    retrieved.forEach(r => {
      const pg = r.chunk.page;
      if (!byPage[pg] || r.score > byPage[pg].score) byPage[pg] = r;
    });
    const deduped = Object.values(byPage).sort((a,b) => b.score - a.score);

    showSearchMeta(`${deduped.length} results for "${query.slice(0,30)}"`);
    renderSearchResults(deduped, query);
  } catch (err) {
    console.error("Search error:", err);
    showSearchMeta("❌ Search failed");
    showSearchEmpty("Search error. Check console.");
  }
}

function renderSearchResults(results, query) {
  const container = document.getElementById("search-results");
  container.innerHTML = "";
  activeResultCard = null;

  results.forEach((r, idx) => {
    const score   = Math.round(r.score * 100);
    const barW    = Math.max(score, 8);
    const excerpt = highlightQueryTerms(r.chunk.text.slice(0, 220), query);

    const card = document.createElement("div");
    card.className = "search-result-card";
    card.innerHTML = `
      <div class="src-header">
        <span class="src-page-badge">📄 Page ${r.chunk.page}</span>
        <div class="src-score-bar-wrap">
          <span class="src-score-label">match</span>
          <div class="src-score-bar" style="width:${barW}px"></div>
          <span class="src-score-pct">${score}%</span>
        </div>
      </div>
      <div class="src-excerpt">${excerpt}…</div>
      <div class="src-footer">Click to jump to page ${r.chunk.page}</div>
    `;

    card.addEventListener("click", () => {
      // Highlight active card
      if (activeResultCard) activeResultCard.classList.remove("active-result");
      card.classList.add("active-result");
      activeResultCard = card;

      // Jump to page
      renderPage(r.chunk.page);

      // Flash the status bar with context
      statusEl.textContent = `🔍 Search result — Page ${r.chunk.page} (${score}% match)`;
      setTimeout(() => {
        const t = activeTab();
        if (t) statusEl.textContent = `✅ Page ${t.currentPage} of ${t.pdfDoc?.numPages}`;
      }, 3000);
    });

    container.appendChild(card);
  });
}

// Bold the query terms in excerpt (simple word match)
function highlightQueryTerms(text, query) {
  const escaped = text.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const words = query.trim().split(/\s+/).filter(w => w.length > 2);
  if (!words.length) return escaped;
  const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,'\\')).join("|")})`, "gi");
  return escaped.replace(pattern, "<mark>$1</mark>");
}

function showSearchSpinner() {
  const container = document.getElementById("search-results");
  container.innerHTML = `<div class="search-spinner"><div class="search-spinner-ring"></div>Searching...</div>`;
}

function showSearchEmpty(msg) {
  const container = document.getElementById("search-results");
  const text = msg || "Type anything to search<br>across the entire PDF.<br><span style=\"color:var(--accent);font-size:10px\">Powered by semantic embeddings</span>";
  container.innerHTML = `<div class="search-empty"><div class="ei">🔍</div><div>${text}</div></div>`;
}

function showSearchMeta(msg) {
  const el = document.getElementById("search-meta");
  if (el) el.textContent = msg;
}

// ── Init ──────────────────────────────────────────────────
async function init() {
  await loadHighlights();

  // Start RAG engine (loads model in background)
  RAG.init(
    (msg)        => updateRagStatus(msg),
    ()           => updateRagBadge(true),
    (pct)        => updateRagProgress(pct)
  );

  const params  = new URLSearchParams(window.location.search);
  const fileUrl = params.get("file");
  if (fileUrl) createTab(fileUrl);
  else statusEl.textContent = "❌ No PDF URL found.";
}

function updateRagProgress(pct) {
  const bar = document.getElementById("rag-progress-bar");
  if (bar) {
    bar.style.width   = pct + "%";
    bar.style.display = pct < 100 ? "block" : "none";
  }
}

// ── RAG mode toggle ────────────────────────────────────────
document.getElementById("rag-toggle")?.addEventListener("click", () => {
  ragMode = !ragMode;
  const btn   = document.getElementById("rag-toggle");
  const label = document.getElementById("rag-mode-label");
  if (ragMode) {
    btn.classList.add("active");
    if (label) label.textContent = "🌐 Full PDF";
    appendBubble("thinking", "🧠 RAG mode ON — questions search the entire document");
  } else {
    btn.classList.remove("active");
    if (label) label.textContent = "📄 This Page";
    appendBubble("thinking", "📄 Page mode — questions use only the current page");
  }
  setTimeout(() => {
    const msgs = document.getElementById("chat-messages");
    const last = msgs?.querySelector(".bubble.thinking:last-child");
    if (last) last.remove();
  }, 2500);
});

init();