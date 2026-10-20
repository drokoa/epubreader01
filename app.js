let book = null;
let spine = [];
let toc = [];
let opfDir = '';
let currentIndex = 0;
let isAnimating = false;

const fileInput = document.getElementById('file-input');
const libraryEl = document.getElementById('library');
const readerEl = document.getElementById('reader');
const contentEl = document.getElementById('reader-content');
const titleEl = document.getElementById('chapter-title');
const prevBtn = document.getElementById('prev-btn');
const nextBtn = document.getElementById('next-btn');
const backBtn = document.getElementById('back-btn');
const directionSelect = document.getElementById('direction-select');

function getDirection() { return directionSelect.value; }
function getPrevIndex() { return getDirection() === 'rtl' ? currentIndex + 1 : currentIndex - 1; }
function getNextIndex() { return getDirection() === 'rtl' ? currentIndex - 1 : currentIndex + 1; }

function normalizePath(path) {
  let result = path.replace('./', '');
  while (result.includes('../')) {
    result = result.replace(/[^\/]+\/\.\.\//, '');
  }
  return result;
}

function findFileInZip(zip, filename) {
  let foundFile = null;
  zip.forEach((relativePath, file) => {
    if (!foundFile && relativePath.endsWith('/' + filename)) {
      foundFile = file;
    }
  });
  return foundFile;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function openChapter(index, direction = 'forward') {
  if (isAnimating || !book) return;
  if (index < 0 || index >= spine.length) return;
  isAnimating = true;

  const path = spine[index];
  const file = book.file(path);
  if (!file) { isAnimating = false; return; }

  const htmlString = await file.async('string');
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');

  const images = doc.querySelectorAll('img, image');
  for (const img of images) {
    let src = img.getAttribute('src') || img.getAttribute('xlink:href');
    if (!src) continue;
    if (src.startsWith('data:')) continue;

    const cleanSrc = src.split('/').pop();
    const imgFile = findFileInZip(book, cleanSrc);
    if (imgFile) {
      const blob = await imgFile.async('blob');
      const base64 = await blobToBase64(blob);
      img.removeAttribute('src');
      img.removeAttribute('xlink:href');
      img.setAttribute('src', base64);
      if (img.tagName.toLowerCase() === 'image') {
        img.setAttribute('xlink:href', base64);
      }
    } else {
      img.removeAttribute('src');
      img.setAttribute('alt', `[图片缺失: ${cleanSrc}]`);
    }
  }

  const isRTL = getDirection() === 'rtl';

// 恢复为 RTL 模式下向右滑下一页
if (touchDeltaX > 0) {
  // 右滑：LTR是上一页，RTL是下一页
  if (isRTL) {
    nextBtn.click();
  } else {
    prevBtn.click();
  }
} else if (touchDeltaX < 0) {
  // 左滑：LTR是下一页，RTL是上一页
  if (isRTL) {
    prevBtn.click();
  } else {
    nextBtn.click();
  }
}

  const newLayer = document.createElement('div');
  newLayer.className = 'page-layer ' + (fromRight ? 'slide-in-right' : 'slide-in-left');
  if (isRTL) newLayer.classList.add('rtl-layout');
  newLayer.innerHTML = doc.body.innerHTML;

  const oldLayer = contentEl.querySelector('.page-layer');
  contentEl.appendChild(newLayer);
  contentEl.scrollTop = 0;

  void newLayer.offsetWidth;

  requestAnimationFrame(() => {
    newLayer.classList.add('animate', 'to-center');
    if (oldLayer) {
      oldLayer.classList.add('animate');
      oldLayer.classList.remove('to-center');
      oldLayer.classList.add(fromRight ? 'out-left' : 'out-right');
    }
  });

  newLayer.addEventListener('transitionend', () => {
    if (oldLayer && oldLayer.parentNode) oldLayer.remove();
    isAnimating = false;
  }, { once: true });

  currentIndex = index;
  const tocItem = toc.find(t => t.href.startsWith(path));
  titleEl.textContent = tocItem ? tocItem.title : `第 ${currentIndex + 1} 章`;
  updatePageButtons();
}

function updatePageButtons() {
  const prev = getPrevIndex();
  const next = getNextIndex();
  prevBtn.disabled = prev < 0 || prev >= spine.length;
  nextBtn.disabled = next < 0 || next >= spine.length;
  
  if (getDirection() === 'rtl') {
    prevBtn.textContent = '→ 下一章';
    nextBtn.textContent = '← 上一章';
  } else {
    prevBtn.textContent = '← 上一章';
    nextBtn.textContent = '→ 下一章';
  }
}

// ================= 文件选择 =================
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const arrayBuffer = await file.arrayBuffer();
    book = await JSZip.loadAsync(arrayBuffer);

    const container = book.file('META-INF/container.xml');
    if (!container) throw new Error('缺少 container.xml');

    const containerXml = await container.async('string');
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');
    const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');

    opfDir = opfPath.includes('/') ? opfPath.split('/').slice(0, -1).join('/') + '/' : '';

    const opfFile = book.file(opfPath);
    if (!opfFile) throw new Error('找不到 content.opf');
    
    const opfString = await opfFile.async('string');
    const opfDoc = parser.parseFromString(opfString, 'application/xml');

    const manifestItems = [...opfDoc.querySelectorAll('manifest item')];
    const idMap = new Map();
    manifestItems.forEach(item => {
      idMap.set(item.getAttribute('id'), item.getAttribute('href'));
    });

    spine = [...opfDoc.querySelectorAll('spine itemref')].map(ref => {
      return normalizePath(idMap.get(ref.getAttribute('idref')));
    }).filter(Boolean);

    toc = [];
    const guide = opfDoc.querySelector('guide reference[type="toc"]');
    if (guide) {
      const tocHref = normalizePath(guide.getAttribute('href'));
      const tocFile = book.file(opfDir + tocHref);
      if (tocFile) {
        const tocXml = await tocFile.async('string');
        const tocDoc = parser.parseFromString(tocXml, 'application/xml');
        tocDoc.querySelectorAll('navPoint').forEach(np => {
          const label = np.querySelector('text')?.textContent;
          const href = np.querySelector('content')?.getAttribute('src');
          if (label && href) toc.push({ title: label, href: normalizePath(href) });
        });
      }
    }

    if (spine.length === 0) throw new Error('解析章节失败');

    libraryEl.classList.add('hidden');
    readerEl.classList.remove('hidden');

    currentIndex = -1;
    openChapter(0, 'forward');

  } catch (err) {
    console.error('解析 EPUB 失败:', err);
    alert('解析 EPUB 失败：' + err.message);
  }
});

