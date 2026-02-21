document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("check");

  btn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const url = tab.url || "";

    if (url.toLowerCase().includes(".pdf")) {
      // 🔥 open our custom viewer
      const viewerUrl =
        chrome.runtime.getURL("viewer.html") +
        "?file=" +
        encodeURIComponent(url);

      chrome.tabs.create({ url: viewerUrl });
    } else {
      alert("❌ This is not a PDF page.");
    }
  });
});