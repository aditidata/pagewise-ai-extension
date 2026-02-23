// ── DOM ───────────────────────────────────────────────────
const optGroq      = document.getElementById("opt-groq");
const optOllama    = document.getElementById("opt-ollama");
const groqConfig   = document.getElementById("groq-config");
const ollamaConfig = document.getElementById("ollama-config");
const groqKey      = document.getElementById("groq-key");
const groqModel    = document.getElementById("groq-model");
const ollamaUrl    = document.getElementById("ollama-url");
const ollamaModel  = document.getElementById("ollama-model");
const saveBtn      = document.getElementById("save-btn");
const testBtn      = document.getElementById("test-btn");
const statusBanner = document.getElementById("status-banner");
const statusIcon   = document.getElementById("status-icon");
const statusText   = document.getElementById("status-text");

// ── Theme ─────────────────────────────────────────────────
let isLight = false;
document.getElementById("theme-btn").addEventListener("click", () => {
  isLight = !isLight;
  document.documentElement.setAttribute("data-theme", isLight ? "light" : "dark");
  document.getElementById("theme-btn").textContent = isLight ? "🌑" : "🌙";
});

// ── Backend toggle ────────────────────────────────────────
function selectBackend(backend) {
  // Radio
  document.querySelector(`input[value="${backend}"]`).checked = true;

  // Visual
  optGroq.className   = "backend-option" + (backend === "groq"   ? " selected-groq"   : "");
  optOllama.className = "backend-option" + (backend === "ollama" ? " selected-ollama" : "");

  // Show/hide config
  groqConfig.className   = "config-section" + (backend === "groq"   ? " active" : "");
  ollamaConfig.className = "config-section" + (backend === "ollama" ? " active" : "");

  hideStatus();
}

optGroq.addEventListener("click",   () => selectBackend("groq"));
optOllama.addEventListener("click", () => selectBackend("ollama"));

// ── Status banner ─────────────────────────────────────────
function showStatus(type, icon, text) {
  statusBanner.className = `status-banner show ${type}`;
  statusIcon.textContent = icon;
  statusText.textContent = text;
}

function hideStatus() {
  statusBanner.className = "status-banner";
}

// ── Load saved settings ───────────────────────────────────
chrome.storage.local.get(["pagewise_config"], (result) => {
  const config = result.pagewise_config || {
    backend:      "groq",
    groqKey:      "",
    groqModel:    "llama-3.1-8b-instant",
    ollamaUrl:    "http://localhost:5000",
    ollamaModel:  "llama3.2:1b",
  };

  selectBackend(config.backend);
  groqKey.value      = config.groqKey      || "";
  groqModel.value    = config.groqModel    || "llama-3.1-8b-instant";
  ollamaUrl.value    = config.ollamaUrl    || "http://localhost:5000";
  ollamaModel.value  = config.ollamaModel  || "llama3.2:1b";
});

// ── Save settings ─────────────────────────────────────────
saveBtn.addEventListener("click", () => {
  const backend = document.querySelector('input[name="backend"]:checked')?.value || "groq";

  if (backend === "groq" && !groqKey.value.trim()) {
    showStatus("error", "❌", "Please enter your Groq API key.");
    return;
  }

  const config = {
    backend,
    groqKey:     groqKey.value.trim(),
    groqModel:   groqModel.value,
    ollamaUrl:   ollamaUrl.value.trim() || "http://localhost:5000",
    ollamaModel: ollamaModel.value.trim() || "llama3.2:1b",
  };

  chrome.storage.local.set({ pagewise_config: config }, () => {
    showStatus("success", "✅", "Settings saved successfully!");
    setTimeout(hideStatus, 3000);
  });
});

// ── Test connection ───────────────────────────────────────
testBtn.addEventListener("click", async () => {
  const backend = document.querySelector('input[name="backend"]:checked')?.value || "groq";
  showStatus("testing", "⏳", "Testing connection...");
  testBtn.disabled = true;

  try {
    if (backend === "groq") {
      const key = groqKey.value.trim();
      if (!key) { showStatus("error", "❌", "Enter your Groq API key first."); testBtn.disabled = false; return; }

      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: groqModel.value,
          messages: [{ role: "user", content: "Say OK" }],
          max_tokens: 5
        })
      });

      if (res.ok) {
        showStatus("success", "✅", `Groq connected! Model: ${groqModel.value}`);
      } else {
        const err = await res.json();
        showStatus("error", "❌", `Groq error: ${err.error?.message || res.status}`);
      }

    } else {
      const url = ollamaUrl.value.trim() || "http://localhost:5000";
      const res = await fetch(`${url}/summarize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "test" })
      });

      if (res.ok) {
        showStatus("success", "✅", "Ollama backend connected!");
      } else {
        showStatus("error", "❌", `Backend error: ${res.status}. Is server.js running?`);
      }
    }
  } catch (err) {
    if (backend === "groq") {
      showStatus("error", "❌", "Cannot reach Groq. Check your internet connection.");
    } else {
      showStatus("error", "❌", "Cannot reach backend. Run: node server.js");
    }
  }

  testBtn.disabled = false;
});