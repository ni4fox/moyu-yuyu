const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, screen, nativeImage, shell, session, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
const crypto = require("crypto");

/* 内存优化：限制渲染进程数量与单进程 V8 堆上限 */
app.commandLine.appendSwitch("renderer-process-limit", "4");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=512");

/* 测试模式：独立 userData，不干扰正式安装版（MOYU_TEST=1，可用 MOYU_PROFILE 固定目录） */
if (process.env.MOYU_TEST) {
  const name = process.env.MOYU_PROFILE
    ? "moyu-test-profile-" + process.env.MOYU_PROFILE
    : "moyu-test-profile-" + Date.now();
  app.setPath("userData", path.join(os.tmpdir(), name));
}

const PORT = +process.env.MOYU_PORT || 47823;
const STORE = path.join(app.getPath("userData"), "layout.json");

let win = null;
let tray = null;
let quitting = false;

const DEFAULTS = {
  w: 480, h: 360, x: 16, y: null,
  hidden: false,
  adaptive: true,  // 自适应（移动版排版）
  top: true,       // 置顶
  opacity: 1,      // 窗口透明度 0.3 ~ 1
  hoverHide: false // 悬停显隐：鼠标离开自动隐藏，移回显示
};

function loadPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STORE, "utf8")) }; }
  catch (e) { return { ...DEFAULTS }; }
}
function savePrefs(patch) {
  try { fs.writeFileSync(STORE, JSON.stringify({ ...loadPrefs(), ...patch })); } catch (e) {}
}
let prefs = loadPrefs();

function createWindow() {
  const { height: sh } = screen.getPrimaryDisplay().workArea;
  const w = prefs.w, h = prefs.h;

  creatingMain = true;
  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 280,
    minHeight: 180,
    x: typeof prefs.x === "number" ? prefs.x : 16,
    y: typeof prefs.y === "number" ? prefs.y : Math.max(0, sh - h - 16),
    frame: false,
    resizable: true,
    alwaysOnTop: prefs.top,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#17181c",
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });
  win.setAlwaysOnTop(prefs.top, "screen-saver");
  win.setOpacity(Math.min(1, Math.max(0.3, prefs.opacity || 1)));
  win.loadFile("index.html");

  /* 记录键盘活动（含网页里的输入），供悬停显隐判断"是否正在使用" */
  win.webContents.on("before-input-event", () => { lastInputAt = Date.now(); });
  win.webContents.on("did-attach-webview", (_e, wc) => {
    wc.on("before-input-event", () => { lastInputAt = Date.now(); });
  });

  win.once("ready-to-show", () => {
    if (!prefs.hidden) win.show();
    buildTray();
  });

  win.on("close", (e) => {
    if (!quitting) { e.preventDefault(); win.hide(); savePrefs({ hidden: true }); }
  });
  win.on("hide", () => savePrefs({ hidden: true }));
  win.on("show", () => savePrefs({ hidden: false }));

  let t = null;
  const persistBounds = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!win) return;
      const b = win.getBounds();
      savePrefs({ x: b.x, y: b.y, w: b.width, h: b.height });
    }, 250);
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
}

/* ---------- 弹窗策略 ----------
   普通链接的新窗口 → 收成小窗内的标签页；
   登录 / 授权类弹窗（Google、GitHub、微信、QQ、Apple、微软…）→ 放行成真正的子窗口，
   否则父页面永远等不到回调，会一直转圈"没有响应"。 */
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const AUTH_HOSTS = [
  "accounts.google.com", "accounts.youtube.com", "appleid.apple.com",
  "open.weixin.qq.com", "graph.qq.com", "open.weibo.com", "api.weibo.com",
  "login.microsoftonline.com", "login.live.com", "login.microsoft.com",
  "github.com", "gitlab.com", "bitbucket.org", "id.twitch.tv",
  "discord.com", "slack.com", "okta.com", "auth0.com", "onelogin.com",
  "facebook.com", "api.twitter.com", "x.com", "linkedin.com",
  "paypal.com", "www.paypal.com", "checkout.stripe.com", "js.stripe.com",
  "apple.com.cn"
];

