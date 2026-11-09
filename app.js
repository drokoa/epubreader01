/* ============================================================
 *  EPUB 阅读器
 *  ------------------------------------------------------------
 *  1. 本地书库：epub 文件存进 IndexedDB，关掉浏览器再打开仍在
 *  2. 目录面板：EPUB3 nav / EPUB2 NCX 双支持，保留层级缩进
 *  3. 阅读进度：按书记住读到第几章，下次点击卡片直接续读
 *
 *  依赖：全局 JSZip
 * ============================================================ */

'use strict';

/* ============================================================
 *  常量 / DOM
 * ============================================================ */

const DB_NAME = 'epub-reader-db';
const DB_VERSION = 1;
const META_STORE = 'books';   // 书籍元数据（小、频繁更新）
const FILE_STORE = 'files';   // epub 原始字节（大、只写一次）

const el = {
  library:        document.getElementById('library'),
  libSub:         document.getElementById('lib-sub'),
  storageWarning: document.getElementById('storage-warning'),
  bookList:       document.getElementById('book-list'),
  emptyState:     document.getElementById('empty-state'),
  fileInput:      document.getElementById('file-input'),
  reader:         document.getElementById('reader'),
  content:        document.getElementById('reader-content'),
  chapterTitle:   document.getElementById('chapter-title'),
  chapterProgress:document.getElementById('chapter-progress'),
  prevBtn:        document.getElementById('prev-btn'),
  nextBtn:        document.getElementById('next-btn'),
  backBtn:        document.getElementById('back-btn'),
  tocBtn:         document.getElementById('toc-btn'),
  tocPanel:       document.getElementById('toc-panel'),
  tocList:        document.getElementById('toc-list'),
  tocMask:        document.getElementById('toc-mask'),
  tocClose:       document.getElementById('toc-close'),
  themePicker:    document.getElementById('theme-picker'),
  directionSelect:document.getElementById('direction-select'),
};

const state = {
  db: null,
  storageOk: false,
  memory: { books: new Map(), files: new Map() },

  books: [],              // 书库记录数组
  record: null,           // 当前打开的书（元数据）
  zip: null,              // 当前 JSZip 实例
  locate: null,           // 路径 -> JSZipObject
  spine: [],              // 章节路径数组
  toc: [],                // { title, spineIndex, anchor, depth }
  tocTitleBySpine: new Map(),
  currentIndex: -1,
  isAnimating: false,
};

/* ============================================================
 *  IndexedDB 封装
 * ============================================================ */

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txComplete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('数据库事务被中止'));
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB'));
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('数据库被其它标签页占用，请关闭后重试'));
  });
}

const storage = {
  async listBooks() {
    if (state.storageOk) {
      const tx = state.db.transaction(META_STORE, 'readonly');
      return promisifyRequest(tx.objectStore(META_STORE).getAll());
    }
    return Array.from(state.memory.books.values());
  },

  async getBook(id) {
    if (state.storageOk) {
      const tx = state.db.transaction(META_STORE, 'readonly');
      return (await promisifyRequest(tx.objectStore(META_STORE).get(id))) || null;
    }
    return state.memory.books.get(id) || null;
  },

  async getFileData(id) {
    if (state.storageOk) {
      const tx = state.db.transaction(FILE_STORE, 'readonly');
      const row = await promisifyRequest(tx.objectStore(FILE_STORE).get(id));
      return row ? row.data : null;
    }
    return state.memory.files.get(id) || null;
  },

  async saveBook(record, data) {
    if (state.storageOk) {
      const tx = state.db.transaction([META_STORE, FILE_STORE], 'readwrite');
      tx.objectStore(FILE_STORE).put({ id: record.id, data });
      tx.objectStore(META_STORE).put(record);
      await txComplete(tx);
      return;
    }
    state.memory.files.set(record.id, data);
    state.memory.books.set(record.id, record);
  },

  async updateBook(id, patch) {
    const current = await this.getBook(id);
    if (!current) return null;
    const next = Object.assign({}, current, patch);
    if (state.storageOk) {
      const tx = state.db.transaction(META_STORE, 'readwrite');
      tx.objectStore(META_STORE).put(next);
      await txComplete(tx);
    } else {
      state.memory.books.set(id, next);
    }
    return next;
  },

  async deleteBook(id) {
    if (state.storageOk) {
      const tx = state.db.transaction([META_STORE, FILE_STORE], 'readwrite');
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(FILE_STORE).delete(id);
      await txComplete(tx);
    } else {
      state.memory.books.delete(id);
      state.memory.files.delete(id);
    }
  },
};

/* ============================================================
 *  通用工具
 * ============================================================ */

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch (err) { return text; }
}

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
}

