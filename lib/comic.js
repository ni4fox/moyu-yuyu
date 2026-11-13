/* 漫画 / 图片读取：单图、图片文件夹、CBZ（zip 图片包）
   只依赖 fs / path / zlib，可单独用 node 测试 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const IMG_EXTS = new Set(["jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp", "avif"]);
const MAX_FILES = 1200;
const MAX_TOTAL = 800 * 1024 * 1024;   // 解压总量上限，防压缩炸弹

const isImg = (f) => IMG_EXTS.has(path.extname(f).slice(1).toLowerCase());
const natCmp = (a, b) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });

function listImagesInDir(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && isImg(d.name))
    .map((d) => path.join(dir, d.name))
    .sort((a, b) => natCmp(path.basename(a), path.basename(b)))
    .slice(0, MAX_FILES);
}

/* 读 zip 中央目录（支持 store / deflate；ZIP64 不处理） */
function readZipEntries(buf) {
  const minOff = Math.max(0, buf.length - 66560);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minOff; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 CBZ/ZIP 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(off + 8);
    const nameLen = buf.readUInt16LE(off + 28);
    const extLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const raw = buf.subarray(off + 46, off + 46 + nameLen);
    let name;
    try { name = new TextDecoder(flags & 0x800 ? "utf-8" : "gbk").decode(raw); }
    catch (e) { name = raw.toString("utf8"); }
    out.push({
      name,
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42)
    });
    off += 46 + nameLen + extLen + cmtLen;
  }
  return out;
}

function extractZipEntry(buf, ent) {
  const o = ent.lho;
  if (buf.readUInt32LE(o) !== 0x04034b50) throw new Error("压缩包数据损坏");
  const nLen = buf.readUInt16LE(o + 26);
  const eLen = buf.readUInt16LE(o + 28);
  const start = o + 30 + nLen + eLen;
  const data = buf.subarray(start, start + ent.csize);
  if (ent.method === 0) return Buffer.from(data);
  if (ent.method === 8) return zlib.inflateRawSync(data);
  throw new Error("压缩方式不支持");
}

/* 解到临时目录（按文件+修改时间缓存），返回图片路径数组（已按自然顺序） */
function openComicArchive(p, tmpRoot) {
  const buf = fs.readFileSync(p);
  const ents = readZipEntries(buf)
    .filter((e) => !e.name.endsWith("/") && isImg(e.name))
    .sort((a, b) => natCmp(path.basename(a.name), path.basename(b.name)));
  if (!ents.length) throw new Error("压缩包里没有图片");

  const crypto = require("crypto");
  const key = crypto.createHash("md5").update(p + "|" + fs.statSync(p).mtimeMs).digest("hex");
  const outDir = path.join(tmpRoot, key);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
    let total = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      total += e.usize || e.csize;
      if (total > MAX_TOTAL) break;
      const extn = (path.extname(e.name) || ".jpg").toLowerCase();
      fs.writeFileSync(path.join(outDir, String(i).padStart(4, "0") + extn), extractZipEntry(buf, e));
    }
  }
  return fs.readdirSync(outDir).filter(isImg).sort().map((f) => path.join(outDir, f));
}

module.exports = { IMG_EXTS, isImg, natCmp, listImagesInDir, readZipEntries, extractZipEntry, openComicArchive };
