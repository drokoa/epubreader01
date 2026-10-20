/* ============================================================
 *  EPUB Reader - app.js
 *  依赖：全局 JSZip
 * ============================================================ */

let book = null;
let spine = [];
let toc = [];
let opfDir = '';
let currentIndex = 0;
let isAnimating = false;

const fileInput       = document.getElementById('file-input');
const libraryEl       = document.getElementById('library');
const readerEl        = document.getElementById('reader');
const contentEl       = document.getElementById('reader-content');
const titleEl         = document.getElementById('chapter-title');
const prevBtn         = document.getElementById('prev-btn');
const nextBtn         = document.getElementById('next-btn');
const backBtn         = document.getElementById('back-btn');
const directionSelect = document.getElementById('direction-select');

/* ================= 方向与索引 ================= */
function getDirection() { return directionSelect.value; }

function getPrevIndex() {
  return getDirection() === 'rtl' ? currentIndex + 1 : currentIndex - 1;
}
function getNextIndex() {
  return getDirection() === 'rtl' ? currentIndex - 1 : currentIndex + 1;
}

/* ================= 工具 ================= */
function resolveRelative(baseDir, rel) {
  if (!rel) return rel;
  if (/^(https?:|data:|blob:)/i.test(rel)) return rel;

  const path = rel.split(/[?#]/)[0];
  const parts = baseDir.split('/').filter(Boolean);

  if (path.startsWith('/')) return path.slice(1);

  for (const seg of path.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function collectByLocalName(root, name) {
  return Array.from(root.getElementsByTagName('*'))
    .filter(el => el.localName === name);
}

/* ================= 章节渲染 ================= */
async function inlineImages(doc, chapterPath) {
  const chapterDir = chapterPath.includes('/')
    ? chapterPath.slice(0, chapterPath.lastIndexOf('/') + 1)
    : '';

  const nodes = doc.querySelectorAll('img, image, source');
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();
    const rawSrc =
      node.getAttribute('src') ||
      node.getAttribute('xlink:href') ||
      node.getAttribute('href') ||
      node.getAttribute('srcset');

    if (!rawSrc || /^(data:|https?:|blob:)/i.test(rawSrc)) continue;

    const firstSrc = rawSrc.split(',')[0].trim().split(/\s+/)[0];
    const resolved = resolveRelative(chapterDir, firstSrc);
    const imgFile  = book.file(resolved);

    if (!imgFile) {
      node.removeAttribute('src');
      node.removeAttribute('xlink:href');
      if (tag === 'img') node.setAttribute('alt', `[图片缺失: ${resolved}]`);
      continue;
    }

    const blob   = await imgFile.async('blob');
    const base64 = await blobToBase64(blob);

    if (tag === 'image') {
      node.setAttribute('href', base64);
      node.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', base64);
    } else if (tag === 'source') {
      node.setAttribute('srcset', base64);
    } else {
      node.setAttribute('src', base64);
    }
  }
}

async function openChapter(index) {
  if (isAnimating || !book) return;
  if (index < 0 || index >= spine.length) return;

  isAnimating = true;
  updatePageButtons();

  const path = spine[index];
  const file = book.file(path);
  if (!file) {
    isAnimating = false;
    updatePageButtons();
    return;
  }

  const htmlString = await file.async('string');
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');
  await inlineImages(doc, path);

  const isRTL        = getDirection() === 'rtl';
  const goingForward = index > currentIndex;
  const fromRight    = goingForward ? !isRTL : isRTL;

  const newLayer = document.createElement('div');
  newLayer.className = 'page-layer ' + (fromRight ? 'slide-in-right' : 'slide-in-left');
  if (isRTL) newLayer.classList.add('rtl-layout');
  newLayer.innerHTML = doc.body ? doc.body.innerHTML : '';

  const oldLayer = contentEl.querySelector('.page-layer');
  contentEl.appendChild(newLayer);
  void newLayer.offsetWidth;

  currentIndex = index;
  const tocItem = toc.find(t => path === t.href || path.endsWith('/' + t.href));
  titleEl.textContent = tocItem ? tocItem.title : `第 ${currentIndex + 1} 章`;
  updatePageButtons();

  await new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (oldLayer && oldLayer.parentNode) oldLayer.remove();
      isAnimating = false;
      updatePageButtons();
      resolve();
    };

    newLayer.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 500); // 兜底，无 CSS 时也能恢复

    requestAnimationFrame(() => {
      newLayer.classList.add('animate', 'to-center');
      if (oldLayer) {
        oldLayer.classList.add('animate');
        oldLayer.classList.remove('to-center');
        oldLayer.classList.add(fromRight ? 'out-left' : 'out-right');
      }
    });
  });
}

function updatePageButtons() {
  const prev = getPrevIndex();
  const next = getNextIndex();

  prevBtn.disabled = isAnimating || prev < 0 || prev >= spine.length;
  nextBtn.disabled = isAnimating || next < 0 || next >= spine.length;

  if (getDirection() === 'rtl') {
    prevBtn.textContent = '→ 下一章';
    nextBtn.textContent = '← 上一章';
  } else {
    prevBtn.textContent = '← 上一章';
    nextBtn.textContent = '→ 下一章';
  }
}