/** 把 href 拆成「zip 内路径」和「锚点」 */
function splitHref(href) {
  const hashAt = href.indexOf('#');
  let pathPart = hashAt >= 0 ? href.slice(0, hashAt) : href;
  let anchor = hashAt >= 0 ? href.slice(hashAt + 1) : '';
  const queryAt = pathPart.indexOf('?');
  if (queryAt >= 0) pathPart = pathPart.slice(0, queryAt);
  return { path: safeDecode(pathPart), anchor: safeDecode(anchor) };
}

/** 相对路径解析为 zip 内绝对路径 */
function resolvePath(baseDir, relative) {
  if (!relative) return '';
  if (/^[a-z][a-z0-9+.\-]*:/i.test(relative)) return relative;   // http: data: 等

  const raw = safeDecode(relative).split(/[?#]/)[0];
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');

  const parts = baseDir.split('/').filter(Boolean);
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** zip 路径统一成小写、去前导 ./ 的键 */
function normalizeKey(path) {
  return safeDecode(path).replace(/^\.?\//, '').toLowerCase();
}

function buildZipIndex(zip) {
  const index = new Map();
  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    const key = normalizeKey(relativePath);
    if (!index.has(key)) index.set(key, relativePath);
  });
  return index;
}

/** 大小写 / 编码 / ./ 前缀都能命中的查表函数 */
function makeLocator(zip, index) {
  return function locate(path) {
    if (!path || !zip) return null;
    const real = index.get(normalizeKey(path));
    return real != null ? zip.file(real) : null;
  };
}

function byLocalName(root, name) {
  return Array.from(root.getElementsByTagName('*')).filter((node) => node.localName === name);
}

function firstByLocalName(root, name) {
  return byLocalName(root, name)[0] || null;
}

function childByLocalName(parent, name) {
  for (const child of parent.children) {
    if (child.localName === name) return child;
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** 文件名 + 大小 + 修改时间 → 稳定 id，重复导入同一本书不会产生副本 */
function makeBookId(file) {
  const raw = `${file.name}|${file.size}|${file.lastModified}`;
  return `b${fnv1a(raw)}${fnv1a(raw.split('').reverse().join(''))}`;
}

function hashHue(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i += 1) sum = (sum * 31 + text.charCodeAt(i)) % 360;
  return sum;
}

function mimeFromPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  };
  return map[ext] || '';
}

function relativeTime(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

function progressPercent(record) {
  const progress = record.progress;
  if (!progress || !progress.total) return 0;
  const read = clamp(progress.index + 1, 1, progress.total);
  return Math.round((read / progress.total) * 100);
}

function progressLabel(record) {
  const progress = record.progress;
  if (!progress || !progress.total) return '未开始';
  const read = clamp(progress.index + 1, 1, progress.total);
  return `${read} / ${progress.total} 章`;
}

/* localStorage 在隐私模式 / 受限环境下可能直接抛异常 */
function readSetting(key) {
  try { return window.localStorage.getItem(key); } catch (error) { return null; }
}

function writeSetting(key, value) {
  try { window.localStorage.setItem(key, value); } catch (error) { /* 忽略 */ }
}

/* ============================================================
 *  EPUB 解析
 * ============================================================ */

async function readNcx(locate, ncxPath) {
  const file = locate(ncxPath);
  if (!file) return [];

  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml');
  const baseDir = dirOf(ncxPath);
  const entries = [];

  const walk = (parent, depth) => {
    for (const navPoint of parent.children) {
      if (navPoint.localName !== 'navPoint') continue;

      const navLabel = childByLocalName(navPoint, 'navLabel');
      const textNode = navLabel ? firstByLocalName(navLabel, 'text') : null;
      const content = childByLocalName(navPoint, 'content');
      const src = content ? (content.getAttribute('src') || '') : '';

      if (src) {
        entries.push({
          title: (textNode ? textNode.textContent : '').trim(),
          href: src,
          baseDir,
          depth,
        });
      }
      walk(navPoint, depth + 1);
    }
  };

  const navMap = firstByLocalName(doc, 'navMap');
  if (navMap) walk(navMap, 0);
  return entries;
}

async function readNav(locate, navPath) {
  const file = locate(navPath);
  if (!file) return [];

  const doc = new DOMParser().parseFromString(await file.async('string'), 'text/html');
  const baseDir = dirOf(navPath);

  const navs = Array.from(doc.querySelectorAll('nav'));
  const target = navs.find((nav) => {
    const type = (nav.getAttribute('epub:type') || nav.getAttribute('type') || '').toLowerCase();
    const role = (nav.getAttribute('role') || '').toLowerCase();
    return type.includes('toc') || role === 'doc-toc';
  }) || navs[0];
  if (!target) return [];

  const entries = [];
  const walk = (list, depth) => {
    for (const item of list.children) {
      if (item.localName !== 'li') continue;

      let link = null;
      for (const child of item.children) {
        if (child.localName === 'a') { link = child; break; }
      }
      const href = link ? link.getAttribute('href') : '';
      if (link && href && !/^javascript:/i.test(href)) {
        entries.push({
          title: (link.textContent || '').trim(),
          href,
          baseDir,
          depth,
        });
      }

      const sublist = childByLocalName(item, 'ol');
      if (sublist) walk(sublist, depth + 1);
    }
  };

  const topList = childByLocalName(target, 'ol') || target.querySelector('ol');
  if (topList) walk(topList, 0);
  return entries;
}

/**
 * 解析 epub，返回 { title, author, spine, toc }
 * @param {Function} locate 路径 -> JSZipObject
 */
async function parseEpub(locate) {
  const parser = new DOMParser();

  const containerFile = locate('META-INF/container.xml');
  if (!containerFile) throw new Error('不是有效的 EPUB：缺少 META-INF/container.xml');

  const containerDoc = parser.parseFromString(await containerFile.async('string'), 'application/xml');
  const rootfile = firstByLocalName(containerDoc, 'rootfile');
  if (!rootfile) throw new Error('container.xml 里没有 rootfile');

  const opfPath = safeDecode(rootfile.getAttribute('full-path') || '');
  const opfDir = dirOf(opfPath);
  const opfFile = locate(opfPath);
  if (!opfFile) throw new Error('找不到 OPF 文件：' + opfPath);

  const opfDoc = parser.parseFromString(await opfFile.async('string'), 'application/xml');

  const titleNode = firstByLocalName(opfDoc, 'title');
  const authorNode = firstByLocalName(opfDoc, 'creator');
  const title = titleNode ? titleNode.textContent.trim() : '';
  const author = authorNode ? authorNode.textContent.trim() : '';

  /* ---- manifest ---- */
  const manifest = new Map();
  for (const item of byLocalName(opfDoc, 'item')) {
    const id = item.getAttribute('id');
    if (!id) continue;
    manifest.set(id, {
      href: item.getAttribute('href') || '',
      mediaType: item.getAttribute('media-type') || '',
      properties: item.getAttribute('properties') || '',
    });
  }

  /* ---- spine ---- */
  const spineEl = firstByLocalName(opfDoc, 'spine');
  const spine = [];
  for (const ref of byLocalName(opfDoc, 'itemref')) {
    const item = manifest.get(ref.getAttribute('idref'));
    if (!item || !item.href) continue;
    if (/^(https?:|data:|blob:)/i.test(item.href)) continue;
    spine.push(resolvePath(opfDir, item.href));
  }
  if (!spine.length) throw new Error('这本书没有可显示的章节（spine 为空）');

  /* ---- 目录：EPUB3 nav 优先，其次 EPUB2 NCX ---- */
  let raw = [];

  const navItem = Array.from(manifest.values()).find((item) => /\bnav\b/.test(item.properties));
  if (navItem && navItem.href) {
    raw = await readNav(locate, resolvePath(opfDir, navItem.href));
  }

  if (!raw.length) {
    let ncxPath = '';
    const ncxId = spineEl ? spineEl.getAttribute('toc') : '';
    if (ncxId && manifest.has(ncxId)) {
      ncxPath = resolvePath(opfDir, manifest.get(ncxId).href);
    }
    if (!ncxPath) {
      const guide = byLocalName(opfDoc, 'reference')
        .find((node) => (node.getAttribute('type') || '').toLowerCase() === 'toc');
      if (guide) ncxPath = resolvePath(opfDir, guide.getAttribute('href') || '');
    }
    if (!ncxPath) {
      const alt = Array.from(manifest.values())
        .find((item) => item.mediaType === 'application/x-dtbncx+xml');
      if (alt) ncxPath = resolvePath(opfDir, alt.href);
    }
    if (ncxPath) raw = await readNcx(locate, ncxPath);
  }

  /* ---- 目录条目映射到 spine 下标 ---- */
  const spinePos = new Map();
  spine.forEach((path, index) => {
    if (!spinePos.has(normalizeKey(path))) spinePos.set(normalizeKey(path), index);
  });

  const lookupSpineIndex = (path) => {
    const key = normalizeKey(path);
    if (spinePos.has(key)) return spinePos.get(key);
    const base = key.split('/').pop();
    for (const [spineKey, index] of spinePos) {
      if (spineKey.split('/').pop() === base) return index;
    }
    return null;
  };

  const toc = [];
  const seenEntry = new Set();
  const chaptersWithEntry = new Set();

  for (const entry of raw) {
    if (!entry.href) continue;
    const { path, anchor } = splitHref(entry.href);
    if (!path) continue;                     // 纯 "#anchor" 的条目跳过

    const targetPath = resolvePath(entry.baseDir, path);
    const spineIndex = lookupSpineIndex(targetPath);
    if (spineIndex == null) continue;

    // 同一章的多个小节（#anchor 不同）要保留，只有完全重复的条目才合并
    const key = `${spineIndex}#${anchor}`;
    if (seenEntry.has(key)) continue;
    seenEntry.add(key);
    chaptersWithEntry.add(spineIndex);

    toc.push({
      title: entry.title || `第 ${spineIndex + 1} 章`,
      spineIndex,
      anchor,
      depth: Math.min(entry.depth || 0, 2),
    });
  }

  // 书里完全没提到的章节，补一条兜底标题，保证目录能覆盖全书
  for (let i = 0; i < spine.length; i += 1) {
    if (chaptersWithEntry.has(i)) continue;
    toc.push({ title: `第 ${i + 1} 章`, spineIndex: i, anchor: '', depth: 0 });
  }

  toc.sort((a, b) => a.spineIndex - b.spineIndex);

  return { title, author, spine, toc };
}

/* ============================================================
 *  书架渲染
 * ============================================================ */

function showStorageWarning(error) {
  el.storageWarning.classList.remove('hidden');
  el.storageWarning.innerHTML = '';

  const line1 = document.createElement('div');
  line1.textContent = '本地存储不可用，导入的书只能本次会话有效，关闭页面后会丢失。';

  const line2 = document.createElement('div');
  line2.style.marginTop = '6px';
  line2.textContent = '原因：' + (error && error.message ? error.message : '未知');

  const line3 = document.createElement('div');
  line3.style.marginTop = '6px';
  line3.append(
    document.createTextNode('如果你是直接双击打开 index.html（file:// 协议），请改用本地服务器：在项目目录执行 '),
    Object.assign(document.createElement('code'), { textContent: 'python -m http.server 8000' }),
    document.createTextNode('，然后访问 http://localhost:8000'),
  );

  el.storageWarning.append(line1, line2, line3);
}

function renderLibrary() {
  const books = state.books;
  el.bookList.innerHTML = '';
  el.bookList.classList.toggle('hidden', books.length === 0);
  el.emptyState.classList.toggle('hidden', books.length > 0);

  if (books.length) {
    const fragment = document.createDocumentFragment();
    books.forEach((record) => fragment.appendChild(createBookCard(record)));
    el.bookList.appendChild(fragment);
  }

  const count = books.length;
  el.libSub.textContent = state.storageOk
    ? `本地书库 · 共 ${count} 本 · 文件保存在这台设备的浏览器中`
    : `本地书库 · 共 ${count} 本 · 本次会话有效`;
}

function createBookCard(record) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.dataset.id = record.id;

  const displayTitle = (record.title || record.name || '未命名').trim();

  const cover = document.createElement('div');
  cover.className = 'book-cover';
  const hue = hashHue(record.id);
  cover.style.background =
    `linear-gradient(135deg, hsl(${hue} 62% 64%), hsl(${(hue + 42) % 360} 68% 46%))`;
  cover.textContent = Array.from(displayTitle)[0] || '书';

  const info = document.createElement('div');
  info.className = 'book-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'book-title';
  titleEl.textContent = displayTitle;
  titleEl.title = displayTitle;

  const authorEl = document.createElement('div');
  authorEl.className = 'book-author';
  authorEl.textContent = record.author || '作者未知';

  const bar = document.createElement('div');
  bar.className = 'book-bar';
  const fill = document.createElement('i');
  fill.style.width = progressPercent(record) + '%';
  bar.appendChild(fill);

  const meta = document.createElement('div');
  meta.className = 'book-meta';
  const left = document.createElement('span');
  left.textContent = progressLabel(record);
  const right = document.createElement('span');
  right.textContent = relativeTime(record.lastReadAt || record.addedAt);
  meta.append(left, right);

  info.append(titleEl, authorEl, bar, meta);

  const del = document.createElement('button');
  del.className = 'book-del';
  del.type = 'button';
  del.title = '从书库删除';
  del.textContent = '✕';
  del.addEventListener('click', (event) => {
    event.stopPropagation();
    removeBook(record);
  });

  card.append(cover, info, del);
  card.addEventListener('click', () => openBook(record.id));
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openBook(record.id);
    }
  });

  return card;
}

