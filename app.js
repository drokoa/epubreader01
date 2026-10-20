/* =====================================================
   EPUB 阅读器 - app.js
   功能：EPUB 解析、图片内嵌、翻页、滑动、从右往左阅读
   ===================================================== */

document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();

    let book;
    let spine = [];
    let toc = [];
    let opfDir = '';
    let currentIndex = 0;

    // 获取当前阅读方向
    function getDirection() {
        return document.getElementById('direction-select').value;
    }

    // ================= 工具函数 =================

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

    // 根据方向计算“上一页/下一页”对应的章节索引
    function getPrevIndex() {
        return getDirection() === 'rtl' ? currentIndex + 1 : currentIndex - 1;
    }
    function getNextIndex() {
        return getDirection() === 'rtl' ? currentIndex - 1 : currentIndex + 1;
    }

    // ================= EPUB 解析 =================

    reader.onload = async (e) => {
        try {
            book = await JSZip.loadAsync(e.target.result);

            const container = book.file('META-INF/container.xml');
            if (!container) throw new Error('无效的 EPUB 文件');

            const containerXml = await container.async('string');
            const parser = new DOMParser();
            const containerDoc = parser.parseFromString(containerXml, 'application/xml');

            const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
            opfDir = opfPath.includes('/') ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';

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

            // 提取 toc
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

            // 隐藏目录页，进入阅读
            document.getElementById('library').classList.add('hidden');
            document.getElementById('reader').classList.remove('hidden');

            // 默认打开第一章
            openChapter(0);

        } catch (err) {
            console.error('解析 EPUB 失败:', err);
            alert('解析 EPUB 失败，请查看控制台报错');
        }
    };

    reader.readAsArrayBuffer(file);

    // ================= 章节渲染 =================

    async function openChapter(index) {
        if (index === currentIndex && index !== 0) return;

        const path = spine[index];
        if (!path) return;

        const file = book.file(path);
        if (!file) return;

        currentIndex = index;

        const htmlString = await file.async('string');
        const doc = new DOMParser().parseFromString(htmlString, 'text/html');

        // 处理图片：从 zip 读取并转 base64
        const images = doc.querySelectorAll('img, image');
        for (let img of images) {
            let src = img.getAttribute('src') || img.getAttribute('xlink:href');
            if (!src) continue;
            if (src.startsWith('data:')) continue;

            let cleanSrc = src.split('/').pop();
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
                console.warn('图片未找到（已跳过）：', cleanSrc);
                img.removeAttribute('src');
                img.removeAttribute('xlink:href');
                img.setAttribute('alt', `[图片缺失: ${cleanSrc}]`);
            }
        }

        const bodyContent = doc.body.innerHTML;
        const contentEl = document.getElementById('reader-content');
        const titleEl = document.getElementById('chapter-title');

        contentEl.innerHTML = bodyContent;

        const tocItem = toc.find(t => t.href.startsWith(path));
        titleEl.textContent = tocItem ? tocItem.title : `第 ${currentIndex + 1} 章`;

        updatePageButtons();
        contentEl.scrollTop = 0;

        // 应用 RTL 排版
        applyDirection();
    }

    function applyDirection() {
        const contentEl = document.getElementById('reader-content');
        if (getDirection() === 'rtl') {
            contentEl.classList.add('rtl-layout');
        } else {
            contentEl.classList.remove('rtl-layout');
        }
    }

    function updatePageButtons() {
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const prevIdx = getPrevIndex();
        const nextIdx = getNextIndex();

        prevBtn.disabled = prevIdx < 0 || prevIdx >= spine.length;
        nextBtn.disabled = nextIdx < 0 || nextIdx >= spine.length;

        // 按钮文字随方向变化
        if (getDirection() === 'rtl') {
            prevBtn.textContent = '← 上一章（右）';
            nextBtn.textContent = '下一章（左） →';
        } else {
            prevBtn.textContent = '← 上一章';
            nextBtn.textContent = '下一章 →';
        }
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    // ================= 手势滑动（修复 RTL 方向） =================

    let touchStartX = 0;
    let touchStartY = 0;
    let touchDeltaX = 0;
    let touchDeltaY = 0;
    let isTrackingSwipe = false;

    const contentEl = document.getElementById('reader-content');

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

    contentEl.addEventListener('touchend', (e) => {
        if (!isTrackingSwipe) return;
        isTrackingSwipe = false;

        const absX = Math.abs(touchDeltaX);
        const absY = Math.abs(touchDeltaY);

        // 水平滑动阈值 50px，且水平 > 垂直，避免与上下滚动冲突
        if (absX > 50 && absX > absY * 1.5) {
            const isRTL = getDirection() === 'rtl';

            if (touchDeltaX > 0) {
                // 向右滑
                if (isRTL) {
                    document.getElementById('next-btn').click();
                } else {
                    document.getElementById('prev-btn').click();
                }
            } else {
                // 向左滑
                if (isRTL) {
                    document.getElementById('prev-btn').click();
                } else {
                    document.getElementById('next-btn').click();
                }
            }
        }

        touchDeltaX = 0;
        touchDeltaY = 0;
    }, { passive: true });

    // ================= 按钮事件 =================

    document.getElementById('back-btn').addEventListener('click', () => {
        document.getElementById('reader').classList.add('hidden');
        document.getElementById('library').classList.remove('hidden');
    });

    document.getElementById('prev-btn').addEventListener('click', () => {
        const idx = getPrevIndex();
        if (idx >= 0 && idx < spine.length) {
            openChapter(idx);
        }
    });

    document.getElementById('next-btn').addEventListener('click', () => {
        const idx = getNextIndex();
        if (idx >= 0 && idx < spine.length) {
            openChapter(idx);
        }
    });

    // 方向切换
    document.getElementById('direction-select').addEventListener('change', () => {
        localStorage.setItem('epub-direction', getDirection());
        applyDirection();
        updatePageButtons();
    });

    // 键盘方向键
    document.addEventListener('keydown', (e) => {
        const readerEl = document.getElementById('reader');
        if (readerEl.classList.contains('hidden')) return;
        if (e.key === 'ArrowLeft') document.getElementById('prev-btn').click();
        if (e.key === 'ArrowRight') document.getElementById('next-btn').click();
    });

    // 页面加载时恢复方向设置
    const savedDir = localStorage.getItem('epub-direction');
    if (savedDir) {
        document.getElementById('direction-select').value = savedDir;
    }
});