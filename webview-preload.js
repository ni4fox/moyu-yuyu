const { ipcRenderer, webUtils } = require("electron");

/* ---------- 滚动条（9px 细条，半透明） ---------- */
const SCROLL_CSS = `
  ::-webkit-scrollbar { width: 9px; height: 9px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: rgba(140,140,146,.45); border-radius: 4px;
    border: 2px solid transparent; background-clip: padding-box;
  }
  ::-webkit-scrollbar-thumb:hover { background: rgba(170,170,176,.75); background-clip: padding-box; }
  ::-webkit-scrollbar-corner { background: transparent; }
`;

function injectCss() {
  try {
    const s = document.createElement("style");
    s.textContent = SCROLL_CSS;
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
}

/* ---------- 鼠标中键拖动平移 ---------- */
let panning = false;
let lastX = 0, lastY = 0;

window.addEventListener("mousedown", (e) => {
  if (e.button !== 1) return;
  const el = e.target;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
  e.preventDefault();
  e.stopPropagation();
  panning = true;
  lastX = e.clientX; lastY = e.clientY;
  document.documentElement.style.cursor = "grabbing";
}, true);

window.addEventListener("mousemove", (e) => {
  if (!panning) return;
  e.preventDefault();
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  window.scrollBy(-dx, -dy);
}, true);

window.addEventListener("mouseup", (e) => {
  if (e.button !== 1 || !panning) return;
  panning = false;
  document.documentElement.style.cursor = "";
}, true);

/* 吃掉中键默认行为（自动滚动圆盘 / 中键开新窗口） */
window.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); }, true);

/* ---------- Ctrl + 滚轮 → 整页缩放（交给宿主处理，保证和面板同步） ---------- */
window.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  try { ipcRenderer.sendToHost("moyu-zoom", e.deltaY > 0 ? -1 : 1); } catch (err) {}
}, { passive: false, capture: true });

/* ---------- target=_blank 的链接：交给宿主开成新标签页 ---------- */
/* 但登录/授权类链接不能抢 —— 抢成标签页后没有 opener，父页面会一直转圈等回调 */
function looksLikeAuth(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    const p = url.pathname.toLowerCase();
    if (/(^|\/)(oauth|oauth2|authorize|authorization|sso|signin|login|passport|connect)(\/|$)/.test(p)) return true;
    if (/^(accounts|login|passport|oauth|signin|auth|sso|id)\./.test(h)) return true;
    return /(^|\.)(google|apple|microsoft|microsoftonline|github|gitlab|weixin|qq|weibo|facebook|twitter|x|linkedin|discord|slack|okta|auth0|paypal|stripe)\.(com|cn|org|net)$/.test(h);
  } catch (e) {
    return false;
  }
}

document.addEventListener("click", (e) => {
  if (e.button !== 0 && e.button !== 1) return;
  const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
  if (!a) return;
  const href = a.href || "";
  if (!/^https?:/i.test(href)) return;
  if (looksLikeAuth(href)) return;          // 登录链接让页面自己处理 → 走真正的弹窗
  const tgt = (a.getAttribute("target") || "").toLowerCase();
  const opensNew = tgt === "_blank" || tgt === "_new" || e.ctrlKey || e.metaKey;
  if (!opensNew) return;
  e.preventDefault();
  try { ipcRenderer.sendToHost("moyu-newtab", href); } catch (err) {}
}, true);

/* ---------- 把滚动状态报给宿主，用于底部横向滚动条 / 适宽缩放 ---------- */
function report() {
  const el = document.scrollingElement || document.documentElement;
  if (!el) return;
  // 有些站把溢出藏在 body 或某个容器里，多测几处取最大值，便于「适应宽度」判断
  let dw = el.scrollWidth;
  try {
    const b = document.body;
    if (b) dw = Math.max(dw, b.scrollWidth, Math.ceil(b.getBoundingClientRect().width));
  } catch (e) {}
  try {
    ipcRenderer.sendToHost("moyu-scroll", {
      x: el.scrollLeft,
      maxX: Math.max(0, el.scrollWidth - el.clientWidth),
      vw: el.clientWidth,
      vh: el.clientHeight,
      dw
    });
  } catch (e) {}
}

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; report(); });
}

window.addEventListener("scroll", schedule, true);
window.addEventListener("resize", schedule);
document.addEventListener("DOMContentLoaded", () => { injectCss(); schedule(); });
if (document.readyState !== "loading") injectCss();
setInterval(schedule, 1200);
window.addEventListener("load", () => { setTimeout(schedule, 300); });

ipcRenderer.on("moyu-scroll-to", (_e, x) => {
  const el = document.scrollingElement || document.documentElement;
  if (el) el.scrollLeft = x;
});

/* ---------- 拖文件进窗口 → 交给宿主用文档阅读器打开 ----------
   不拦的话，网页自己会响应 drop（跳转/上传/吞掉），文件根本到不了小窗 */
function dragHasFile(e) {
  try { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"); }
  catch (err) { return false; }
}

window.addEventListener("dragover", (e) => {
  if (!dragHasFile(e)) return;         // 网页内部拖拽（选字、排序）不受影响
  e.preventDefault();
  e.stopPropagation();
}, true);

window.addEventListener("drop", (e) => {
  if (!dragHasFile(e)) return;
  e.preventDefault();
  e.stopPropagation();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!f) return;
  let p = "";
  try { p = webUtils.getPathForFile(f) || ""; } catch (err) {}
  if (p) { try { ipcRenderer.sendToHost("moyu-dropfile", p); } catch (err) {} }
}, true);