async function refreshLibrary() {
  try {
    const books = await storage.listBooks();
    books.sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0)
      || (b.addedAt || 0) - (a.addedAt || 0));
    state.books = books;
  } catch (error) {
    console.error('读取书库失败:', error);
    state.books = [];
  }
  renderLibrary();
}

async function removeBook(record) {
  const name = record.title || record.name || '这本书';
  if (!window.confirm(`确定从书库删除《${name}》吗？\n文件会一并从浏览器中移除。`)) return;

  try {
    await storage.deleteBook(record.id);
  } catch (error) {
    window.alert('删除失败：' + error.message);
    return;
  }

  if (state.record && state.record.id === record.id) {
    state.record = null;
    state.zip = null;
    state.locate = null;
    showLibrary();
  } else {
    await refreshLibrary();
  }
}

/* ============================================================
 *  导入
 * ============================================================ */

async function importFiles(fileList) {
  const files = Array.from(fileList).filter((file) => /\.epub$/i.test(file.name));
  if (!files.length) {
    window.alert('请选择 .epub 格式的文件');
    return;
  }

  let last = null;

  for (const file of files) {
    try {
      last = await importOne(file);
    } catch (error) {
      console.error('导入失败:', file.name, error);
      const reason = error && error.name === 'QuotaExceededError'
        ? '浏览器存储空间不足'
        : (error.message || String(error));
      window.alert(`《${file.name}》导入失败：${reason}`);
    }
  }

  await refreshLibrary();

  if (last) await startReading(last.record, last.zip);
}

