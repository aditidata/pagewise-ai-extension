// Get PDF URL from query params
const params = new URLSearchParams(window.location.search);
const fileUrl = params.get("file");

const statusEl = document.getElementById("status");

if (fileUrl) {
  statusEl.textContent = "✅ PDF received: " + fileUrl;
} else {
  statusEl.textContent = "❌ No PDF URL found.";
}