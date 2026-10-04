// Offline page: retry loading the configured web URL. Navigation is still checked by the main
// process (only the configured origin is allowed), and we only accept http(s) here.

const raw = new URLSearchParams(location.search).get("url") ?? "";
let target: URL | null = null;
try {
  const u = new URL(raw);
  if (u.protocol === "http:" || u.protocol === "https:") target = u;
} catch {
  target = null;
}

const label = document.getElementById("target");
if (label && target) label.textContent = target.origin;

function retry(): void {
  if (target) location.href = target.href;
}

document.getElementById("retry")?.addEventListener("click", retry);
if (target) setInterval(retry, 5000);