async function importOne(file) {
  const buffer = await file.arrayBuffer();

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new Error('不是有效的 EPUB 压缩包');
  }

  const index = buildZipIndex(zip);
  const parsed = await parseEpub(makeLocator(zip, index));

  const id = makeBookId(file);
  const existing = await storage.getBook(id);
  const now = Date.now();

  const record = {
    id,
    name: file.name,
    title: parsed.title || file.name.replace(/\.epub$/i, ''),
    author: parsed.author || '',
    size: file.size,
    chapterCount: parsed.spine.length,
    addedAt: existing ? existing.addedAt : now,
    lastReadAt: existing ? existing.lastReadAt : 0,
    progress: existing ? existing.progress : null,
  };

  await storage.saveBook(record, buffer);
  return { record, zip };
}

/* ============================================================
 *  阅读器
 * ============================================================ */

function isRTL() {
  return el.directionSelect.value === 'rtl';
}

function neighbourIndexes() {
  return {
    prev: isRTL() ? state.currentIndex + 1 : state.currentIndex - 1,
    next: isRTL() ? state.currentIndex - 1 : state.currentIndex + 1,
  };
}

function updateButtons() {
  const { prev, next } = neighbourIndexes();

  // 只在到达首/尾时禁用；翻页动画期间不禁用，避免按钮颜色一闪一闪
  el.prevBtn.disabled = prev < 0 || prev >= state.spine.length;
  el.nextBtn.disabled = next < 0 || next >= state.spine.length;

  if (isRTL()) {
    el.prevBtn.textContent = '→ 下一章';
    el.nextBtn.textContent = '← 上一章';
  } else {
    el.prevBtn.textContent = '← 上一章';
    el.nextBtn.textContent = '下一章 →';
  }
}