// ================= 顶部按钮 =================
backBtn.addEventListener('click', () => {
  readerEl.classList.add('hidden');
  libraryEl.classList.remove('hidden');
});

prevBtn.addEventListener('click', () => {
  const idx = getPrevIndex();
  if (idx >= 0 && idx < spine.length) openChapter(idx, 'back');
});

nextBtn.addEventListener('click', () => {
  const idx = getNextIndex();
  if (idx >= 0 && idx < spine.length) openChapter(idx, 'forward');
});

// ================= 方向切换 =================
directionSelect.addEventListener('change', () => {
  localStorage.setItem('epub-direction', getDirection());
  const layer = contentEl.querySelector('.page-layer');
  if (layer) {
    if (getDirection() === 'rtl') layer.classList.add('rtl-layout');
    else layer.classList.remove('rtl-layout');
  }
  updatePageButtons();
});

const savedDir = localStorage.getItem('epub-direction');
if (savedDir) directionSelect.value = savedDir;

// ================= 手机滑动翻页 =================
let touchStartX = 0, touchStartY = 0, touchDeltaX = 0, touchDeltaY = 0, isTrackingSwipe = false;

contentEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchDeltaX = 0; touchDeltaY = 0;
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
    if (touchDeltaX > 0) {
      getDirection() === 'rtl' ? nextBtn.click() : prevBtn.click();
    } else {
      getDirection() === 'rtl' ? prevBtn.click() : nextBtn.click();
    }
  }
  touchDeltaX = 0; touchDeltaY = 0;
}, { passive: true });

// ================= 键盘翻页 =================
document.addEventListener('keydown', (e) => {
  if (readerEl.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') prevBtn.click();
  if (e.key === 'ArrowRight') nextBtn.click();
});
