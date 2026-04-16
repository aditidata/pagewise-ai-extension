document.addEventListener("DOMContentLoaded", () => {
  const dot     = document.getElementById("dot");
  const beVal   = document.getElementById("be-val");
  const warning = document.getElementById("warning");

  chrome.storage.local.get(["pagewise_config"], (result) => {
    const config  = result.pagewise_config;
    const backend = config?.backend || "none";
    if (backend === "groq") {
      dot.className = "dot groq";
      beVal.textContent = "⚡ Groq";
      beVal.style.color = "#f97316";
    } else if (backend === "ollama") {
      dot.className = "dot ollama";
      beVal.textContent = "🦙 Ollama";
      beVal.style.color = "#4ade80";
    } else {
      dot.className = "dot none";
      beVal.textContent = "Not configured";
    }
  });

  document.getElementById("check-btn").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab.url || "";
    if (url.match(/\.(pdf|docx|pptx|txt|md)(?:\?.*)?$/i) || url.toLowerCase().includes(".pdf")) {
      const viewerUrl = chrome.runtime.getURL("viewer.html") + "?file=" + encodeURIComponent(url);
      chrome.tabs.create({ url: viewerUrl });
    } else {
      warning.classList.add("show");
      setTimeout(() => warning.classList.remove("show"), 3000);
    }
  });

  document.getElementById("settings-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  document.getElementById("github-btn").addEventListener("click", () => {
    chrome.tabs.create({ url: "https://github.com/YOUR_USERNAME/pagewise-ai-extension" });
  });
});