/* ============================================================
 *  上下工具条：默认隐藏，点屏幕出现
 * ============================================================ */

let chromeTimer = null;

function showChrome(autoHideMs) {
  el.reader.classList.add('chrome-visible');

  if (chromeTimer !== null) {
    clearTimeout(chromeTimer);
    chromeTimer = null;
  }

  if (autoHideMs) {
    chromeTimer = setTimeout(() => {
      chromeTimer = null;
      hideChrome();
    }, autoHideMs);
  }
}

function hideChrome() {
  el.reader.classList.remove('chrome-visible');

  if (chromeTimer !== null) {
    clearTimeout(chromeTimer);
    chromeTimer = null;
  }
}

function toggleChrome() {
  if (el.reader.classList.contains('chrome-visible')) hideChrome();
  else showChrome(0);
}

/* ============================================================
 *  背景主题
 * ============================================================ */

const THEMES = ['light', 'green', 'dark'];

function applyTheme(name) {
  const theme = THEMES.indexOf(name) >= 0 ? name : 'light';
  document.documentElement.setAttribute('data-theme', theme);

  if (el.themePicker) {
    Array.from(el.themePicker.querySelectorAll('.swatch')).forEach((button) => {
      button.classList.toggle('active', button.dataset.themeValue === theme);
    });
  }

  // 让手机浏览器地址栏跟着变色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const color = theme === 'dark' ? '#161617' : (theme === 'green' ? '#d7e8d0' : '#ffffff');
    meta.setAttribute('content', color);
  }

  writeSetting('epub-theme', theme);
}

function showLibrary() {
  closeToc();
  el.reader.classList.add('hidden');
  el.library.classList.remove('hidden');
  el.content.innerHTML = '';
  document.title = 'EPUB 阅读器';

  state.record = null;
  state.zip = null;
  state.locate = null;
  state.spine = [];
  state.toc = [];
  state.currentIndex = -1;

  refreshLibrary();
}

function showReader() {
  el.library.classList.add('hidden');
  el.reader.classList.remove('hidden');
}

