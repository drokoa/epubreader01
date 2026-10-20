document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();

    let book;
    let spine = [];
    let toc = [];
    let opfDir = '';
    let currentIndex = 0;

    // 当前翻页方向：ltr=从左往右，rtl=从右往左
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
        return getDirection() === 'ltr' ? currentIndex - 1 : currentIndex + 1;
    }
    function getNextIndex() {
        return getDirection() === 'ltr' ? currentIndex + 1 : currentIndex - 1;
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

            spine = [];
            opfDoc.querySelectorAll('spine itemref').forEach(ref => {
                const id = ref.getAttribute('idref');
                const manifestItem = opfDoc.querySelector(`manifest item[id="${id}"]`);
                if (manifestItem) {
                    spine.push(opfDir + manifestItem.getAttribute('href'));
                }
            });

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

            showChapters();

        } catch (err) {
            console.error('解析 EPUB 失败:', err);
            alert('解析 EPUB 失败，请查看控制台报错');
        }
    };

    reader.readAsArrayBuffer(file);

    // ================= 显示与渲染 =================

    function showChapters() {
        const chaptersList = document.getElementById('chapters');
        const libraryDiv = document.getElementById('library');
        const readerDiv = document.getElementById('reader');

        chaptersList.innerHTML = '';
        spine.forEach((path, index) => {
            const li = document.createElement('li');
            const tocItem = toc.find(t => t.href.startsWith(path));
            li.textContent = tocItem ? tocItem.title : `第 ${index + 1} 章`;
            li.addEventListener('click', () => {
                openChapter(index);
            });
            chaptersList.appendChild(li);
        });

        libraryDiv.style.display = 'block';
        readerDiv.classList.add('hidden');
    }

    async function openChapter(index) {
        if (index === currentIndex) return;

        const path = spine[index];
        if (!path) return;

        const file = book.file(path);
        if (!file) return;

        // 判断翻页方向（用于动画）
        const goingForward = index > currentIndex;

        // 先更新 currentIndex，方便后续按钮状态计算
        currentIndex = index;

        const htmlString = await file.async('string');
        const doc = new DOMParser().parseFromString(htmlString, 'text/html');

        // 处理图片（和之前一样）
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
        const libraryDiv = document.getElementById('library');
        const readerDiv = document.getElementById('reader');
        const chapterTitleEl = document.getElementById('chapter-title');
        const chapterContentEl = document.getElementById('chapter-content');

        libraryDiv.style.display = 'none';
        readerDiv.classList.remove('hidden');

        const tocItem = toc.find(t => t.href.startsWith(path));
        chapterTitleEl.textContent = tocItem ? tocItem.title : `第 ${currentIndex + 1} 章`;

        // ===== 滑动翻页动画 =====
        // 移除旧动画类，强制重绘，再添加新动画类
        chapterContentEl.classList.remove('slide-in-right', 'slide-in-left');
        void chapterContentEl.offsetWidth; // 强制 reflow，让动画重新触发
        chapterContentEl.classList.add(goingForward ? 'slide-in-right' : 'slide-in-left');

        chapterContentEl.innerHTML = bodyContent;

        updatePageButtons();
        readerDiv.scrollTop = 0;
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
            prevBtn.textContent = '下一章 →';
            nextBtn.textContent = '← 上一章';
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

    // ================= 手势翻页 =================

    const readerDiv = document.getElementById('reader');

    let touchStartX = 0;
    let touchStartY = 0;
    let touchDeltaX = 0;
    let touchDeltaY = 0;
    let isTrackingSwipe = false;

    // 触摸开始
    readerDiv.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        touchDeltaX = 0;
        touchDeltaY = 0;
        isTrackingSwipe = true;
    }, { passive: true });

    // 触摸移动
    readerDiv.addEventListener('touchmove', (e) => {
        if (!isTrackingSwipe || e.touches.length !== 1) return;
        touchDeltaX = e.touches[0].clientX - touchStartX;
        touchDeltaY = e.touches[0].clientY - touchStartY;
    }, { passive: true });

    // 触摸结束
    readerDiv.addEventListener('touchend', (e) => {
        if (!isTrackingSwipe) return;
        isTrackingSwipe = false;

        const absX = Math.abs(touchDeltaX);
        const absY = Math.abs(touchDeltaY);

        // 水平滑动阈值：50px，且水平距离必须是垂直距离的1.5倍以上，避免和上下滚动混淆
        if (absX > 50 && absX > absY * 1.5) {
            if (touchDeltaX > 0) {
                // 向右滑
                if (getDirection() === 'rtl') {
                    document.getElementById('next-btn').click();
                } else {
                    document.getElementById('prev-btn').click();
                }
            } else {
                // 向左滑
                if (getDirection() === 'rtl') {
                    document.getElementById('prev-btn').click();
                } else {
                    document.getElementById('next-btn').click();
                }
            }
        }

        touchDeltaX = 0;
        touchDeltaY = 0;
    }, { passive: true });

    // ================= 鼠标拖拽（方便在电脑上测试） =================

    let mouseDown = false;
    let mouseStartX = 0;
    let mouseDeltaX = 0;

    readerDiv.addEventListener('mousedown', (e) => {
        mouseDown = true;
        mouseStartX = e.clientX;
        mouseDeltaX = 0;
    });

    document.addEventListener('mousemove', (e) => {
        if (!mouseDown) return;
        mouseDeltaX = e.clientX - mouseStartX;
    });

    document.addEventListener('mouseup', () => {
        if (!mouseDown) return;
        mouseDown = false;

        const absX = Math.abs(mouseDeltaX);
        if (absX > 50) {
            if (mouseDeltaX > 0) {
                // 向右拖
                if (getDirection() === 'rtl') {
                    document.getElementById('next-btn').click();
                } else {
                    document.getElementById('prev-btn').click();
                }
            } else {
                // 向左拖
                if (getDirection() === 'rtl') {
                    document.getElementById('prev-btn').click();
                } else {
                    document.getElementById('next-btn').click();
                }
            }
        }
        mouseDeltaX = 0;
    });

    // ================= 按钮与键盘 =================

    document.getElementById('back-btn').addEventListener('click', () => {
        document.getElementById('reader').classList.add('hidden');
        document.getElementById('library').style.display = 'block';
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

    document.addEventListener('keydown', (e) => {
        const rDiv = document.getElementById('reader');
        if (rDiv.classList.contains('hidden')) return;
        if (e.key === 'ArrowLeft') document.getElementById('prev-btn').click();
        if (e.key === 'ArrowRight') document.getElementById('next-btn').click();
    });

    // 切换方向时刷新按钮状态
    document.getElementById('direction-select').addEventListener('change', () => {
        localStorage.setItem('epub-direction', getDirection());
        updatePageButtons();
    });

    // 记住上次选择的方向
    const savedDir = localStorage.getItem('epub-direction');
    if (savedDir) document.getElementById('direction-select').value = savedDir;
});