function isAuthUrl(u) {
  try {
    const url = new URL(u);
    const h = url.hostname.toLowerCase();
    const p = url.pathname.toLowerCase();
    // 明显是登录/授权路径
    if (/(^|\/)(oauth|oauth2|authorize|authorization|sso|signin|login|passport|connect)(\/|$)/.test(p)) return true;
    // 常见登录子域
    if (/^(accounts|login|passport|oauth|signin|auth|sso|id)\./.test(h)) return true;
    // 常见账号服务商
    return AUTH_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch (e) {
    return false;
  }
}

let pendingPopups = 0;   // 已放行的登录弹窗个数，防止被兜底逻辑误杀

app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url, frameName, disposition }) => {
    if (!/^https?:/i.test(url)) return { action: "deny" };

    const namedPopup = disposition === "new-window" && frameName && frameName !== "_blank";
    if (isAuthUrl(url) || namedPopup) {
      pendingPopups++;
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          minWidth: 380,
          minHeight: 480,
          autoHideMenuBar: true,
          title: "登录",
          backgroundColor: "#ffffff",
          // 用普通桌面 Chrome UA，避免 Google 判定为"不安全的嵌入式浏览器"
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    openInNewTab(url);
    return { action: "deny" };
  });

  // 登录窗口建好后，换成桌面 Chrome UA 并隐藏菜单
  contents.on("did-create-window", (child) => {
    try {
      child.setMenuBarVisibility(false);
      child.webContents.setUserAgent(CHROME_UA);
    } catch (e) {}
  });
});

/* 兜底：不是我们主动创建的窗口（某些站点用 about:blank 中转）就收成标签页再销毁 */
let creatingMain = false;
app.on("browser-window-created", (_e, w) => {
  if (creatingMain) { creatingMain = false; return; }
  if (pendingPopups > 0) {           // 放行的登录弹窗，留着
    pendingPopups--;
    console.log("[WIN-KEEP] popup", w.id);
    try {
      w.setMenuBarVisibility(false);
      w.webContents.setUserAgent(CHROME_UA);
    } catch (e) {}
    return;
  }
  let done = false;
  const collect = () => {
    if (done) return;
    done = true;
    try {
      const u = w.webContents.getURL();
      if (/^https?:/i.test(u) && !isAuthUrl(u)) openInNewTab(u);
    } catch (err) {}
    try { w.destroy(); } catch (err) {}
  };
  w.webContents.once("did-finish-load", collect);
  w.webContents.once("did-start-navigation", collect);
  setTimeout(collect, 2000);
});

/* 同一次点击可能同时触发 <a> 拦截和 window.open，去重 */
let lastOpen = { url: "", t: 0 };
function openInNewTab(url) {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (url === lastOpen.url && now - lastOpen.t < 800) return;
  lastOpen = { url, t: now };
  if (!win.isVisible()) win.show();
  win.webContents.send("moyu:open", url);
}

function buildTray() {
  // 先销毁旧托盘，否则每次改设置都会残留一个图标
  if (tray) { try { tray.destroy(); } catch (e) {} tray = null; }
  // 测试实例不建托盘：测试进程被强杀时来不及注销图标，会在通知区留下一堆幽灵图标
  if (process.env.MOYU_TEST) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("摸鱼鱼鱼");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示 / 隐藏（Alt+Q）", click: toggleWin },
    { label: "置顶", type: "checkbox", checked: prefs.top, click: (i) => setTop(i.checked) },
    { label: "自适应排版", type: "checkbox", checked: prefs.adaptive, click: (i) => setAdaptive(i.checked) },
    { type: "separator" },
    { label: "不透明", click: () => setOpacity(1) },
    { label: "透明度 80%", click: () => setOpacity(0.8) },
    { label: "透明度 60%", click: () => setOpacity(0.6) },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on("click", toggleWin);
}

function setTop(on) {
  prefs.top = !!on; savePrefs({ top: prefs.top });
  if (win) win.setAlwaysOnTop(prefs.top, "screen-saver");
  if (tray) buildTray();
}
function setOpacity(v) {
  v = Math.min(1, Math.max(0.3, +v || 1));
  prefs.opacity = v; savePrefs({ opacity: v });
  if (win) win.setOpacity(v);
}
function setAdaptive(on) {
  prefs.adaptive = !!on; savePrefs({ adaptive: prefs.adaptive });
  if (win) win.webContents.send("prefs:changed", prefs);
  if (tray) buildTray();
}

/* ---------- 悬停显隐：鼠标离开窗口约 1.5 秒自动隐藏，从外面移回来自动显示 ----------
   旧版用 isFocused() 当"正在使用"的判据，但点完菜单窗口一直是聚焦的，
   鼠标移开也永远不隐藏（这就是"开了没反应"的原因）。改成：
   - 只看鼠标在不在窗口里（唯一判据）
   - 键盘输入后 2 秒内不隐藏（打字/搜索时不会被藏掉）
   - 系统对话框打开期间暂停（否则选文件时窗口会消失） */
let hoverTimer = null;
let hoverOutTicks = 0;
let hoverInside = false;   // 上一拍鼠标是否在窗内，用于判断"从外面移进来"
let lastInputAt = 0;       // 最近一次键盘输入时间
let modalDepth = 0;        // 系统模态对话框打开数

function cursorInWin() {
  if (!win) return false;
  const b = win.getBounds();
  const pt = screen.getCursorScreenPoint();
  return pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
}