/* ================= 打开 EPUB ================= */
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const arrayBuffer = await file.arrayBuffer();
    book = await JSZip.loadAsync(arrayBuffer);

    const parser = new DOMParser();

    const container = book.file('META-INF/container.xml');
    if (!container) throw new Error('缺少 container.xml');

    const containerXml = await container.async('string');
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const rootfile     = collectByLocalName(containerDoc, 'rootfile')[0];
    if (!rootfile) throw new Error('container.xml 无 rootfile');

    const opfPath = rootfile.getAttribute('full-path');
    opfDir = opfPath.includes('/')
      ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1)
      : '';

    const opfFile = book.file(opfPath);
    if (!opfFile) throw new Error('找不到 OPF 文件');

    const opfString = await opfFile.async('string');
    const opfDoc    = parser.parseFromString(opfString, 'application/xml');

    const idMap = new Map();
    collectByLocalName(opfDoc, 'item').forEach(item => {
      idMap.set(item.getAttribute('id'), item.getAttribute('href'));
    });

    spine = collectByLocalName(opfDoc, 'itemref')
      .map(ref => {
        const href = idMap.get(ref.getAttribute('idref'));
        return href ? resolveRelative(opfDir, href) : null;
      })
      .filter(Boolean);

    if (spine.length === 0) throw new Error('解析 spine 失败');

    // TOC: EPUB2 NCX
    toc = [];
    const guideToc = collectByLocalName(opfDoc, 'reference')
      .find(el => el.getAttribute('type') === 'toc');

    if (guideToc) {
      const ncxPath = resolveRelative(opfDir, guideToc.getAttribute('href'));
      const ncxFile = book.file(ncxPath);
      if (ncxFile) {
        const ncxXml = await ncxFile.async('string');
        const ncxDoc = parser.parseFromString(ncxXml, 'application/xml');
        collectByLocalName(ncxDoc, 'navPoint').forEach(np => {
          const label   = collectByLocalName(np, 'text')[0]?.textContent;
          const content = collectByLocalName(np, 'content')[0];
          const href    = content?.getAttribute('src');
          if (label && href) {
            toc.push({
              title: label.trim(),
              href:  resolveRelative(opfDir, href),
            });
          }
        });
      }
    }

    // TOC 兜底: EPUB3 nav.xhtml
    if (toc.length === 0) {
      const navItem = collectByLocalName(opfDoc, 'item')
        .find(el => (el.getAttribute('properties') || '').includes('nav'));

      if (navItem) {
        const navPath = resolveRelative(opfDir, navItem.getAttribute('href'));
        const navDir  = navPath.includes('/')
          ? navPath.slice(0, navPath.lastIndexOf('/') + 1)
          : '';
        const navFile = book.file(navPath);
        if (navFile) {
          const navHtml = await navFile.async('string');
          const navDoc  = parser.parseFromString(navHtml, 'text/html');
          navDoc.querySelectorAll('nav a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (href) {
              toc.push({
                title: a.textContent.trim(),
                href:  resolveRelative(navDir, href),
              });
            }
          });
        }
      }
    }

    libraryEl.classList.add('hidden');
    readerEl.classList.remove('hidden');

    currentIndex = -1;
    openChapter(0);

  } catch (err) {
    console.error('解析 EPUB 失败:', err);
    alert('解析 EPUB 失败：' + err.message);
  } finally {
    e.target.value = '';
  }
});

/* ================= 按钮 ================= */
backBtn.addEventListener('click', () => {
  readerEl.classList.add('hidden');
  libraryEl.classList.remove('hidden');
});

prevBtn.addEventListener('click', () => {
  const idx = getPrevIndex();
  if (idx >= 0 && idx < spine.length) openChapter(idx);
});

nextBtn.addEventListener('click', () => {
  const idx = getNextIndex();
  if (idx >= 0 && idx < spine.length) openChapter(idx);
});

/* ================= 方向切换 ================= */
directionSelect.addEventListener('change', () => {
  localStorage.setItem('epub-direction', getDirection());

  const layer = contentEl.querySelector('.page-layer');
  if (layer) layer.classList.toggle('rtl-layout', getDirection() === 'rtl');

  updatePageButtons();
});

const savedDir = localStorage.getItem('epub-direction');
if (savedDir) directionSelect.value = savedDir;

/* ================= 手势 =================
 * 手势层只做「物理方向 → 按钮」固定映射。
 * 方向语义完全由 getPrevIndex/getNextIndex 承担，不再二次反转。
 */
let touchStartX = 0, touchStartY = 0, touchDeltaX = 0, touchDeltaY = 0;
let isTrackingSwipe = false;

contentEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchDeltaX = 0;
  touchDeltaY = 0;
  isTrackingSwipe = true;
}, { passive: true });

contentEl.addEventListener('touchmove', (e) => {
  if (!isTrackingSwipe || e.touches.length !== 1) return;
  touchDeltaX = e.touches[0].clientX - touchStartX;
  touchDeltaY = e.touches[0].clientY - touchStartY;
}, { passive: true });

contentEl.addEventListener('touchend', () => {
  if (!isTrackingSwipe) return;
  isTrackingSwipe = false;

  const absX = Math.abs(touchDeltaX);
  const absY = Math.abs(touchDeltaY);

  if (absX > 50 && absX > absY * 1.5) {
    if (touchDeltaX > 0) prevBtn.click();
    else                 nextBtn.click();
  }

  touchDeltaX = 0;
  touchDeltaY = 0;
}, { passive: true });

/* ================= 键盘 ================= */
document.addEventListener('keydown', (e) => {
  if (readerEl.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft')  prevBtn.click();
  if (e.key === 'ArrowRight') nextBtn.click();
});