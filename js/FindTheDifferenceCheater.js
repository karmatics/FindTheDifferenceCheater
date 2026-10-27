class FindTheDifferenceCheater {

  async run(env) {
      if (!env || !env.container) {
        throw new Error("[FindTheDifferenceCheater] run() requires an environment object with a valid container.");
      }
      this.env = env;
      this.targetElement = env.container;
      this.targetElement.classList.add('fdr-app-container');

      this.sourceImage = null;
      this.imageSourceUrl = null;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.zoom = 1.0; // 1.0 = 100%

      this.mainDialog = null;
      this.mainImgElement = null;
      this.mainViewport = null;
      this.cropSurface = null;
      this.selectionBox = null;
      this.selectionTooltip = null;
      this.zoomLabel = null;
      this.metaLabel = null;
      this.cropBtn = null;

      this.isCropMode = false;
      this.activeCrop = null; // { x, y, width, height } in natural coords
      this.overlayDialog = null;
      this.overlayViewport = null;
      this.overlayClippedImg = null;
      this.flashInterval = null;
      this.isFlashing = false;
      this.currentOpacity = 0.5; // Default 50% opacity for ease of lining up

      this._buildWelcomeScreen();
      this._initGlobalListeners();
    }
  _buildWelcomeScreen() {
    this.targetElement.innerHTML = '';

    const welcome = document.createElement('div');
    welcome.className = 'fdr-welcome-screen';

    const dropzone = document.createElement('div');
    dropzone.className = 'fdr-dropzone';

    dropzone.innerHTML = `
      <div class="fdr-dropzone-icon">🔍</div>
      <div class="fdr-dropzone-title">Spot-the-Difference Image Comparator</div>
      <div class="fdr-dropzone-subtitle">
        Drag & drop an image here from another web page or your computer,<br>
        paste from clipboard (Ctrl+V), or click to select a file.
      </div>
      <div class="fdr-dropzone-actions">
        <button class="fdr-btn fdr-btn-primary" id="fdr-choose-file-btn">📁 Choose Image File</button>
        <button class="fdr-btn fdr-btn-accent" id="fdr-sample-puzzle-btn">🧩 Load Sample Puzzle</button>
      </div>
    `;

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.style.display = 'none';

    dropzone.addEventListener('click', (e) => {
      if (e.target.closest('#fdr-sample-puzzle-btn')) {
        this.loadSamplePuzzle();
        return;
      }
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        this.loadFile(e.target.files[0]);
      }
    });

    // Drag-over styling
    ['dragenter', 'dragover'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.add('drag-active');
      });
    });

    ['dragleave', 'drop'].forEach(name => {
      dropzone.addEventListener(name, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.classList.remove('drag-active');
      });
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      this.handleDrop(e);
    });

    welcome.appendChild(dropzone);
    welcome.appendChild(fileInput);
    this.targetElement.appendChild(welcome);
    this.welcomeElement = welcome;
  }

  _initGlobalListeners() {
    this._onPaste = (e) => {
      if (e.clipboardData && e.clipboardData.items) {
        for (const item of e.clipboardData.items) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) {
              this.loadFile(file);
              return;
            }
          }
        }
      }
    };
    window.addEventListener('paste', this._onPaste);

    this._onKeyDown = (e) => {
      if (!this.overlayDialog || !this.overlayDialog.element) return;
      const isOverlayActive = document.activeElement && this.overlayDialog.element.contains(document.activeElement);
      if (isOverlayActive || this.overlayDialog.element.classList.contains('uw-active')) {
        const step = e.shiftKey ? 10 : 1;
        if (e.key === 'ArrowLeft') { this.nudgeOverlay(-step, 0); e.preventDefault(); }
        else if (e.key === 'ArrowRight') { this.nudgeOverlay(step, 0); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { this.nudgeOverlay(0, -step); e.preventDefault(); }
        else if (e.key === 'ArrowDown') { this.nudgeOverlay(0, step); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  handleDrop(e) {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      this.loadFile(e.dataTransfer.files[0]);
      return;
    }

    // Try URL or HTML drag from other web page
    const uri = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('URL');
    if (uri && (uri.startsWith('http') || uri.startsWith('data:image/'))) {
      this.loadImageFromUrl(uri);
      return;
    }

    const html = e.dataTransfer.getData('text/html');
    if (html) {
      const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (match && match[1]) {
        this.loadImageFromUrl(match[1]);
        return;
      }
    }

    const text = e.dataTransfer.getData('text/plain');
    if (text && (text.startsWith('http') || text.startsWith('data:image/'))) {
      this.loadImageFromUrl(text.trim());
    }
  }

  loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      this.loadImageFromUrl(ev.target.result, file.name);
    };
    reader.readAsDataURL(file);
  }

  loadImageFromUrl(url, title = 'Puzzle Source Image') {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = async () => {
      if (typeof img.decode === 'function') {
        try { await img.decode(); } catch (_) {}
      }

      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) {
        alert('Image loaded with 0 natural dimensions. Please try another image.');
        return;
      }

      this.sourceImage = img;
      this.imageSourceUrl = url;
      this.naturalWidth = w;
      this.naturalHeight = h;
      this.currentTitle = title;

      if (this.welcomeElement) {
        this.welcomeElement.style.display = 'none';
      }

      this.openMainWindow();
    };

    img.onerror = () => {
      alert('Could not load image from the provided source.');
    };

    img.src = url;
  }

  loadSamplePuzzle() {
    // Generate a side-by-side spot-the-difference puzzle on an HTML5 canvas
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');

    const drawScene = (offsetX, hasDifferences) => {
      // Background Sky & Hills
      const skyGrad = ctx.createLinearGradient(offsetX, 0, offsetX, 260);
      skyGrad.addColorStop(0, '#38bdf8');
      skyGrad.addColorStop(1, '#bae6fd');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(offsetX, 0, 400, 260);

      // Sun
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(offsetX + 330, 60, hasDifferences ? 36 : 28, 0, Math.PI * 2); // Diff 1: Sun size
      ctx.fill();

      // Clouds
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(offsetX + 80, 70, 25, 0, Math.PI * 2);
      ctx.arc(offsetX + 110, 60, 32, 0, Math.PI * 2);
      ctx.arc(offsetX + 140, 70, 22, 0, Math.PI * 2);
      ctx.fill();

      if (!hasDifferences) {
        // Diff 2: Extra small cloud on left only
        ctx.beginPath();
        ctx.arc(offsetX + 220, 90, 16, 0, Math.PI * 2);
        ctx.arc(offsetX + 240, 85, 20, 0, Math.PI * 2);
        ctx.fill();
      }

      // Green Hills
      ctx.fillStyle = '#22c55e';
      ctx.beginPath();
      ctx.arc(offsetX + 120, 380, 200, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#16a34a';
      ctx.beginPath();
      ctx.arc(offsetX + 310, 360, 180, 0, Math.PI * 2);
      ctx.fill();

      // House Body
      ctx.fillStyle = hasDifferences ? '#f97316' : '#ef4444'; // Diff 3: House color orange vs red
      ctx.fillRect(offsetX + 140, 210, 110, 90);

      // Roof
      ctx.fillStyle = '#7c2d12';
      ctx.beginPath();
      ctx.moveTo(offsetX + 130, 210);
      ctx.lineTo(offsetX + 195, 140);
      ctx.lineTo(offsetX + 260, 210);
      ctx.closePath();
      ctx.fill();

      // Door
      ctx.fillStyle = '#451a03';
      ctx.fillRect(offsetX + 180, 245, 30, 55);

      // Window
      ctx.fillStyle = hasDifferences ? '#fef08a' : '#67e8f9'; // Diff 4: Window light on/off
      ctx.fillRect(offsetX + 150, 230, 22, 22);

      // Chimney Smoke
      if (hasDifferences) {
        // Diff 5: Smoke puffs on right house only
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.arc(offsetX + 230, 120, 10, 0, Math.PI * 2);
        ctx.arc(offsetX + 235, 95, 14, 0, Math.PI * 2);
        ctx.fill();
      }

      // Label divider
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 14px monospace';
      ctx.fillText(hasDifferences ? 'PUZZLE B (Differences)' : 'PUZZLE A (Original)', offsetX + 20, 30);
    };

    drawScene(0, false);
    drawScene(400, true);

    // Center divider line
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(400, 0);
    ctx.lineTo(400, 400);
    ctx.stroke();

    this.loadImageFromUrl(canvas.toDataURL('image/png'), 'Sample Spot-the-Difference (5 Differences)');
  }

  openMainWindow() {
    if (this.mainDialog) {
      this.mainDialog.close();
      this.mainDialog = null;
    }
    if (this.overlayDialog) {
      this.overlayDialog.close();
      this.overlayDialog = null;
    }

    const availW = Math.max(300, (window.innerWidth || 1024) - 60);
    const availH = Math.max(200, (window.innerHeight || 768) - 120);

    // Initial Zoom: 100% if fits, otherwise scale down
    const overheadH = 75; // Header (32px) + Toolbar (43px)
    if (this.naturalWidth <= availW && (this.naturalHeight + overheadH) <= availH) {
      this.zoom = 1.0;
    } else {
      const scaleX = availW / this.naturalWidth;
      const scaleY = (availH - overheadH) / this.naturalHeight;
      this.zoom = Math.max(0.2, Math.min(1.0, Math.min(scaleX, scaleY)));
    }

    const initialW = Math.round(this.naturalWidth * this.zoom);
    const initialH = Math.round(this.naturalHeight * this.zoom) + overheadH;

    this.mainDialog = UITools.makeDialog({
      title: `${this.currentTitle || 'Source Image'} (${this.naturalWidth}×${this.naturalHeight})`,
      size: [initialW, initialH],
      position: [30, 40],
      noPadding: true,
      allowTransparency: false,
      allowMaximize: true,
      onResize: () => {
        // Handle dialog manual resizing
      },
      onClose: () => {
        if (this.overlayDialog) {
          this.overlayDialog.close();
          this.overlayDialog = null;
        }
        if (this.welcomeElement) {
          this.welcomeElement.style.display = 'flex';
        }
      }
    });

    const content = this.mainDialog.contentElement;
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.width = '100%';
    content.style.height = '100%';

    // Top Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'fdr-window-toolbar';

    const zoomGroup = document.createElement('div');
    zoomGroup.className = 'fdr-toolbar-group';

    const btn50 = document.createElement('button');
    btn50.className = 'fdr-btn fdr-btn-sm';
    btn50.textContent = '50%';
    btn50.onclick = () => this.setZoom(0.5);

    const btn100 = document.createElement('button');
    btn100.className = 'fdr-btn fdr-btn-sm';
    btn100.textContent = '100%';
    btn100.onclick = () => this.setZoom(1.0);

    const btn200 = document.createElement('button');
    btn200.className = 'fdr-btn fdr-btn-sm';
    btn200.textContent = '200%';
    btn200.onclick = () => this.setZoom(2.0);

    const btnFit = document.createElement('button');
    btnFit.className = 'fdr-btn fdr-btn-sm';
    btnFit.textContent = 'Fit';
    btnFit.onclick = () => this.fitToWindow();

    this.zoomLabel = document.createElement('span');
    this.zoomLabel.className = 'fdr-zoom-label';
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;

    this.metaLabel = document.createElement('span');
    this.metaLabel.className = 'fdr-meta-label';
    this.metaLabel.textContent = `${this.naturalWidth}×${this.naturalHeight}`;

    zoomGroup.append(btn50, btn100, btn200, btnFit, this.zoomLabel, this.metaLabel);

    const actionGroup = document.createElement('div');
    actionGroup.className = 'fdr-toolbar-group';

    this.cropBtn = document.createElement('button');
    this.cropBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
    this.cropBtn.innerHTML = '✂ Crop Region';
    this.cropBtn.title = 'Drag a rectangle over the image to pop out a transparent overlay window';
    this.cropBtn.onclick = () => this.toggleCropMode();

    const newBtn = document.createElement('button');
    newBtn.className = 'fdr-btn fdr-btn-sm';
    newBtn.textContent = '📁 New Image';
    newBtn.onclick = () => {
      this.mainDialog.close();
      if (this.welcomeElement) this.welcomeElement.style.display = 'flex';
    };

    actionGroup.append(this.cropBtn, newBtn);
    toolbar.append(zoomGroup, actionGroup);
    content.appendChild(toolbar);

    // Image Viewport
    this.mainViewport = document.createElement('div');
    this.mainViewport.className = 'fdr-image-viewport';

    this.mainImgElement = document.createElement('img');
    this.mainImgElement.className = 'fdr-main-image';
    this.mainImgElement.src = this.imageSourceUrl;
    this.mainImgElement.style.width = `${Math.round(this.naturalWidth * this.zoom)}px`;
    this.mainImgElement.style.height = `${Math.round(this.naturalHeight * this.zoom)}px`;

    // Crop Surface
    this.cropSurface = document.createElement('div');
    this.cropSurface.className = 'fdr-crop-surface';
    this.cropSurface.style.display = 'none';

    this.selectionBox = document.createElement('div');
    this.selectionBox.className = 'fdr-selection-box';

    this.selectionTooltip = document.createElement('div');
    this.selectionTooltip.className = 'fdr-selection-tooltip';
    this.selectionBox.appendChild(this.selectionTooltip);

    this._bindCropEvents();

    this.mainViewport.appendChild(this.mainImgElement);
    this.mainViewport.appendChild(this.cropSurface);
    this.mainViewport.appendChild(this.selectionBox);
    content.appendChild(this.mainViewport);

    // Automatically enable crop mode initially for immediate convenience
    this.setCropMode(true);
  }

  setZoom(newZoom) {
    this.zoom = Math.max(0.1, Math.min(5.0, newZoom));
    const dispW = Math.round(this.naturalWidth * this.zoom);
    const dispH = Math.round(this.naturalHeight * this.zoom);

    if (this.mainImgElement) {
      this.mainImgElement.style.width = `${dispW}px`;
      this.mainImgElement.style.height = `${dispH}px`;
    }

    if (this.zoomLabel) {
      this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    // Synchronize Overlay Zoom
    this.updateOverlayGeometry();
  }

  fitToWindow() {
    if (!this.mainViewport) return;
    const vpW = Math.max(100, this.mainViewport.clientWidth - 20);
    const vpH = Math.max(100, this.mainViewport.clientHeight - 20);

    const scaleX = vpW / this.naturalWidth;
    const scaleY = vpH / this.naturalHeight;
    this.setZoom(Math.min(scaleX, scaleY));
  }

  setCropMode(enable) {
    this.isCropMode = enable;
    if (this.cropBtn) {
      this.cropBtn.classList.toggle('active', enable);
      this.cropBtn.textContent = enable ? '✕ Cancel Crop' : '✂ Crop Region';
    }
    if (this.cropSurface) {
      this.cropSurface.style.display = enable ? 'block' : 'none';
    }
    if (this.selectionBox) {
      this.selectionBox.style.display = 'none';
    }
  }

  toggleCropMode() {
    this.setCropMode(!this.isCropMode);
  }

  _bindCropEvents() {
    let startX = 0, startY = 0;
    let isDrawing = false;

    const getImgBounds = () => this.mainImgElement.getBoundingClientRect();

    const onPointerDown = (e) => {
      if (!this.isCropMode) return;
      e.preventDefault();
      e.stopPropagation();

      const imgRect = getImgBounds();
      startX = Math.max(0, Math.min(imgRect.width, e.clientX - imgRect.left));
      startY = Math.max(0, Math.min(imgRect.height, e.clientY - imgRect.top));

      isDrawing = true;
      this.selectionBox.style.display = 'block';
      this.selectionBox.style.left = `${imgRect.left + startX}px`;
      this.selectionBox.style.top = `${imgRect.top + startY}px`;
      this.selectionBox.style.width = '0px';
      this.selectionBox.style.height = '0px';
      this.selectionBox.style.position = 'fixed';
    };

    const onPointerMove = (e) => {
      if (!isDrawing) return;
      e.preventDefault();

      const imgRect = getImgBounds();
      const curX = Math.max(0, Math.min(imgRect.width, e.clientX - imgRect.left));
      const curY = Math.max(0, Math.min(imgRect.height, e.clientY - imgRect.top));

      const x = Math.min(startX, curX);
      const y = Math.min(startY, curY);
      const w = Math.abs(curX - startX);
      const h = Math.abs(curY - startY);

      this.selectionBox.style.left = `${imgRect.left + x}px`;
      this.selectionBox.style.top = `${imgRect.top + y}px`;
      this.selectionBox.style.width = `${w}px`;
      this.selectionBox.style.height = `${h}px`;

      const naturalW = Math.round(w / this.zoom);
      const naturalH = Math.round(h / this.zoom);
      this.selectionTooltip.textContent = `${naturalW} × ${naturalH} px`;
    };

    const onPointerUp = (e) => {
      if (!isDrawing) return;
      isDrawing = false;
      this.selectionBox.style.display = 'none';

      const imgRect = getImgBounds();
      const endX = Math.max(0, Math.min(imgRect.width, e.clientX - imgRect.left));
      const endY = Math.max(0, Math.min(imgRect.height, e.clientY - imgRect.top));

      const dispX = Math.min(startX, endX);
      const dispY = Math.min(startY, endY);
      const dispW = Math.abs(endX - startX);
      const dispH = Math.abs(endY - startY);

      // Only crop if dragged area is meaningful (> 15px)
      if (dispW > 15 && dispH > 15) {
        const natX = Math.round(dispX / this.zoom);
        const natY = Math.round(dispY / this.zoom);
        const natW = Math.round(dispW / this.zoom);
        const natH = Math.round(dispH / this.zoom);

        this.openCropOverlayWindow({
          x: Math.max(0, Math.min(this.naturalWidth - 10, natX)),
          y: Math.max(0, Math.min(this.naturalHeight - 10, natY)),
          width: Math.min(this.naturalWidth - natX, natW),
          height: Math.min(this.naturalHeight - natY, natH)
        });

        this.setCropMode(false);
      }
    };

    this.cropSurface.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    this.cropSurface.addEventListener('touchstart', (e) => {
      if (e.touches[0]) onPointerDown(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (e.touches[0]) onPointerMove(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchend', (e) => {
      if (e.changedTouches[0]) onPointerUp(e.changedTouches[0]);
    });
  }

  openCropOverlayWindow(cropRect) {
      this.activeCrop = cropRect;

      if (this.overlayDialog) {
        this.overlayDialog.close();
        this.overlayDialog = null;
      }

      const dispCropW = Math.round(cropRect.width * this.zoom);
      const dispCropH = Math.round(cropRect.height * this.zoom);
      const dlgW = Math.max(260, dispCropW + 4);
      const dlgH = dispCropH + 32 + 40; // Header (32px) + Toolbar (40px)

      // Position overlay offset from main window so it's readily visible
      const mainRect = this.mainDialog ? this.mainDialog.element.getBoundingClientRect() : { left: 40, top: 40 };
      const posX = Math.min(window.innerWidth - dlgW - 20, Math.max(10, mainRect.left + 50));
      const posY = Math.min(window.innerHeight - dlgH - 20, Math.max(10, mainRect.top + 50));

      this.overlayDialog = UITools.makeDialog({
        title: `Overlay Diff [${cropRect.width}×${cropRect.height}]`,
        size: [dlgW, dlgH],
        position: [posX, posY],
        transparent: true,
        noPadding: true,
        allowTransparency: false,
        allowMinimize: true,
        allowMaximize: false,
        onClose: () => {
          this.stopFlashing();
          this.overlayDialog = null;
        }
      });

      this.overlayDialog.element.classList.add('fdr-overlay-dialog');

      const content = this.overlayDialog.contentElement;
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.background = 'transparent';

      // Clipped Viewport Container
      this.overlayViewport = document.createElement('div');
      this.overlayViewport.className = 'fdr-overlay-viewport';
      this.overlayViewport.style.width = `${dispCropW}px`;
      this.overlayViewport.style.height = `${dispCropH}px`;
      this.currentOpacity = 0.5;
      this.overlayViewport.style.opacity = '0.5'; // Start at 50% opacity by default

      this.overlayClippedImg = document.createElement('img');
      this.overlayClippedImg.className = 'fdr-overlay-clipped-img';
      this.overlayClippedImg.src = this.imageSourceUrl;

      this.overlayViewport.appendChild(this.overlayClippedImg);
      content.appendChild(this.overlayViewport);

      // Overlay Bottom Controls: Diff Button, Opacity Presets, Flash, Nudge
      const toolbar = document.createElement('div');
      toolbar.className = 'fdr-overlay-toolbar';

      // Action button to extract differences
      const diffBtn = document.createElement('button');
      diffBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-primary';
      diffBtn.innerHTML = '🔍 Generate Diff';
      diffBtn.title = 'Extract differences between this overlay and the underlying image into a clean image window';
      diffBtn.onclick = () => this.generateDiffWindow();

      const flashBtn = document.createElement('button');
      flashBtn.className = 'fdr-btn fdr-btn-sm';
      flashBtn.innerHTML = '⚡ Flash';
      flashBtn.title = 'Blink overlay between transparent and opaque';
      flashBtn.onclick = () => this.toggleFlash(flashBtn);

      // Opacity presets (50% is highlighted as active default)
      const opGroup = document.createElement('div');
      opGroup.className = 'fdr-toolbar-group';
      [25, 50, 75, 100].forEach(pct => {
        const b = document.createElement('button');
        b.className = `fdr-btn fdr-btn-sm${pct === 50 ? ' active' : ''}`;
        b.textContent = `${pct}%`;
        b.onclick = () => {
          this.stopFlashing();
          flashBtn.classList.remove('active');
          opGroup.querySelectorAll('button').forEach(btn => btn.classList.remove('active'));
          b.classList.add('active');
          this.setOverlayOpacity(pct / 100);
        };
        opGroup.appendChild(b);
      });

      // 1-pixel Nudge buttons
      const nudgeGrid = document.createElement('div');
      nudgeGrid.className = 'fdr-nudge-grid';
      nudgeGrid.title = 'Nudge overlay 1px (or select window and use keyboard Arrow keys)';

      const nUp = document.createElement('button');
      nUp.className = 'fdr-nudge-btn';
      nUp.textContent = '▲';
      nUp.style.gridColumn = '2';
      nUp.onclick = () => this.nudgeOverlay(0, -1);

      const nLeft = document.createElement('button');
      nLeft.className = 'fdr-nudge-btn';
      nLeft.textContent = '◀';
      nLeft.style.gridColumn = '1';
      nLeft.style.gridRow = '2';
      nLeft.onclick = () => this.nudgeOverlay(-1, 0);

      const nDown = document.createElement('button');
      nDown.className = 'fdr-nudge-btn';
      nDown.textContent = '▼';
      nDown.style.gridColumn = '2';
      nDown.style.gridRow = '2';
      nDown.onclick = () => this.nudgeOverlay(0, 1);

      const nRight = document.createElement('button');
      nRight.className = 'fdr-nudge-btn';
      nRight.textContent = '▶';
      nRight.style.gridColumn = '3';
      nRight.style.gridRow = '2';
      nRight.onclick = () => this.nudgeOverlay(1, 0);

      nudgeGrid.append(nUp, nLeft, nDown, nRight);

      toolbar.append(diffBtn, opGroup, flashBtn, nudgeGrid);
      content.appendChild(toolbar);

      this.updateOverlayGeometry();
      // Steady 50% opacity by default without blinking
    }
  updateOverlayGeometry() {
    if (!this.overlayDialog || !this.activeCrop || !this.overlayViewport || !this.overlayClippedImg) {
      return;
    }

    const { x, y, width, height } = this.activeCrop;
    const dispCropW = Math.round(width * this.zoom);
    const dispCropH = Math.round(height * this.zoom);

    this.overlayViewport.style.width = `${dispCropW}px`;
    this.overlayViewport.style.height = `${dispCropH}px`;

    // Position source image inside the crop viewport
    const totalDispW = Math.round(this.naturalWidth * this.zoom);
    const totalDispH = Math.round(this.naturalHeight * this.zoom);
    const offX = Math.round(-x * this.zoom);
    const offY = Math.round(-y * this.zoom);

    this.overlayClippedImg.style.width = `${totalDispW}px`;
    this.overlayClippedImg.style.height = `${totalDispH}px`;
    this.overlayClippedImg.style.left = `${offX}px`;
    this.overlayClippedImg.style.top = `${offY}px`;

    // Update outer dialog dimension
    const targetDlgW = Math.max(200, dispCropW + 4);
    const targetDlgH = dispCropH + 32 + 36;
    this.overlayDialog.element.style.width = `${targetDlgW}px`;
    this.overlayDialog.element.style.height = `${targetDlgH}px`;
  }

  setOverlayOpacity(val) {
    this.currentOpacity = Math.max(0, Math.min(1, val));
    if (this.overlayViewport) {
      this.overlayViewport.style.opacity = `${this.currentOpacity}`;
    }
  }

  toggleFlash(btn) {
    if (this.isFlashing) {
      this.stopFlashing();
      if (btn) btn.classList.remove('active');
    } else {
      this.startFlashing(btn);
    }
  }

  startFlashing(btn) {
    this.stopFlashing();
    this.isFlashing = true;
    if (btn) btn.classList.add('active');

    let state = false;
    this.flashInterval = setInterval(() => {
      state = !state;
      if (this.overlayViewport) {
        this.overlayViewport.style.opacity = state ? '1.0' : '0.08';
      }
    }, 600);
  }

  stopFlashing() {
    if (this.flashInterval) {
      clearInterval(this.flashInterval);
      this.flashInterval = null;
    }
    this.isFlashing = false;
    if (this.overlayViewport) {
      this.overlayViewport.style.opacity = `${this.currentOpacity}`;
    }
  }

  nudgeOverlay(dx, dy) {
    if (!this.overlayDialog || !this.overlayDialog.element) return;
    const curLeft = parseFloat(this.overlayDialog.element.style.left) || 0;
    const curTop = parseFloat(this.overlayDialog.element.style.top) || 0;
    this.overlayDialog.element.style.left = `${curLeft + dx}px`;
    this.overlayDialog.element.style.top = `${curTop + dy}px`;
  }

  destroy() {
    this.stopFlashing();
    window.removeEventListener('paste', this._onPaste);
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.overlayDialog) this.overlayDialog.close();
    if (this.mainDialog) this.mainDialog.close();
  }

  generateDiffWindow() {
      if (!this.overlayViewport || !this.mainImgElement || !this.activeCrop || !this.sourceImage) {
        alert('Please select and position an overlay region first.');
        return;
      }

      // Determine current geometry of the overlay relative to the main image
      const overlayRect = this.overlayViewport.getBoundingClientRect();
      const mainRect = this.mainImgElement.getBoundingClientRect();

      const relX = (overlayRect.left - mainRect.left) / this.zoom;
      const relY = (overlayRect.top - mainRect.top) / this.zoom;

      const w = this.activeCrop.width;
      const h = this.activeCrop.height;
      const topX = this.activeCrop.x;
      const topY = this.activeCrop.y;

      // Capture Top (Crop) Image pixel data
      const topCanvas = document.createElement('canvas');
      topCanvas.width = w;
      topCanvas.height = h;
      const topCtx = topCanvas.getContext('2d', { willReadFrequently: true });
      topCtx.drawImage(this.sourceImage, topX, topY, w, h, 0, 0, w, h);
      const topData = topCtx.getImageData(0, 0, w, h);

      // Capture Bottom (Underlying) Image pixel data
      const underCanvas = document.createElement('canvas');
      underCanvas.width = w;
      underCanvas.height = h;
      const underCtx = underCanvas.getContext('2d', { willReadFrequently: true });
      underCtx.drawImage(this.sourceImage, relX, relY, w, h, 0, 0, w, h);
      const underData = underCtx.getImageData(0, 0, w, h);

      // Create the destination diff canvas
      const diffCanvas = document.createElement('canvas');
      diffCanvas.width = w;
      diffCanvas.height = h;
      diffCanvas.className = 'fdr-diff-canvas';
      const diffCtx = diffCanvas.getContext('2d');

      let currentTolerance = 22; // Default color difference threshold
      let currentMode = 'artwork'; // 'artwork' | 'heatmap' | 'delta'
      let currentBgColor = '#ffffff';
      let isCheckerboard = false;

      const renderPixels = () => {
        this._computeDiffCanvas(diffCtx, topData, underData, w, h, currentTolerance, currentMode);
      };

      // Calculate initial dialog dimensions
      const dlgW = Math.max(340, Math.min(window.innerWidth - 60, Math.round(w * this.zoom) + 40));
      const dlgH = Math.min(window.innerHeight - 80, Math.round(h * this.zoom) + 120);

      const diffDialog = UITools.makeDialog({
        title: `Difference Inspector (${w}×${h})`,
        size: [dlgW, dlgH],
        position: [Math.min(window.innerWidth - dlgW - 30, Math.max(20, overlayRect.right + 20)), Math.max(30, overlayRect.top)],
        noPadding: true,
        allowTransparency: false,
        allowMaximize: true
      });

      const content = diffDialog.contentElement;
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.width = '100%';
      content.style.height = '100%';

      // Toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'fdr-diff-toolbar';

      // Sensitivity / Tolerance Slider
      const sliderGroup = document.createElement('div');
      sliderGroup.className = 'fdr-slider-group';
      sliderGroup.title = 'Adjust sensitivity: higher values ignore minor color compression noise';
      const sliderLabel = document.createElement('span');
      sliderLabel.textContent = `Tol: ${currentTolerance}`;
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '4';
      slider.max = '80';
      slider.value = `${currentTolerance}`;
      slider.oninput = (e) => {
        currentTolerance = parseInt(e.target.value, 10);
        sliderLabel.textContent = `Tol: ${currentTolerance}`;
        renderPixels();
      };
      sliderGroup.append(sliderLabel, slider);

      // Mode Selector
      const modeSelect = document.createElement('select');
      modeSelect.className = 'fdr-select-sm';
      modeSelect.title = 'Choose display mode for changed pixels';
      modeSelect.innerHTML = `
        <option value="artwork">Extracted Artwork</option>
        <option value="heatmap">Neon Heatmap</option>
        <option value="delta">Difference Mask</option>
      `;
      modeSelect.onchange = (e) => {
        currentMode = e.target.value;
        renderPixels();
      };

      // Background Color Controls
      const bgGroup = document.createElement('div');
      bgGroup.className = 'fdr-toolbar-group';
      bgGroup.title = 'Change background behind transparent pixels';

      const colorPicker = document.createElement('input');
      colorPicker.type = 'color';
      colorPicker.value = '#ffffff';
      colorPicker.style.width = '24px';
      colorPicker.style.height = '20px';
      colorPicker.style.border = 'none';
      colorPicker.style.cursor = 'pointer';
      colorPicker.style.background = 'transparent';

      const viewportWrap = document.createElement('div');
      viewportWrap.className = 'fdr-diff-viewport-wrap';

      const setBg = (color, checker = false) => {
        isCheckerboard = checker;
        if (checker) {
          viewportWrap.classList.add('fdr-checkerboard');
        } else {
          viewportWrap.classList.remove('fdr-checkerboard');
          viewportWrap.style.backgroundColor = color;
        }
        currentBgColor = color;
        colorPicker.value = color.startsWith('#') ? color : '#ffffff';
      };

      colorPicker.oninput = (e) => setBg(e.target.value, false);

      const swatches = [
        { color: '#ffffff', title: 'White' },
        { color: '#0f172a', title: 'Dark' },
        { color: '#ff007f', title: 'Magenta' },
        { color: '#00ff66', title: 'Green' },
        { color: 'checker', title: 'Checkerboard (Transparent)', checker: true }
      ];

      const swatchesContainer = document.createElement('div');
      swatchesContainer.className = 'fdr-color-swatches';
      swatches.forEach(sw => {
        const btn = document.createElement('button');
        btn.className = 'fdr-color-swatch';
        btn.title = sw.title;
        if (sw.checker) {
          btn.style.background = 'repeating-conic-gradient(#94a3b8 0% 25%, #ffffff 0% 50%) 50% / 6px 6px';
        } else {
          btn.style.backgroundColor = sw.color;
        }
        btn.onclick = () => setBg(sw.color, !!sw.checker);
        swatchesContainer.appendChild(btn);
      });

      bgGroup.append(swatchesContainer, colorPicker);

      // Save / Copy Button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'fdr-btn fdr-btn-sm';
      copyBtn.innerHTML = '📋 Copy Image';
      copyBtn.title = 'Copy transparent difference image to clipboard';
      copyBtn.onclick = async () => {
        try {
          diffCanvas.toBlob(async (blob) => {
            if (!blob) return;
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            const orig = copyBtn.innerHTML;
            copyBtn.innerHTML = '✓ Copied!';
            setTimeout(() => { copyBtn.innerHTML = orig; }, 1500);
          });
        } catch (err) {
          // Fallback: download PNG
          const link = document.createElement('a');
          link.download = `diff-${w}x${h}.png`;
          link.href = diffCanvas.toDataURL('image/png');
          link.click();
        }
      };

      toolbar.append(sliderGroup, modeSelect, bgGroup, copyBtn);
      content.appendChild(toolbar);

      viewportWrap.appendChild(diffCanvas);
      content.appendChild(viewportWrap);

      // Initial render
      renderPixels();
    }

  _computeDiffCanvas(ctx, topData, underData, w, h, tolerance, mode) {
      const output = ctx.createImageData(w, h);
      const dTop = topData.data;
      const dUnder = underData.data;
      const dOut = output.data;

      // Transition window for smooth anti-aliased edges
      const minThreshold = Math.max(1, tolerance * 0.65);
      const maxThreshold = tolerance * 1.35;
      const range = Math.max(1, maxThreshold - minThreshold);

      for (let i = 0; i < dTop.length; i += 4) {
        const r1 = dTop[i];
        const g1 = dTop[i + 1];
        const b1 = dTop[i + 2];
        const a1 = dTop[i + 3];

        const r2 = dUnder[i];
        const g2 = dUnder[i + 1];
        const b2 = dUnder[i + 2];
        const a2 = dUnder[i + 3];

        if (a1 === 0 || a2 === 0) {
          dOut[i + 3] = 0;
          continue;
        }

        // Perceptually-weighted Euclidean color distance
        const dr = r1 - r2;
        const dg = g1 - g2;
        const db = b1 - b2;
        const dist = Math.sqrt(0.299 * dr * dr + 0.587 * dg * dg + 0.114 * db * db);

        if (dist <= minThreshold) {
          // Unchanged pixel -> transparent
          dOut[i] = 0;
          dOut[i + 1] = 0;
          dOut[i + 2] = 0;
          dOut[i + 3] = 0;
        } else {
          // Smooth transition alpha
          let alphaFactor = (dist - minThreshold) / range;
          if (alphaFactor > 1) alphaFactor = 1;
          const outAlpha = Math.round(alphaFactor * 255);

          if (mode === 'artwork') {
            // Keep original top image colors
            dOut[i] = r1;
            dOut[i + 1] = g1;
            dOut[i + 2] = b1;
            dOut[i + 3] = outAlpha;
          } else if (mode === 'heatmap') {
            // Neon highlight color (bright magenta/coral)
            dOut[i] = 255;
            dOut[i + 1] = Math.round(Math.min(255, dist * 3));
            dOut[i + 2] = 60;
            dOut[i + 3] = outAlpha;
          } else if (mode === 'delta') {
            // Amplified delta difference
            const amp = Math.min(255, Math.round(dist * 4));
            dOut[i] = amp;
            dOut[i + 1] = amp;
            dOut[i + 2] = amp;
            dOut[i + 3] = outAlpha;
          }
        }
      }

      ctx.putImageData(output, 0, 0);
    }
}

globalThis.FindTheDifferenceCheater = FindTheDifferenceCheater;
if (typeof module !== 'undefined' && module.exports) module.exports = FindTheDifferenceCheater;