function stopHoverTimer() {
  if (hoverTimer) { clearInterval(hoverTimer); hoverTimer = null; }
}

function setHoverHide(on) {
  prefs.hoverHide = !!on;
  savePrefs({ hoverHide: prefs.hoverHide });
  if (win) win.webContents.send("prefs:changed", prefs);
  stopHoverTimer();
  if (!prefs.hoverHide) return;
  hoverOutTicks = 0;
  hoverInside = cursorInWin();
  hoverTimer = setInterval(hoverTick, 250);
}

function hoverTick() {
  if (!win || modalDepth > 0) return;
  const inWin = cursorInWin();
  const wasIn = hoverInside;
  hoverInside = inWin;

  if (win.isVisible()) {
    if (inWin) { hoverOutTicks = 0; return; }              // 鼠标还在窗里
    if (Date.now() - lastInputAt < 2000) { hoverOutTicks = 0; return; } // 刚打过字
    if (++hoverOutTicks >= 6) {                            // 250ms × 6 ≈ 1.5 秒
      hoverOutTicks = 0;
      win.hide();                                          // hide 事件里会存 hidden:true
    }
  } else if (inWin && !wasIn) {
    win.showInactive();                                    // 从外面移回来才显示，且不抢焦点
  }
}

function toggleWin() {
  if (!win) return;
  if (win.isVisible()) { win.hide(); savePrefs({ hidden: true }); }
  else { win.show(); win.focus(); savePrefs({ hidden: false }); }
}

function showAndOpen(url) {
  if (!url || !/^https?:/i.test(url)) return;
  if (!win) createWindow();
  win.show();
  win.focus();
  savePrefs({ hidden: false });
  const send = () => win.webContents.send("moyu:open", url);
  if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
  else send();
}

/* ---------- 本机联动服务：浏览器书签可直接把当前页发过来 ----------
   安全：/open 必须带本机随机 token（?k= 或 x-moyu-token 头或 body.k），
   防止任意网页/本机程序未授权就把内容推进你的置顶小窗。 */
function ensureToken() {
  if (!prefs.serverToken) {
    prefs.serverToken = crypto.randomBytes(16).toString("hex");
    savePrefs({ serverToken: prefs.serverToken });
  }
  return prefs.serverToken;
}
function tokenOk(req, u, body) {
  const t = ensureToken();
  if (u.searchParams.get("k") === t) return true;
  if (req.headers["x-moyu-token"] === t) return true;
  try { if (JSON.parse(body || "{}").k === t) return true; } catch (e) {}
  return false;
}
function startServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (u.pathname === "/open" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
      req.on("end", () => {
        if (!tokenOk(req, u, body)) { res.writeHead(403); res.end("forbidden"); return; }
        let url = "";
        try { url = JSON.parse(body).url || ""; } catch (e) { url = body.trim(); }
        showAndOpen(url);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: !!url }));
      });
      return;
    }
    if (u.pathname === "/open" && u.searchParams.get("url")) {
      if (!tokenOk(req, u, "")) { res.writeHead(403); res.end("forbidden"); return; }
      showAndOpen(u.searchParams.get("url"));
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (u.pathname === "/ping") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("moyu-ok");
      return;
    }
    res.writeHead(404); res.end();
  });
  server.on("error", (e) => console.warn("联动服务启动失败：", e.message));
  server.listen(PORT, "127.0.0.1");
}
let server = null;

ipcMain.handle("prefs:get", () => prefs);
ipcMain.on("win:hide", () => { if (win) { win.hide(); savePrefs({ hidden: true }); } });
ipcMain.on("win:top", (e, on) => setTop(on));
ipcMain.on("win:hover", (e, on) => setHoverHide(on));
ipcMain.on("win:opacity", (e, v) => setOpacity(v));
ipcMain.on("win:adaptive", (e, on) => setAdaptive(on));
ipcMain.on("win:port", (e) => { e.returnValue = PORT; });
ipcMain.on("win:token", (e) => { e.returnValue = ensureToken(); });
ipcMain.on("win:external", (e, url) => {
  if (typeof url === "string" && /^(https?|file):/i.test(url)) shell.openExternal(url);
});

/* ---------- 文档阅读：选文件 + 读文件 ----------
   pdf/html 走 webview file://；txt/md/docx 读回内容在阅读模式里排版 */
const DOC_MAX = 30 * 1024 * 1024;   // 30MB
const TEXT_EXTS = new Set(["txt", "md", "markdown", "log", "csv", "json", "js", "ts", "py", "css", "html", "htm", "xml", "yml", "yaml", "ini", "bat", "sh"]);