async function openBook(id) {
  let record;
  let data;

  try {
    record = await storage.getBook(id);
    if (!record) {
      await refreshLibrary();
      return;
    }
    data = await storage.getFileData(id);
  } catch (error) {
    window.alert('读取书籍失败：' + error.message);
    return;
  }

  if (!data) {
    window.alert('找不到这本书的文件数据，它可能已被浏览器清理，请重新导入。');
    return;
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (error) {
    window.alert('文件已损坏，无法打开，请重新导入。');
    return;
  }

  await startReading(record, zip);
}

async function startReading(record, zip) {
  const index = buildZipIndex(zip);
  let parsed;

  try {
    parsed = await parseEpub(makeLocator(zip, index));
  } catch (error) {
    window.alert('解析 EPUB 失败：' + error.message);
    return;
  }

  state.record = record;
  state.zip = zip;
  state.locate = makeLocator(zip, index);
  state.spine = parsed.spine;
  state.toc = parsed.toc;
  state.currentIndex = -1;
  state.isAnimating = false;

  state.tocTitleBySpine = new Map();
  parsed.toc.forEach((entry) => {
    if (!state.tocTitleBySpine.has(entry.spineIndex)) {
      state.tocTitleBySpine.set(entry.spineIndex, entry.title);
    }
  });

  renderToc();
  updateButtons();
  showReader();
  showChrome(2600);   // 打开时先把工具条亮一下，之后自动隐藏

  const saved = record.progress && Number.isInteger(record.progress.index)
    ? record.progress.index
    : 0;
  const startIndex = clamp(saved, 0, state.spine.length - 1);

  await openChapter(startIndex, { instant: prefersReducedMotion() });
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 把章节里的图片转成 data URL（zip 内资源无法直接引用） */
async function inlineResources(doc, chapterPath) {
  const chapterDir = dirOf(chapterPath);
  const nodes = doc.querySelectorAll('img, image, source, video[poster]');

  for (const node of nodes) {
    const tag = node.localName;
    const raw =
      node.getAttribute('src') ||
      node.getAttribute('xlink:href') ||
      node.getAttribute('href') ||
      node.getAttribute('poster') ||
      node.getAttribute('srcset') ||
      '';

    if (!raw || /^(data:|https?:|blob:|\/\/)/i.test(raw)) continue;

    const first = raw.split(',')[0].trim().split(/\s+/)[0];
    const resolved = resolvePath(chapterDir, first);
    const file = state.locate(resolved);

    if (!file) {
      if (tag === 'img') node.setAttribute('alt', `[图片缺失: ${resolved}]`);
      node.removeAttribute('src');
      node.removeAttribute('xlink:href');
      node.removeAttribute('href');
      continue;
    }

    let base64;
    try {
      base64 = await file.async('base64');
    } catch (error) {
      continue;
    }

    const mime = mimeFromPath(resolved) || 'image/jpeg';
    const dataUrl = `data:${mime};base64,${base64}`;

    if (tag === 'image') {
      node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
      node.setAttribute('href', dataUrl);
    } else if (tag === 'source') {
      node.setAttribute('srcset', dataUrl);
    } else {
      node.setAttribute('src', dataUrl);
    }
  }
}

function updateChapterHeader() {
  const index = state.currentIndex;
  const total = state.spine.length;
  const title = state.tocTitleBySpine.get(index) || `第 ${index + 1} 章`;

  el.chapterTitle.textContent = title;
  el.chapterTitle.title = title;
  el.chapterProgress.textContent = `${index + 1} / ${total}`;

  const bookTitle = state.record ? (state.record.title || 'EPUB 阅读器') : 'EPUB 阅读器';
  document.title = `${title} · ${bookTitle}`;
}

function persistProgress(index) {
  const record = state.record;
  if (!record) return;

  const now = Date.now();
  const patch = {
    progress: { index, total: state.spine.length, updatedAt: now },
    lastReadAt: now,
  };
  Object.assign(record, patch);

  storage.updateBook(record.id, patch).catch((error) => {
    console.warn('保存阅读进度失败:', error);
  });
}

/** 跳到章节内的锚点 */
function scrollToAnchor(layer, anchor) {
  if (!anchor) return;

  const apply = () => {
    let target = null;
    try {
      target = layer.querySelector('#' + CSS.escape(anchor));
    } catch (error) { /* CSS.escape 不可用时忽略 */ }
    if (!target) {
      target = layer.querySelector(`[id="${anchor.replace(/"/g, '\\"')}"]`)
        || layer.querySelector(`a[name="${anchor.replace(/"/g, '\\"')}"]`);
    }
    if (!target) return;

    const offset = target.getBoundingClientRect().top - layer.getBoundingClientRect().top;
    layer.scrollTop = Math.max(0, layer.scrollTop + offset - 10);
  };

  requestAnimationFrame(apply);
  setTimeout(apply, 350);   // 图片撑开高度后再校正一次
}

async function openChapter(index, options) {
  const opts = options || {};

  if (!state.zip) return;
  if (index < 0 || index >= state.spine.length) return;
  if (state.isAnimating && !opts.instant) return;

  const path = state.spine[index];
  const file = state.locate(path);
  if (!file) {
    window.alert('章节文件缺失：' + path);
    return;
  }

  state.isAnimating = true;
  updateButtons();

  let html;
  try {
    html = await file.async('string');
  } catch (error) {
    state.isAnimating = false;
    updateButtons();
    window.alert('章节读取失败：' + error.message);
    return;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  await inlineResources(doc, path);

  const forward = state.currentIndex === -1 ? true : index > state.currentIndex;
  const rtl = isRTL();
  // 翻页时元素朝哪边移动：true = 向右
  const moveRight = forward ? rtl : !rtl;

  const layer = document.createElement('div');
  layer.className = 'page-layer' + (rtl ? ' rtl-layout' : '');
  layer.innerHTML = doc.body ? doc.body.innerHTML : '';

  const oldLayer = el.content.querySelector('.page-layer');

  const commit = () => {
    state.currentIndex = index;
    updateChapterHeader();
    updateButtons();
    syncTocActive();
    persistProgress(index);
  };

  /* ---- 无动画（跳转/减少动态效果） ---- */
  if (opts.instant || prefersReducedMotion()) {
    if (oldLayer) oldLayer.remove();
    el.content.appendChild(layer);
    commit();
    state.isAnimating = false;
    scrollToAnchor(layer, opts.anchor);
    return;
  }

  /* ---- 覆盖式翻页：新页滑入盖住旧页 / 旧页滑开露出新页 ---- */
  const DURATION = 420;
  const EASING = 'cubic-bezier(.32, .72, 0, 1)';
  let mover = layer;

  if (forward) {
    layer.style.transform = `translate3d(${moveRight ? '-100%' : '100%'}, 0, 0)`;
    layer.classList.add('stack-front', 'moving');
    el.content.appendChild(layer);
    void layer.offsetWidth;

    layer.style.transition = `transform ${DURATION}ms ${EASING}`;
    layer.style.transform = 'translate3d(0, 0, 0)';
  } else {
    layer.classList.add('stack-back');
    el.content.appendChild(layer);

    if (oldLayer) {
      oldLayer.classList.add('stack-front', 'moving');
      void oldLayer.offsetWidth;
      oldLayer.style.transition = `transform ${DURATION}ms ${EASING}`;
      oldLayer.style.transform = `translate3d(${moveRight ? '100%' : '-100%'}, 0, 0)`;
      mover = oldLayer;
    }
  }

  commit();

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (oldLayer && oldLayer.parentNode) oldLayer.remove();
      layer.style.transition = '';
      layer.style.transform = '';
      layer.classList.remove('moving', 'stack-front', 'stack-back');
      state.isAnimating = false;
      updateButtons();
      resolve();
    };

    mover.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'transform') finish();
    }, { once: true });
    setTimeout(finish, DURATION + 180);   // 兜底
  });

  scrollToAnchor(layer, opts.anchor);
}

