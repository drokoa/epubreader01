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

function getDirection() {
  return directionSelect.value;
}

function getPrevIndex() {
  return getDirection() === 'rtl' ? currentIndex + 1 : currentIndex - 1;
}

function getNextIndex() {
  return getDirection() === 'rtl' ? currentIndex - 1 : currentIndex + 1;
}

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

function updatePageButtons() {
  const prevIdx = getPrevIndex();
  const nextIdx = getNextIndex();
  prevBtn.disabled = prevIdx < 0 || prevIdx >= spine.length;
  nextBtn.disabled = nextIdx < 0 || nextIdx >= spine.length;

  if (getDirection() === 'rtl') {
    prevBtn.textContent = '← 上一章（右）';
    nextBtn.textContent = '下一章（左）→';
  } else {
    prevBtn.textContent = '← 上一章';
    nextBtn.textContent = '下一章 →';
  }
}

async function openChapter(index, direction = 'forward') {
  if (isAnimating || !book) return;
  if (index < 0 || index >= spine.length) return;
  isAnimating = true;

  const path = spine[index];
  const file = book.file(path);
  if (!file) {
    isAnimating = false;
    return;
  }

  const htmlString = await file.async('string');
  const doc = new DOMParser().parseFromString(htmlString, 'text/html');

  // 处理图片：从压缩包读取并转 Base64
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
      console.warn('图片未找到，已跳过：', cleanSrc);
      img.removeAttribute('src');
      img.setAttribute('alt', `[图片缺失: ${cleanSrc}]`);
    }
  }

  const isRTL = getDirection() === 'rtl';

  // 计算新章从哪边进入
  let fromRight = direction === 'forward';
  if (isRTL) fromRight = !fromRight;

  // 找旧层
  const oldLayer = contentEl.querySelector('.page-layer');

  // 创建新层
  const newLayer = document.createElement('div');
  newLayer.className = 'page-layer';
  if (fromRight) {
    newLayer.classList.add('slide-in-right');
  } else {
    newLayer.classList.add('slide-in-left');
  }
  if (isRTL) newLayer.classList.add('rtl-layout');
  newLayer.innerHTML = doc.body.innerHTML;

  contentEl.appendChild(newLayer);
  contentEl.scrollTop = 0;
  currentIndex = index;

  // 强制浏览器先渲染初始位置
  void newLayer.offsetWidth;

  requestAnimationFrame(() => {
    // 新层滑入
    newLayer.classList.add('animate');
    newLayer.classList.remove('slide-in-right', 'slide-in-left');
    newLayer.classList.add('to-center');

    // 旧层滑出
    if (oldLayer) {
      oldLayer.classList.add('animate');
      oldLayer.classList.remove('slide-in-right', 'slide-in-left', 'to-center');
      oldLayer.classList.add(fromRight ? 'out-left' : 'out-right');
    }
  });

  // 动画结束：清理旧层，恢复按钮状态
  newLayer.addEventListener('transitionend', () => {
    if (oldLayer && oldLayer.parentNode) {
      oldLayer.remove();
    }
    isAnimating = false;
    updatePageButtons();
  }, { once: true });

  // 标题
  const tocItem = toc.find(t => t.href.startsWith(path));
  titleEl.textContent = tocItem ? tocItem.title : `第 ${currentIndex + 1} 章`;
}

// ================= EPUB 解析 =================

fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const arrayBuffer = await file.arrayBuffer();
    book = await JSZip.loadAsync(arrayBuffer);

    // 读取 container.xml
    const containerFile = book.file('META-INF/container.xml');
    if (!containerFile) throw new Error('无效的 EPUB 文件，缺少 container.xml');

    const containerXml = await containerFile.async('string');
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, 'application/xml');

    const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
    opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

    // 读取 OPF
    const opfFile = book.file(opfPath);
    const opfXml = await opfFile.async('string');
    const opfDoc = parser.parseFromString(opfXml, 'application/xml');

    // 提取 spine
    spine = [];
    opfDoc.querySelectorAll('spine itemref').forEach(ref => {
      const id = ref.getAttribute('idref');
      const manifestItem = opfDoc.querySelector(`manifest item[id="${id}"]`);
      if (manifestItem) {
        spine.push(opfDir + manifestItem.getAttribute('href'));
      }
    });

    // 提取 TOC
    toc = [];
    const tocItem = opfDoc.querySelector('manifest item[media-type="application/x-dtbncx+xml"]');
    if (tocItem) {
      const tocPath = opfDir + tocItem.getAttribute('href');
      const tocFile = book.file(tocPath);
      if (tocFile) {
        const tocXml = await tocFile.async('string');
        const tocDoc = parser.parseFromString(tocXml, 'application/xml');
        tocDoc.querySelectorAll('navPoint').forEach(np => {
          const text = np.querySelector('text')?.textContent;
          const src = np.querySelector('content')?.getAttribute('src');
          if (text && src) {
            toc.push({ title: text, href: opfDir + normalizePath(src) });
          }
        });
      }
    }

    // 进入阅读页
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
  if (idx >= 0 && idx < spine.length) {
    openChapter(idx, 'back');
  }
});

nextBtn.addEventListener('click', () => {
  const idx = getNextIndex();
  if (idx >= 0 && idx < spine.length) {
    openChapter(idx, 'forward');
  }
});

// ================= 方向切换 =================

directionSelect.addEventListener('change', () => {
  localStorage.setItem('epub-direction', getDirection());
  const layer = contentEl.querySelector('.page-layer');
  if (layer) {
    if (getDirection() === 'rtl') {
      layer.classList.add('rtl-layout');
    } else {
      layer.classList.remove('rtl-layout');
    }
  }
  updatePageButtons();
});

// 恢复上次方向设置
const savedDir = localStorage.getItem('epub-direction');
if (savedDir) {
  directionSelect.value = savedDir;
}

// ================= 手机滑动翻页 =================

let touchStartX = 0;
let touchStartY = 0;
let touchDeltaX = 0;
let touchDeltaY = 0;
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

  // 水平滑动超过 50px，且水平距离为垂直的 1.5 倍以上
  if (absX > 50 && absX > absY * 1.5) {
    const isRTL = getDirection() === 'rtl';

    if (touchDeltaX > 0) {
      // 向右滑
      if (isRTL) {
        nextBtn.click();
      } else {
        prevBtn.click();
      }
    } else {
      // 向左滑
      if (isRTL) {
        prevBtn.click();
      } else {
        nextBtn.click();
      }
    }
  }

  touchDeltaX = 0;
  touchDeltaY = 0;
}, { passive: true });

// ================= 键盘翻页 =================

document.addEventListener('keydown', (e) => {
  if (readerEl.classList.contains('hidden')) return;
  if (e.key === 'ArrowLeft') prevBtn.click();
  if (e.key === 'ArrowRight') nextBtn.click();
});