ipcMain.handle("doc:pick", async () => {
  if (!win) return null;
  modalDepth++;
  let r;
  try {
    r = await dialog.showOpenDialog(win, {
      title: "打开文档",
      properties: ["openFile"],
      filters: [
        { name: "全部支持", extensions: ["pdf", "docx", "txt", "md", "markdown", "html", "htm", "log", "csv", "cbz", "zip", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] },
        { name: "图片 / 漫画", extensions: ["cbz", "zip", "jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
  } finally { modalDepth--; }
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

ipcMain.handle("doc:pick-folder", async () => {
  if (!win) return null;
  modalDepth++;
  let r;
  try {
    r = await dialog.showOpenDialog(win, {
      title: "打开图片 / 漫画文件夹",
      properties: ["openDirectory"],
      buttonLabel: "打开"
    });
  } finally { modalDepth--; }
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});

/* ---------- 漫画：图片 / 图片文件夹 / CBZ（zip 图片包） ---------- */
const comic = require("./lib/comic.js");
const IMG_EXTS = comic.IMG_EXTS;
const isImg = comic.isImg;
const listImagesInDir = comic.listImagesInDir;
const openComicArchive = (p) => comic.openComicArchive(p, path.join(app.getPath("temp"), "moyu-comic"));

ipcMain.handle("doc:read", async (_e, p) => {
  try {
    p = String(p || "");
    if (!p || !fs.existsSync(p)) return { ok: false, err: "文件不存在" };
    const st = fs.statSync(p);
    const name = path.basename(p);

    // 文件夹 → 当漫画读（按文件名自然排序）
    if (st.isDirectory()) {
      const files = listImagesInDir(p);
      if (!files.length) return { ok: false, err: "这个文件夹里没有图片" };
      return { ok: true, name, ext: "comic", files };
    }

    if (st.size > DOC_MAX) return { ok: false, err: "文件超过 30MB" };
    if (st.size === 0) return { ok: false, err: "文件是空的（0 字节）——可能是右键新建的占位文件，还没保存过内容" };

    const ext = path.extname(p).slice(1).toLowerCase();

    // 单张图片：直接进阅读器看
    if (IMG_EXTS.has(ext)) return { ok: true, name, ext: "comic", files: [p] };

    // CBZ / ZIP 图片包
    if (ext === "cbz" || ext === "zip") {
      try {
        return { ok: true, name, ext: "comic", files: openComicArchive(p) };
      } catch (err) {
        return { ok: false, err: "读取漫画包失败：" + err.message };
      }
    }
    if (ext === "cbr" || ext === "rar") {
      return { ok: false, err: "CBR 是 RAR 压缩，暂不支持——解压后把文件夹拖进来，或另存为 CBZ" };
    }

    const buf = fs.readFileSync(p);
    if (ext === "docx") {
      return { ok: true, name, ext, b64: buf.toString("base64") };
    }
    let text = buf.toString("utf8");
    // GBK 兜底：utf8 解出来替换符太多就换 GBK
    if (!TEXT_EXTS.has(ext) || (text.match(/\uFFFD/g) || []).length > text.length * 0.01) {
      try {
        const gbk = new TextDecoder("gbk").decode(buf);
        if ((gbk.match(/\uFFFD/g) || []).length < (text.match(/\uFFFD/g) || []).length) text = gbk;
      } catch (err) {}
    }
    // 纯文本嗅探：二进制文件不给读
    const sample = text.slice(0, 4000);
    if ((sample.match(/[\u0000-\u0008\u000E-\u001F]/g) || []).length > sample.length * 0.05) {
      return { ok: false, err: "暂不支持这种文件格式" };
    }
    return { ok: true, name, ext, text };
  } catch (err) {
    return { ok: false, err: err.message };
  }
});

const gotLock = app.requestSingleInstanceLock();if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { win.show(); win.focus(); } });

  app.whenReady().then(() => {
    createWindow();
    startServer();
    if (prefs.hoverHide) setHoverHide(true);   // 记住了上次开的悬停显隐
    // 权限收紧：只放行全屏/指针锁定，地理位置、通知、麦克风、摄像头等一律拒绝
    const ALLOW_PERMS = new Set(["fullscreen", "pointerLock"]);
    const applyPerms = (ses) => {
      try {
        ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOW_PERMS.has(permission)));
        ses.setPermissionCheckHandler((_wc, permission) => ALLOW_PERMS.has(permission));
      } catch (e) {}
    };
    applyPerms(session.defaultSession);
    applyPerms(session.fromPartition("persist:moyu"));
    if (!process.env.MOYU_TEST) {
      const ok = globalShortcut.register("Alt+Q", toggleWin);
      if (!ok) console.warn("Alt+Q 注册失败，可能被其他程序占用");
    }
    app.on("activate", () => { if (win) win.show(); });
  });

  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    if (server) server.close();
    if (tray) { try { tray.destroy(); tray = null; } catch (e) {} }  // 正常退出也把托盘图标撤掉
  });
  app.on("window-all-closed", () => { /* 留驻托盘 */ });
}
