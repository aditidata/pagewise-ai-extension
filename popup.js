document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("check");

  btn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const url = tab.url || "";

    if (url.toLowerCase().includes(".pdf")) {
      alert("📘 PDF detected! Ready for page-wise summarization.");
    } else {
      alert("❌ This is not a PDF page.");
    }
  });
});