/* ============================================================
 *  目录面板
 * ============================================================ */

function renderToc() {
  el.tocList.innerHTML = '';

  if (!state.toc.length) {
    const empty = document.createElement('div');
    empty.className = 'toc-empty';
    empty.textContent = '这本书没有提供目录';
    el.tocList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  state.toc.forEach((entry, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'toc-item';
    item.dataset.tocIndex = String(index);
    item.dataset.spine = String(entry.spineIndex);
    item.dataset.depth = String(entry.depth || 0);
    item.textContent = entry.title;
    item.title = entry.title;
    fragment.appendChild(item);
  });

  el.tocList.appendChild(fragment);
  syncTocActive();
}

function syncTocActive() {
  const items = el.tocList.querySelectorAll('.toc-item');
  let active = null;

  items.forEach((item) => {
    // 同一章可能有多个小节条目，只高亮第一条
    const isActive = Number(item.dataset.spine) === state.currentIndex && active === null;
    item.classList.toggle('active', isActive);
    if (isActive) active = item;
  });

  if (active && isTocOpen()) {
    try {
      active.scrollIntoView({ block: 'center' });
    } catch (error) {
      active.scrollIntoView();
    }
  }
}

function openToc() {
  el.tocPanel.classList.add('open');
  el.tocMask.classList.add('show');
  showChrome(0);            // 抽屉打开时上方的工具条保持可见
  syncTocActive();
}

function closeToc() {
  el.tocPanel.classList.remove('open');
  el.tocMask.classList.remove('show');
  hideChrome();             // 关闭目录后回到干净的阅读界面
}

function isTocOpen() {
  return el.tocPanel.classList.contains('open');
}

/* ============================================================
 *  事件绑定
 * ============================================================ */

function bindEvents() {
  el.fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length) await importFiles(files);
  });

  el.backBtn.addEventListener('click', showLibrary);

  el.prevBtn.addEventListener('click', () => {
    const { prev } = neighbourIndexes();
    if (prev >= 0 && prev < state.spine.length) openChapter(prev);
  });

  el.nextBtn.addEventListener('click', () => {
    const { next } = neighbourIndexes();
    if (next >= 0 && next < state.spine.length) openChapter(next);
  });

  el.tocBtn.addEventListener('click', () => {
    if (isTocOpen()) closeToc(); else openToc();
  });
  el.tocClose.addEventListener('click', closeToc);
  el.tocMask.addEventListener('click', closeToc);

  el.tocList.addEventListener('click', (event) => {
    const item = event.target.closest('.toc-item');
    if (!item) return;

    const entry = state.toc[Number(item.dataset.tocIndex)];
    if (!entry) return;

    closeToc();
    openChapter(entry.spineIndex, { anchor: entry.anchor });
  });

  /* 阅读方向 */
  el.directionSelect.addEventListener('change', () => {
    writeSetting('epub-direction', el.directionSelect.value);

    const layer = el.content.querySelector('.page-layer');
    if (layer) layer.classList.toggle('rtl-layout', isRTL());

    updateButtons();
    syncTocActive();
  });

  /* 手势：物理方向 → 按钮的固定映射，方向语义由索引函数承担 */
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let deltaY = 0;
  let startTime = 0;
  let tracking = false;
  let suppressClick = false;

  el.content.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1) return;
    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    deltaX = 0;
    deltaY = 0;
    startTime = Date.now();
    tracking = true;
  }, { passive: true });

  el.content.addEventListener('touchmove', (event) => {
    if (!tracking || event.touches.length !== 1) return;
    deltaX = event.touches[0].clientX - startX;
    deltaY = event.touches[0].clientY - startY;
  }, { passive: true });

  el.content.addEventListener('touchend', (event) => {
    if (!tracking) return;
    tracking = false;

    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Date.now() - startTime;

    if (absX > 50 && absX > absY * 1.5) {
      // 滑动翻页：先收起工具条，翻页过程中不闪烁
      hideChrome();
      if (deltaX > 0) el.prevBtn.click();
      else el.nextBtn.click();
      suppressClick = true;
    } else if (absX < 12 && absY < 12 && elapsed < 400) {
      // 轻点屏幕：显示 / 隐藏上下工具条
      const onLink = event.target && event.target.closest && event.target.closest('a');
      if (!onLink) {
        toggleChrome();
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 600);
      }
    }

    deltaX = 0;
    deltaY = 0;
  }, { passive: true });

  /* 桌面端点击空白处也可以切换工具条 */
  el.content.addEventListener('click', (event) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (isTocOpen()) return;
    if (event.target && event.target.closest && event.target.closest('a')) return;
    toggleChrome();
  });

  /* 背景色 */
  if (el.themePicker) {
    el.themePicker.addEventListener('click', (event) => {
      const swatch = event.target.closest('.swatch');
      if (!swatch) return;
      applyTheme(swatch.dataset.themeValue);
    });
  }

  /* 键盘 */
  document.addEventListener('keydown', (event) => {
    if (el.reader.classList.contains('hidden')) return;

    if (event.key === 'Escape') {
      if (isTocOpen()) closeToc();
      else showLibrary();
      return;
    }
    if (event.key === 'ArrowLeft') el.prevBtn.click();
    if (event.key === 'ArrowRight') el.nextBtn.click();
  });

  /* 拖拽导入 */
  let dragDepth = 0;

  const hasFiles = (event) => Boolean(event.dataTransfer)
    && Array.from(event.dataTransfer.types || []).includes('Files');

  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    if (el.library.classList.contains('hidden')) return;
    dragDepth += 1;
    document.body.classList.add('drag-over');
  });

  window.addEventListener('dragover', (event) => {
    // 必须阻止默认行为，否则浏览器会直接打开这个文件
    if (hasFiles(event)) event.preventDefault();
  });

  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('drag-over');
  });

  window.addEventListener('drop', async (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();

    const wasLibrary = !el.library.classList.contains('hidden');
    dragDepth = 0;
    document.body.classList.remove('drag-over');

    if (!wasLibrary) return;   // 阅读中拖入文件：忽略，不打断阅读

    const files = Array.from(event.dataTransfer.files);
    if (files.length) await importFiles(files);
  });

  /* 关闭页面时尽量把进度写下去 */
  window.addEventListener('pagehide', () => {
    if (state.record && state.currentIndex >= 0) {
      persistProgress(state.currentIndex);
    }
  });
}

/* ============================================================
 *  启动
 * ============================================================ */

async function init() {
  applyTheme(readSetting('epub-theme') || 'light');

  const savedDirection = readSetting('epub-direction');
  if (savedDirection === 'rtl' || savedDirection === 'ltr') {
    el.directionSelect.value = savedDirection;
  }

  let dbError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      state.db = await openDatabase();
      state.storageOk = true;
      break;
    } catch (error) {
      dbError = error;
      state.storageOk = false;
      // 上一次异常退出可能留下锁，稍等再试一次
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  if (!state.storageOk) {
    console.warn('IndexedDB 不可用，退回到内存模式:', dbError);
    showStorageWarning(dbError);
  }

  bindEvents();
  await refreshLibrary();
}

init();
