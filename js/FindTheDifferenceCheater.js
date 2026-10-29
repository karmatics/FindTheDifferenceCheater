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
    this.zoom = 1.0;

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
    this.activeCrop = null;
    this.overlayDialog = null;
    this.overlayViewport = null;
    this.overlayClippedImg = null;
    this.flashInterval = null;
    this.isFlashing = false;
    this.currentOpacity = 0.5;

    // Scrolling Stripes Mode properties
    this.isStripesMode = false;
    this.stripeWidth = 50;
    this.stripeSpeed = 45;
    this.stripeOffset = 0;
    this.stripeRunning = false;
    this.stripeDirection = 1;
    this.stripeRafId = null;

    // Difference Circles State (Z-Order is array order)
    this.diffCircles = []; // Array of { id, cropX, cropY, radius, baseOriginX, baseOriginY, dragX, dragY, color }
    this.selectedDiffId = null;
    this.isCircleDiffMode = false;
    this.circleDrawSurface = null;
    this.overlaySvgLayer = null;
    this.solutionDialog = null;

    // Solution Canvas Appearance & Customization Settings
    this.solutionDarken = 0.35;
    this.solutionBlur = 4;
    this.solutionOutlineColor = '#00e676';
    this.solutionOutlineWidth = 3;
    this.solutionShowLabels = false; // Kept off by default for clean screen captures
    this.solutionConnectorStyle = 'tangents'; // 2 outermost dashed tangent lines
    this.solutionBlendAnchor = true; // 50/50 superimposition within original dashed circle

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
      <div class="fdr-dropzone-title">Spot-the-Difference Comparator & Solution Studio</div>
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
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (this.diffCircles.length > 0) {
          this.undoLastDiff();
          e.preventDefault();
        }
      }

      if (this.solutionDialog && this.selectedDiffId) {
        if (e.key === ']' && !e.shiftKey) { this.moveSelectedDiffLayer(1); e.preventDefault(); }
        else if (e.key === '[' && !e.shiftKey) { this.moveSelectedDiffLayer(-1); e.preventDefault(); }
        else if (e.key === ']' && e.shiftKey) { this.moveSelectedDiffLayer(999); e.preventDefault(); }
        else if (e.key === '[' && e.shiftKey) { this.moveSelectedDiffLayer(-999); e.preventDefault(); }
        else if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelectedDiff(); e.preventDefault(); }
      }
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  handleDrop(e) {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      this.loadFile(e.dataTransfer.files[0]);
      return;
    }

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
      this.diffCircles = [];
      this.selectedDiffId = null;

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
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');

    const drawScene = (offsetX, hasDifferences) => {
      const skyGrad = ctx.createLinearGradient(offsetX, 0, offsetX, 260);
      skyGrad.addColorStop(0, '#38bdf8');
      skyGrad.addColorStop(1, '#bae6fd');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(offsetX, 0, 400, 260);

      // Sun
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.arc(offsetX + 330, 60, hasDifferences ? 36 : 28, 0, Math.PI * 2);
      ctx.fill();

      // Clouds
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(offsetX + 80, 70, 25, 0, Math.PI * 2);
      ctx.arc(offsetX + 110, 60, 32, 0, Math.PI * 2);
      ctx.arc(offsetX + 140, 70, 22, 0, Math.PI * 2);
      ctx.fill();

      if (!hasDifferences) {
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
      ctx.fillStyle = hasDifferences ? '#f97316' : '#ef4444';
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
      ctx.fillStyle = hasDifferences ? '#fef08a' : '#67e8f9';
      ctx.fillRect(offsetX + 150, 230, 22, 22);

      // Chimney Smoke
      if (hasDifferences) {
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.beginPath();
        ctx.arc(offsetX + 230, 120, 10, 0, Math.PI * 2);
        ctx.arc(offsetX + 235, 95, 14, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 14px monospace';
      ctx.fillText(hasDifferences ? 'PUZZLE B (Differences)' : 'PUZZLE A (Original)', offsetX + 20, 30);
    };

    drawScene(0, false);
    drawScene(400, true);

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

    const overheadH = 75;
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
      onClose: () => {
        if (this.overlayDialog) {
          this.overlayDialog.close();
          this.overlayDialog = null;
        }
        if (this.solutionDialog) {
          this.solutionDialog.close();
          this.solutionDialog = null;
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
    this.cropBtn.title = 'Drag a rectangle over one puzzle image to pop out the overlay comparator';
    this.cropBtn.onclick = () => this.toggleCropMode();

    const solBtn = document.createElement('button');
    solBtn.className = 'fdr-btn fdr-btn-sm';
    solBtn.innerHTML = '🎨 Solution Studio';
    solBtn.onclick = () => this.openSolutionStudio();

    const newBtn = document.createElement('button');
    newBtn.className = 'fdr-btn fdr-btn-sm';
    newBtn.textContent = '📁 New Image';
    newBtn.onclick = () => {
      this.mainDialog.close();
      if (this.welcomeElement) this.welcomeElement.style.display = 'flex';
    };

    actionGroup.append(this.cropBtn, solBtn, newBtn);
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

    this.updateOverlayGeometry();
    this.renderDiffMarkers();
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
    const dlgW = Math.max(340, dispCropW + 4);
    const dlgH = dispCropH + 32 + 46;

    const mainRect = this.mainDialog ? this.mainDialog.element.getBoundingClientRect() : { left: 40, top: 40 };
    const posX = Math.min(window.innerWidth - dlgW - 20, Math.max(10, mainRect.left + 50));
    const posY = Math.min(window.innerHeight - dlgH - 20, Math.max(10, mainRect.top + 50));

    this.overlayDialog = UITools.makeDialog({
      title: `Overlay [${cropRect.width}×${cropRect.height}]`,
      size: [dlgW, dlgH],
      position: [posX, posY],
      contentTransparent: true,
      noPadding: true,
      allowTransparency: false,
      allowMinimize: true,
      allowMaximize: false,
      onClose: () => {
        this.stopFlashing();
        this.stopStripes();
        this.setCircleDiffMode(false);
        this.overlayDialog = null;
      }
    });

    this.overlayDialog.element.classList.add('fdr-overlay-dialog');

    const content = this.overlayDialog.contentElement;
    content.style.display = 'flex';
    content.style.flexDirection = 'column';
    content.style.background = 'transparent';

    this.overlayViewport = document.createElement('div');
    this.overlayViewport.className = 'fdr-overlay-viewport';
    this.overlayViewport.style.width = `${dispCropW}px`;
    this.overlayViewport.style.height = `${dispCropH}px`;
    this.overlayViewport.style.background = 'transparent';

    this.overlayClippedImg = document.createElement('img');
    this.overlayClippedImg.className = 'fdr-overlay-clipped-img';
    this.overlayClippedImg.src = this.imageSourceUrl;
    this.currentOpacity = 0.5;
    this.overlayClippedImg.style.opacity = '0.5';

    this.overlaySvgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlaySvgLayer.setAttribute('class', 'fdr-diff-svg-layer');

    this.circleDrawSurface = document.createElement('div');
    this.circleDrawSurface.className = 'fdr-circle-draw-surface';

    this.overlayViewport.append(this.overlayClippedImg, this.overlaySvgLayer, this.circleDrawSurface);
    content.appendChild(this.overlayViewport);

    // Overlay Bottom Controls
    const toolbar = document.createElement('div');
    toolbar.className = 'fdr-overlay-toolbar';

    const stripeToolbar = document.createElement('div');
    stripeToolbar.className = 'fdr-stripe-toolbar';

    const stripesBtn = document.createElement('button');
    stripesBtn.className = 'fdr-btn fdr-btn-sm';
    stripesBtn.innerHTML = '▤ Stripes';

    const flashBtn = document.createElement('button');
    flashBtn.className = 'fdr-btn fdr-btn-sm';
    flashBtn.innerHTML = '⚡ Flash';

    const opacityGroup = document.createElement('div');
    opacityGroup.className = 'fdr-opacity-group fdr-opacity-active';

    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0';
    opacitySlider.max = '100';
    opacitySlider.value = '50';

    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'fdr-opacity-lbl';
    opacityLabel.textContent = '50%';

    const btn100 = document.createElement('button');
    btn100.className = 'fdr-btn fdr-btn-sm';
    btn100.textContent = '100%';
    btn100.onclick = () => {
      this.activateOpacityMode(opacityGroup, stripesBtn, flashBtn, stripeToolbar);
      opacitySlider.value = '100';
      opacityLabel.textContent = '100%';
      this.setOverlayOpacity(1.0);
    };

    const activateOpacity = () => {
      this.activateOpacityMode(opacityGroup, stripesBtn, flashBtn, stripeToolbar);
    };

    opacitySlider.oninput = (e) => {
      activateOpacity();
      const val = parseInt(e.target.value, 10);
      opacityLabel.textContent = `${val}%`;
      this.setOverlayOpacity(val / 100);
    };

    opacitySlider.addEventListener('click', () => {
      activateOpacity();
      if (Math.abs(parseInt(opacitySlider.value, 10) - 50) < 12) {
        opacitySlider.value = '50';
        opacityLabel.textContent = '50%';
        this.setOverlayOpacity(0.5);
      }
    });

    opacityLabel.onclick = () => {
      activateOpacity();
      opacitySlider.value = '50';
      opacityLabel.textContent = '50%';
      this.setOverlayOpacity(0.5);
    };

    opacityGroup.append(opacitySlider, opacityLabel);

    stripesBtn.onclick = () => {
      this.stopFlashing();
      flashBtn.classList.remove('active');
      stripesBtn.classList.add('active');
      opacityGroup.classList.remove('fdr-opacity-active');
      opacityGroup.classList.add('fdr-opacity-inactive');
      stripeToolbar.style.display = 'flex';
      this.startStripes();
    };

    flashBtn.onclick = () => {
      this.stopStripes();
      stripesBtn.classList.remove('active');
      stripeToolbar.style.display = 'none';
      if (this.isFlashing) {
        this.stopFlashing();
        flashBtn.classList.remove('active');
        this.activateOpacityMode(opacityGroup, stripesBtn, flashBtn, stripeToolbar);
      } else {
        opacityGroup.classList.remove('fdr-opacity-active');
        opacityGroup.classList.add('fdr-opacity-inactive');
        this.startFlashing(flashBtn);
      }
    };

    const playPauseBtn = document.createElement('button');
    playPauseBtn.className = 'fdr-btn fdr-btn-sm';
    playPauseBtn.textContent = '⏸';
    playPauseBtn.onclick = () => {
      this.toggleStripePlay();
      playPauseBtn.textContent = this.stripeRunning ? '⏸' : '▶';
    };

    const dirBtn = document.createElement('button');
    dirBtn.className = 'fdr-btn fdr-btn-sm';
    dirBtn.textContent = '⇄';
    dirBtn.onclick = () => { this.stripeDirection *= -1; };

    const widthGroup = document.createElement('div');
    widthGroup.className = 'fdr-stripe-control-group';
    const widthLabel = document.createElement('span');
    widthLabel.textContent = 'W:';
    const widthSlider = document.createElement('input');
    widthSlider.type = 'range';
    widthSlider.min = '10';
    widthSlider.max = '120';
    widthSlider.value = String(this.stripeWidth);
    const widthVal = document.createElement('span');
    widthVal.className = 'fdr-stripe-val';
    widthVal.textContent = `${this.stripeWidth}px`;
    widthSlider.oninput = (e) => {
      this.setStripeWidth(parseInt(e.target.value, 10));
      widthVal.textContent = `${this.stripeWidth}px`;
    };
    widthGroup.append(widthLabel, widthSlider, widthVal);

    stripeToolbar.append(playPauseBtn, dirBtn, widthGroup);

    this.diffCircleBtn = document.createElement('button');
    this.diffCircleBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
    this.diffCircleBtn.innerHTML = '⭕ Circle Diff';
    this.diffCircleBtn.onclick = () => this.toggleCircleDiffMode();

    this.solutionBtn = document.createElement('button');
    this.solutionBtn.className = 'fdr-btn fdr-btn-sm';
    this.solutionBtn.innerHTML = `🎨 Studio (${this.diffCircles.length})`;
    this.solutionBtn.onclick = () => this.openSolutionStudio();

    const nudgeGrid = document.createElement('div');
    nudgeGrid.className = 'fdr-nudge-grid';

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

    toolbar.append(stripesBtn, flashBtn, opacityGroup, btn100, this.diffCircleBtn, this.solutionBtn, nudgeGrid);
    content.appendChild(toolbar);
    content.appendChild(stripeToolbar);

    this._bindCircleDrawEvents();
    this.updateOverlayGeometry();
    this.renderDiffMarkers();
  }

  activateOpacityMode(opacityGroup, stripesBtn, flashBtn, stripeToolbar) {
    this.stopFlashing();
    this.stopStripes();
    stripesBtn?.classList.remove('active');
    flashBtn?.classList.remove('active');
    if (stripeToolbar) stripeToolbar.style.display = 'none';
    opacityGroup.classList.remove('fdr-opacity-inactive');
    opacityGroup.classList.add('fdr-opacity-active');
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

    const totalDispW = Math.round(this.naturalWidth * this.zoom);
    const totalDispH = Math.round(this.naturalHeight * this.zoom);
    const offX = Math.round(-x * this.zoom);
    const offY = Math.round(-y * this.zoom);

    this.overlayClippedImg.style.width = `${totalDispW}px`;
    this.overlayClippedImg.style.height = `${totalDispH}px`;
    this.overlayClippedImg.style.left = `${offX}px`;
    this.overlayClippedImg.style.top = `${offY}px`;

    const targetDlgW = Math.max(340, dispCropW + 4);
    const targetDlgH = dispCropH + 32 + 46;
    this.overlayDialog.element.style.width = `${targetDlgW}px`;
    this.overlayDialog.element.style.height = `${targetDlgH}px`;

    if (this.isStripesMode) {
      this._applyStripeMask();
    }
  }

  setOverlayOpacity(val) {
    this.currentOpacity = Math.max(0, Math.min(1, val));
    if (this.overlayClippedImg) {
      this.overlayClippedImg.style.opacity = `${this.currentOpacity}`;
    }
    if (this.overlayViewport) {
      this.overlayViewport.style.opacity = '1';
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
    this.stopStripes();
    this.isFlashing = true;
    if (btn) btn.classList.add('active');

    let state = false;
    this.flashInterval = setInterval(() => {
      state = !state;
      if (this.overlayClippedImg) {
        this.overlayClippedImg.style.opacity = state ? '1.0' : '0.05';
      }
    }, 600);
  }

  stopFlashing() {
    if (this.flashInterval) {
      clearInterval(this.flashInterval);
      this.flashInterval = null;
    }
    this.isFlashing = false;
    if (this.overlayClippedImg) {
      this.overlayClippedImg.style.opacity = `${this.currentOpacity}`;
    }
  }

  nudgeOverlay(dx, dy) {
    if (!this.overlayDialog || !this.overlayDialog.element) return;
    const curLeft = parseFloat(this.overlayDialog.element.style.left) || 0;
    const curTop = parseFloat(this.overlayDialog.element.style.top) || 0;
    this.overlayDialog.element.style.left = `${curLeft + dx}px`;
    this.overlayDialog.element.style.top = `${curTop + dy}px`;
    if (this.solutionDialog) {
      this.renderSolutionCanvas();
    }
  }

  /* -------------------------------------------------------------
     Circle Difference Tool
     ------------------------------------------------------------- */
  setCircleDiffMode(enable) {
    this.isCircleDiffMode = enable;
    if (this.diffCircleBtn) {
      this.diffCircleBtn.classList.toggle('active', enable);
      this.diffCircleBtn.innerHTML = enable ? '✕ Exit Diff Tool' : '⭕ Circle Diff';
    }
    if (this.circleDrawSurface) {
      this.circleDrawSurface.style.display = enable ? 'block' : 'none';
    }
  }

  toggleCircleDiffMode() {
    this.setCircleDiffMode(!this.isCircleDiffMode);
  }

  _bindCircleDrawEvents() {
    let p1 = null;
    let isDrawing = false;
    let previewGroup = null;

    const getVpCoords = (clientX, clientY) => {
      const rect = this.overlayViewport.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(rect.width, clientX - rect.left)),
        y: Math.max(0, Math.min(rect.height, clientY - rect.top))
      };
    };

    const onPointerDown = (e) => {
      if (!this.isCircleDiffMode) return;
      e.preventDefault();
      e.stopPropagation();

      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      p1 = getVpCoords(cx, cy);
      isDrawing = true;

      previewGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      this.overlaySvgLayer.appendChild(previewGroup);
    };

    const onPointerMove = (e) => {
      if (!isDrawing || !p1) return;
      e.preventDefault();

      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      const p2 = getVpCoords(cx, cy);

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const diam = Math.hypot(dx, dy);
      const radius = diam / 2;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      previewGroup.innerHTML = `
        <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#facc15" stroke-dasharray="3,3" stroke-width="1.5" opacity="0.8" />
        <circle cx="${midX}" cy="${midY}" r="${radius}" fill="none" stroke="#facc15" stroke-width="1.5" stroke-dasharray="4,4" />
        <circle cx="${midX - radius}" cy="${midY}" r="${radius}" fill="rgba(0, 230, 118, 0.15)" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${midX + radius}" cy="${midY}" r="${radius}" fill="rgba(59, 130, 246, 0.15)" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
      `;
    };

    const onPointerUp = (e) => {
      if (!isDrawing || !p1) return;
      isDrawing = false;

      const cx = e.clientX ?? e.changedTouches?.[0]?.clientX;
      const cy = e.clientY ?? e.changedTouches?.[0]?.clientY;
      const p2 = getVpCoords(cx, cy);

      if (previewGroup) {
        previewGroup.remove();
        previewGroup = null;
      }

      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const diam = Math.hypot(dx, dy);
      const radiusDisp = diam / 2;

      if (diam >= 8) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        const mainRect = this.mainImgElement.getBoundingClientRect();
        const ovRect = this.overlayViewport.getBoundingClientRect();

        const cropNatX = midX / this.zoom;
        const cropNatY = midY / this.zoom;
        const natRadius = radiusDisp / this.zoom;

        const baseRelDispX = ovRect.left - mainRect.left;
        const baseRelDispY = ovRect.top - mainRect.top;
        const baseNatOriginX = baseRelDispX / this.zoom;
        const baseNatOriginY = baseRelDispY / this.zoom;

        const diffRecord = {
          id: 'diff_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          cropX: cropNatX,
          cropY: cropNatY,
          radius: Math.max(4, natRadius),
          baseOriginX: baseNatOriginX,
          baseOriginY: baseNatOriginY,
          dragX: cropNatX,
          dragY: cropNatY,
          color: this.solutionOutlineColor
        };

        this.diffCircles.push(diffRecord);
        this.selectedDiffId = diffRecord.id;
        this.renderDiffMarkers();

        if (this.solutionBtn) {
          this.solutionBtn.innerHTML = `🎨 Studio (${this.diffCircles.length})`;
        }

        if (this.solutionDialog) {
          this.renderLayerList();
          this.renderSolutionCanvas();
        }
      }

      p1 = null;
    };

    this.circleDrawSurface.addEventListener('mousedown', onPointerDown);
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);

    this.circleDrawSurface.addEventListener('touchstart', (e) => {
      if (e.touches[0]) onPointerDown(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (e.touches[0]) onPointerMove(e.touches[0]);
    }, { passive: false });
    window.addEventListener('touchend', (e) => {
      if (e.changedTouches[0]) onPointerUp(e.changedTouches[0]);
    });
  }

  undoLastDiff() {
    if (this.diffCircles.length > 0) {
      const removed = this.diffCircles.pop();
      if (this.selectedDiffId === removed.id) {
        this.selectedDiffId = this.diffCircles.length ? this.diffCircles[this.diffCircles.length - 1].id : null;
      }
      this.renderDiffMarkers();
      if (this.solutionBtn) {
        this.solutionBtn.innerHTML = `🎨 Studio (${this.diffCircles.length})`;
      }
      if (this.solutionDialog) {
        this.renderLayerList();
        this.renderSolutionCanvas();
      }
    }
  }

  clearAllDiffs() {
    this.diffCircles = [];
    this.selectedDiffId = null;
    this.renderDiffMarkers();
    if (this.solutionBtn) {
      this.solutionBtn.innerHTML = `🎨 Studio (0)`;
    }
    if (this.solutionDialog) {
      this.renderLayerList();
      this.renderSolutionCanvas();
    }
  }

  deleteSelectedDiff() {
    if (!this.selectedDiffId) return;
    this.diffCircles = this.diffCircles.filter(d => d.id !== this.selectedDiffId);
    this.selectedDiffId = this.diffCircles.length ? this.diffCircles[this.diffCircles.length - 1].id : null;
    this.renderDiffMarkers();
    if (this.solutionBtn) this.solutionBtn.innerHTML = `🎨 Studio (${this.diffCircles.length})`;
    if (this.solutionDialog) {
      this.renderLayerList();
      this.renderSolutionCanvas();
    }
  }

  moveSelectedDiffLayer(delta) {
    if (!this.selectedDiffId) return;
    const idx = this.diffCircles.findIndex(d => d.id === this.selectedDiffId);
    if (idx === -1) return;

    let targetIdx = idx + delta;
    if (targetIdx < 0) targetIdx = 0;
    if (targetIdx >= this.diffCircles.length) targetIdx = this.diffCircles.length - 1;

    if (targetIdx !== idx) {
      const item = this.diffCircles.splice(idx, 1)[0];
      this.diffCircles.splice(targetIdx, 0, item);
      this.renderDiffMarkers();
      this.renderLayerList();
      this.renderSolutionCanvas();
    }
  }

  _getComputedAngle(diff) {
    const dx = diff.dragX - diff.cropX;
    const dy = diff.dragY - diff.cropY;
    if (Math.hypot(dx, dy) >= 0.5) {
      // Rotation axis connecting C1 and C2 is perpendicular to the pull vector
      return Math.atan2(dy, dx) + Math.PI / 2;
    }
    return 0; // Horizontal default when in place
  }

  renderDiffMarkers() {
    if (!this.overlaySvgLayer) return;
    this.overlaySvgLayer.innerHTML = '';

    this.diffCircles.forEach((diff) => {
      const cx = diff.cropX * this.zoom;
      const cy = diff.cropY * this.zoom;
      const r = diff.radius * this.zoom;
      const ang = this._getComputedAngle(diff);

      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);

      const c1x = cx - r * cosA;
      const c1y = cy - r * sinA;
      const c2x = cx + r * cosA;
      const c2y = cy + r * sinA;

      const strokeCol = diff.color || this.solutionOutlineColor;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.innerHTML = `
        <circle cx="${c1x}" cy="${c1y}" r="${r}" fill="none" stroke="${strokeCol}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${c2x}" cy="${c2y}" r="${r}" fill="none" stroke="${strokeCol}" stroke-width="${this.solutionOutlineWidth}" />
      `;
      this.overlaySvgLayer.appendChild(g);
    });
  }

  /* -------------------------------------------------------------
     Solution Canvas Studio
     ------------------------------------------------------------- */
  openSolutionStudio() {
    if (this.solutionDialog) {
      this.solutionDialog.bringToFront();
      this.renderSolutionCanvas();
      return;
    }

    const dlgW = Math.min(window.innerWidth - 30, 1040);
    const dlgH = Math.min(window.innerHeight - 40, 720);

    this.solutionDialog = UITools.makeDialog({
      title: `Difference Solution Studio (${this.diffCircles.length} Spotted)`,
      size: [dlgW, dlgH],
      position: [Math.max(15, (window.innerWidth - dlgW) / 2), Math.max(15, (window.innerHeight - dlgH) / 2)],
      noPadding: true,
      allowMaximize: true,
      onClose: () => {
        this.solutionDialog = null;
      }
    });

    const root = document.createElement('div');
    root.className = 'fdr-solution-studio';

    // Top Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'fdr-solution-toolbar';

    const darkenGroup = document.createElement('div');
    darkenGroup.className = 'fdr-solution-control-item';
    darkenGroup.title = 'Darken the background outside difference circles';
    darkenGroup.innerHTML = `<span>Darken:</span>`;
    const darkenSlider = document.createElement('input');
    darkenSlider.type = 'range';
    darkenSlider.min = '0';
    darkenSlider.max = '90';
    darkenSlider.value = String(Math.round(this.solutionDarken * 100));
    const darkenVal = document.createElement('span');
    darkenVal.style.fontFamily = 'monospace';
    darkenVal.textContent = `${Math.round(this.solutionDarken * 100)}%`;
    darkenSlider.oninput = (e) => {
      this.solutionDarken = parseInt(e.target.value, 10) / 100;
      darkenVal.textContent = `${Math.round(this.solutionDarken * 100)}%`;
      this.renderSolutionCanvas();
    };
    darkenGroup.append(darkenSlider, darkenVal);

    const blurGroup = document.createElement('div');
    blurGroup.className = 'fdr-solution-control-item';
    blurGroup.title = 'Blur the background outside difference circles';
    blurGroup.innerHTML = `<span>Blur:</span>`;
    const blurSlider = document.createElement('input');
    blurSlider.type = 'range';
    blurSlider.min = '0';
    blurSlider.max = '20';
    blurSlider.value = String(this.solutionBlur);
    const blurVal = document.createElement('span');
    blurVal.style.fontFamily = 'monospace';
    blurVal.textContent = `${this.solutionBlur}px`;
    blurSlider.oninput = (e) => {
      this.solutionBlur = parseInt(e.target.value, 10);
      blurVal.textContent = `${this.solutionBlur}px`;
      this.renderSolutionCanvas();
    };
    blurGroup.append(blurSlider, blurVal);

    const colorGroup = document.createElement('div');
    colorGroup.className = 'fdr-solution-control-item';
    colorGroup.title = 'Accent color for difference circles & outlines';
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = this.solutionOutlineColor;
    colorPicker.oninput = (e) => {
      this.solutionOutlineColor = e.target.value;
      if (this.selectedDiffId) {
        const item = this.diffCircles.find(d => d.id === this.selectedDiffId);
        if (item) item.color = e.target.value;
      }
      this.renderDiffMarkers();
      this.renderLayerList();
      this.renderSolutionCanvas();
    };

    const swatches = document.createElement('div');
    swatches.className = 'fdr-color-swatches';
    const colors = ['#00e676', '#facc15', '#06b6d4', '#f43f5e', '#a855f7', '#ffffff'];
    colors.forEach(col => {
      const b = document.createElement('button');
      b.className = 'fdr-swatch-btn';
      b.style.background = col;
      b.onclick = () => {
        this.solutionOutlineColor = col;
        colorPicker.value = col;
        if (this.selectedDiffId) {
          const item = this.diffCircles.find(d => d.id === this.selectedDiffId);
          if (item) item.color = col;
        }
        this.renderDiffMarkers();
        this.renderLayerList();
        this.renderSolutionCanvas();
      };
      swatches.appendChild(b);
    });
    colorGroup.append(colorPicker, swatches);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-primary';
    copyBtn.innerHTML = '📋 Copy Image';
    copyBtn.title = 'Copy crisp solution canvas to clipboard';
    copyBtn.onclick = () => this.copySolutionImage(copyBtn);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
    dlBtn.innerHTML = '💾 Download PNG';
    dlBtn.onclick = () => this.downloadSolutionImage();

    toolbar.append(darkenGroup, blurGroup, colorGroup, copyBtn, dlBtn);
    root.appendChild(toolbar);

    // Secondary Appearance Toolbar: Connectors, Anchor Mix, Outline Width & Clean Captures
    const subToolbar = document.createElement('div');
    subToolbar.className = 'fdr-sub-toolbar';

    // 50/50 Anchor Mix Toggle
    const blendBtn = document.createElement('button');
    blendBtn.className = `fdr-btn fdr-btn-sm ${this.solutionBlendAnchor ? 'active' : ''}`;
    blendBtn.innerHTML = '🔀 Mix Anchor: ' + (this.solutionBlendAnchor ? 'ON' : 'OFF');
    blendBtn.title = 'Mix/superimpose Image A and Image B 50/50 inside the original encircled place';
    blendBtn.onclick = () => {
      this.solutionBlendAnchor = !this.solutionBlendAnchor;
      blendBtn.className = `fdr-btn fdr-btn-sm ${this.solutionBlendAnchor ? 'active' : ''}`;
      blendBtn.innerHTML = '🔀 Mix Anchor: ' + (this.solutionBlendAnchor ? 'ON' : 'OFF');
      this.renderSolutionCanvas();
    };

    const thickItem = document.createElement('div');
    thickItem.className = 'fdr-solution-control-item';
    thickItem.innerHTML = `<span>Border:</span>`;
    const thickSlider = document.createElement('input');
    thickSlider.type = 'range';
    thickSlider.min = '1';
    thickSlider.max = '10';
    thickSlider.value = String(this.solutionOutlineWidth);
    const thickVal = document.createElement('span');
    thickVal.style.fontFamily = 'monospace';
    thickVal.textContent = `${this.solutionOutlineWidth}px`;
    thickSlider.oninput = (e) => {
      this.solutionOutlineWidth = parseInt(e.target.value, 10);
      thickVal.textContent = `${this.solutionOutlineWidth}px`;
      this.renderDiffMarkers();
      this.renderSolutionCanvas();
    };
    thickItem.append(thickSlider, thickVal);

    const connItem = document.createElement('div');
    connItem.className = 'fdr-solution-control-item';
    connItem.innerHTML = `<span>Lines:</span>`;
    const connSelect = document.createElement('select');
    connSelect.innerHTML = `
      <option value="tangents">2 Dashed Tangents</option>
      <option value="none">No Connector Lines</option>
    `;
    connSelect.value = this.solutionConnectorStyle;
    connSelect.onchange = (e) => {
      this.solutionConnectorStyle = e.target.value;
      this.renderSolutionCanvas();
    };
    connItem.appendChild(connSelect);

    const labelBtn = document.createElement('button');
    labelBtn.className = `fdr-btn fdr-btn-sm ${this.solutionShowLabels ? 'active' : ''}`;
    labelBtn.innerHTML = '🏷 Labels: ' + (this.solutionShowLabels ? 'ON' : 'OFF');
    labelBtn.title = 'Toggle number tags (kept off for clean captures)';
    labelBtn.onclick = () => {
      this.solutionShowLabels = !this.solutionShowLabels;
      labelBtn.className = `fdr-btn fdr-btn-sm ${this.solutionShowLabels ? 'active' : ''}`;
      labelBtn.innerHTML = '🏷 Labels: ' + (this.solutionShowLabels ? 'ON' : 'OFF');
      this.renderSolutionCanvas();
    };

    subToolbar.append(blendBtn, thickItem, connItem, labelBtn);
    root.appendChild(subToolbar);

    // Canvas Viewport & Layer Drawer
    const studioMain = document.createElement('div');
    studioMain.className = 'fdr-solution-main';

    const viewport = document.createElement('div');
    viewport.className = 'fdr-solution-viewport';

    this.solutionCanvas = document.createElement('canvas');
    this.solutionCanvas.className = 'fdr-solution-canvas';
    viewport.appendChild(this.solutionCanvas);

    const hint = document.createElement('div');
    hint.className = 'fdr-drag-hint-banner';
    hint.textContent = '💡 Drag callout in any direction • Auto-orients perpendicular • Double-click to snap back';
    viewport.appendChild(hint);

    // Layer Drawer (Z-Order Management)
    const drawer = document.createElement('div');
    drawer.className = 'fdr-layer-drawer';

    const drawerHdr = document.createElement('div');
    drawerHdr.className = 'fdr-layer-header';
    drawerHdr.innerHTML = `<span>Z-Order Layers</span>`;

    const layerActions = document.createElement('div');
    layerActions.className = 'fdr-layer-actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'fdr-btn fdr-btn-sm';
    upBtn.textContent = '▲';
    upBtn.title = 'Bring Forward in Z-order (Shortcut: ])';
    upBtn.onclick = () => this.moveSelectedDiffLayer(1);

    const downBtn = document.createElement('button');
    downBtn.className = 'fdr-btn fdr-btn-sm';
    downBtn.textContent = '▼';
    downBtn.title = 'Send Backward in Z-order (Shortcut: [)';
    downBtn.onclick = () => this.moveSelectedDiffLayer(-1);

    const topBtn = document.createElement('button');
    topBtn.className = 'fdr-btn fdr-btn-sm';
    topBtn.textContent = '⏫';
    topBtn.title = 'Bring to Front (Shortcut: Shift+])';
    topBtn.onclick = () => this.moveSelectedDiffLayer(999);

    const botBtn = document.createElement('button');
    botBtn.className = 'fdr-btn fdr-btn-sm';
    botBtn.textContent = '⏬';
    botBtn.title = 'Send to Back (Shortcut: Shift+[)';
    botBtn.onclick = () => this.moveSelectedDiffLayer(-999);

    const delBtn = document.createElement('button');
    delBtn.className = 'fdr-btn fdr-btn-sm';
    delBtn.textContent = '🗑';
    delBtn.title = 'Delete selected difference (Shortcut: Del)';
    delBtn.onclick = () => this.deleteSelectedDiff();

    layerActions.append(upBtn, downBtn, topBtn, botBtn, delBtn);
    drawerHdr.appendChild(layerActions);

    this.layerListEl = document.createElement('div');
    this.layerListEl.className = 'fdr-layer-list';

    drawer.append(drawerHdr, this.layerListEl);
    studioMain.append(viewport, drawer);
    root.appendChild(studioMain);

    this.solutionDialog.contentElement.appendChild(root);

    this._bindSolutionCanvasDrag();
    this.renderLayerList();
    this.renderSolutionCanvas();
  }

  renderLayerList() {
    if (!this.layerListEl) return;
    this.layerListEl.innerHTML = '';

    if (this.diffCircles.length === 0) {
      this.layerListEl.innerHTML = `<div style="padding:12px; font-size:11px; color:#64748b; text-align:center;">No differences marked. Use "Circle Diff" in overlay.</div>`;
      return;
    }

    for (let i = this.diffCircles.length - 1; i >= 0; i--) {
      const diff = this.diffCircles[i];
      const isSelected = diff.id === this.selectedDiffId;
      const isDraggedOut = Math.hypot(diff.dragX - diff.cropX, diff.dragY - diff.cropY) > 8;

      const item = document.createElement('div');
      item.className = `fdr-layer-item ${isSelected ? 'active' : ''}`;
      item.onclick = () => {
        this.selectedDiffId = diff.id;
        this.renderLayerList();
        this.renderSolutionCanvas();
        this.renderDiffMarkers();
      };

      const dotColor = diff.color || this.solutionOutlineColor;
      item.innerHTML = `
        <span class="fdr-layer-tag">
          <span class="fdr-layer-dot" style="background:${dotColor}; box-shadow:0 0 6px ${dotColor}"></span>
          #${i + 1} Diff
        </span>
        <span style="font-size:10px; opacity:0.7;">${isDraggedOut ? '↗ Callout' : '⊙ Center'}</span>
      `;
      this.layerListEl.appendChild(item);
    }
  }

  /* -------------------------------------------------------------
     Canvas Drag with Automatic Perpendicular Orientation
     ------------------------------------------------------------- */
  _bindSolutionCanvasDrag() {
    let activeDrag = null;

    const getCanvasCoords = (clientX, clientY) => {
      const rect = this.solutionCanvas.getBoundingClientRect();
      const scaleX = this.solutionCanvas.width / rect.width;
      const scaleY = this.solutionCanvas.height / rect.height;
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    };

    const findHit = (canvasX, canvasY) => {
      const transform = this._getCanvasTransform();
      for (let i = this.diffCircles.length - 1; i >= 0; i--) {
        const diff = this.diffCircles[i];
        const cx = diff.dragX + transform.offsetX;
        const cy = diff.dragY + transform.offsetY;
        const r = diff.radius;
        const ang = this._getComputedAngle(diff);

        const cosA = Math.cos(ang);
        const sinA = Math.sin(ang);

        const c1x = cx - r * cosA;
        const c1y = cy - r * sinA;
        const c2x = cx + r * cosA;
        const c2y = cy + r * sinA;

        const d1 = Math.hypot(canvasX - c1x, canvasY - c1y);
        const d2 = Math.hypot(canvasX - c2x, canvasY - c2y);

        if (d1 <= r * 1.05 || d2 <= r * 1.05) {
          return { diff };
        }
      }
      return null;
    };

    const onDown = (e) => {
      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      const coords = getCanvasCoords(cx, cy);

      const hit = findHit(coords.x, coords.y);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        this.selectedDiffId = hit.diff.id;
        this.solutionCanvas.classList.add('grabbing');
        activeDrag = {
          diff: hit.diff,
          startPointerX: coords.x,
          startPointerY: coords.y,
          origDragX: hit.diff.dragX,
          origDragY: hit.diff.dragY
        };

        this.renderLayerList();
        this.renderSolutionCanvas();
      }
    };

    const onMove = (e) => {
      if (!activeDrag) return;
      e.preventDefault();

      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      const coords = getCanvasCoords(cx, cy);

      const dx = coords.x - activeDrag.startPointerX;
      const dy = coords.y - activeDrag.startPointerY;
      activeDrag.diff.dragX = activeDrag.origDragX + dx;
      activeDrag.diff.dragY = activeDrag.origDragY + dy;

      this.renderSolutionCanvas();
    };

    const onUp = () => {
      if (activeDrag) {
        this.solutionCanvas.classList.remove('grabbing');
        activeDrag = null;
        this.renderLayerList();
        this.renderSolutionCanvas();
      }
    };

    this.solutionCanvas.addEventListener('dblclick', (e) => {
      const coords = getCanvasCoords(e.clientX, e.clientY);
      const hit = findHit(coords.x, coords.y);
      if (hit) {
        hit.diff.dragX = hit.diff.cropX;
        hit.diff.dragY = hit.diff.cropY;
        this.renderLayerList();
        this.renderSolutionCanvas();
      }
    });

    this.solutionCanvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    this.solutionCanvas.addEventListener('touchstart', onDown, { passive: false });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onUp);
  }

  /* -------------------------------------------------------------
     Tight Cropping Calculation (Includes geometry only, no further)
     ------------------------------------------------------------- */
  _getCanvasTransform() {
    const crop = this.activeCrop || { x: 0, y: 0, width: this.naturalWidth, height: this.naturalHeight };
    const w = crop.width;
    const h = crop.height;

    // Base boundary starts at the puzzle image boundaries
    let minX = 0;
    let minY = 0;
    let maxX = w;
    let maxY = h;

    const strokePad = (this.solutionOutlineWidth / 2) + 2;

    // Extend only if circle geometry is stretched beyond the base image
    this.diffCircles.forEach(diff => {
      const r = diff.radius;
      const ang = this._getComputedAngle(diff);
      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);

      const c1x = diff.dragX - r * cosA;
      const c1y = diff.dragY - r * sinA;
      const c2x = diff.dragX + r * cosA;
      const c2y = diff.dragY + r * sinA;

      const rWithStroke = r + strokePad;

      minX = Math.min(minX, c1x - rWithStroke, c2x - rWithStroke);
      maxX = Math.max(maxX, c1x + rWithStroke, c2x + rWithStroke);
      minY = Math.min(minY, c1y - rWithStroke, c2y - rWithStroke);
      maxY = Math.max(maxY, c1y + rWithStroke, c2y + rWithStroke);
    });

    // Minimal 3px edge clearance for anti-aliasing
    const margin = 3;
    minX = Math.floor(minX - margin);
    minY = Math.floor(minY - margin);
    maxX = Math.ceil(maxX + margin);
    maxY = Math.ceil(maxY + margin);

    const canvasWidth = Math.round(maxX - minX);
    const canvasHeight = Math.round(maxY - minY);

    return {
      canvasWidth,
      canvasHeight,
      offsetX: -minX,
      offsetY: -minY,
      cropW: w,
      cropH: h,
      cropX: crop.x,
      cropY: crop.y
    };
  }

  /* -------------------------------------------------------------
     Rendering Solution Canvas
     ------------------------------------------------------------- */
  renderSolutionCanvas() {
    if (!this.solutionCanvas || !this.sourceImage) return;

    const tf = this._getCanvasTransform();
    this.solutionCanvas.width = tf.canvasWidth;
    this.solutionCanvas.height = tf.canvasHeight;
    const ctx = this.solutionCanvas.getContext('2d');

    const w = tf.cropW;
    const h = tf.cropH;

    // Full-resolution crop patch canvases
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = w;
    cropCanvas.height = h;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(this.sourceImage, tf.cropX, tf.cropY, w, h, 0, 0, w, h);

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = w;
    baseCanvas.height = h;
    const baseCtx = baseCanvas.getContext('2d');

    let baseOriginX = tf.cropX;
    let baseOriginY = tf.cropY;
    if (this.overlayDialog && this.overlayViewport && this.mainImgElement) {
      const mainRect = this.mainImgElement.getBoundingClientRect();
      const ovRect = this.overlayViewport.getBoundingClientRect();
      baseOriginX = (ovRect.left - mainRect.left) / this.zoom;
      baseOriginY = (ovRect.top - mainRect.top) / this.zoom;
    }
    baseCtx.drawImage(this.sourceImage, baseOriginX, baseOriginY, w, h, 0, 0, w, h);

    // Canvas Background
    ctx.clearRect(0, 0, tf.canvasWidth, tf.canvasHeight);

    const bgGrad = ctx.createLinearGradient(0, 0, tf.canvasWidth, tf.canvasHeight);
    bgGrad.addColorStop(0, '#090d16');
    bgGrad.addColorStop(1, '#0f172a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, tf.canvasWidth, tf.canvasHeight);

    // Render Puzzle Scene
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#000000';
    ctx.fillRect(tf.offsetX, tf.offsetY, w, h);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(tf.offsetX, tf.offsetY, w, h);
    ctx.clip();

    if (this.solutionBlur > 0) {
      ctx.save();
      ctx.filter = `blur(${this.solutionBlur}px)`;
      ctx.drawImage(cropCanvas, tf.offsetX, tf.offsetY);
      ctx.restore();
    } else {
      ctx.drawImage(cropCanvas, tf.offsetX, tf.offsetY);
    }

    if (this.solutionDarken > 0) {
      ctx.fillStyle = `rgba(0, 0, 0, ${this.solutionDarken})`;
      ctx.fillRect(tf.offsetX, tf.offsetY, w, h);
    }
    ctx.restore();

    // Scene outline border
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(tf.offsetX, tf.offsetY, w, h);

    // 1. Render Dotted Anchors, Alpha-Blended Mix inside anchor, & 2 Tangent Lines
    this.diffCircles.forEach((diff) => {
      const origX = diff.cropX + tf.offsetX;
      const origY = diff.cropY + tf.offsetY;
      const dragX = diff.dragX + tf.offsetX;
      const dragY = diff.dragY + tf.offsetY;
      const r = diff.radius;
      const color = diff.color || this.solutionOutlineColor;
      const ang = this._getComputedAngle(diff);

      const distMoved = Math.hypot(dragX - origX, dragY - origY);
      const isDragged = distMoved > (r * 1.05);

      // Superimposed 50/50 Alpha-Mix inside the original circle
      if (this.solutionBlendAnchor) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(origX, origY, r, 0, Math.PI * 2);
        ctx.clip();

        if (this.solutionBlur > 0) {
          ctx.filter = `blur(${this.solutionBlur}px)`;
        }
        ctx.drawImage(cropCanvas, origX - diff.cropX, origY - diff.cropY);
        ctx.globalAlpha = 0.5;
        ctx.drawImage(baseCanvas, origX - diff.cropX, origY - diff.cropY);

        if (this.solutionDarken > 0) {
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = `rgba(0, 0, 0, ${this.solutionDarken})`;
          ctx.fillRect(origX - r, origY - r, r * 2, r * 2);
        }
        ctx.restore();
      }

      // If dragged out, draw original spot dashed outline and two tangent lines
      if (isDragged) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.arc(origX, origY, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        if (this.solutionConnectorStyle === 'tangents') {
          this._drawOuterTangentLines(ctx, origX, origY, dragX, dragY, r, ang, color);
        }
      }
    });

    // 2. Render Magnifier Circles (Clean: No rotate handles, no center dots)
    this.diffCircles.forEach((diff, idx) => {
      const origX = diff.cropX;
      const origY = diff.cropY;
      const dragX = diff.dragX + tf.offsetX;
      const dragY = diff.dragY + tf.offsetY;
      const r = diff.radius;
      const color = diff.color || this.solutionOutlineColor;
      const ang = this._getComputedAngle(diff);

      const cosA = Math.cos(ang);
      const sinA = Math.sin(ang);

      const c1x = dragX - r * cosA;
      const c1y = dragY - r * sinA;
      const c2x = dragX + r * cosA;
      const c2y = dragY + r * sinA;

      // Circle 1: Image A
      ctx.save();
      ctx.beginPath();
      ctx.arc(c1x, c1y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(cropCanvas, c1x - origX, c1y - origY);
      ctx.restore();

      // Circle 2: Image B
      ctx.save();
      ctx.beginPath();
      ctx.arc(c2x, c2y, r, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(baseCanvas, c2x - origX, c2y - origY);
      ctx.restore();

      // Circular Outlines
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = this.solutionOutlineWidth;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 4;

      ctx.beginPath();
      ctx.arc(c1x, c1y, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(c2x, c2y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Optional Labels (Off by default for pristine captures)
      if (this.solutionShowLabels) {
        ctx.save();
        ctx.font = 'bold 11px system-ui, monospace';
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`#${idx + 1}`, dragX, Math.min(c1y, c2y) - r - 4);
        ctx.restore();
      }
    });

    if (this.solutionDialog) {
      this.solutionDialog.setTitle(`Difference Solution Studio (${this.diffCircles.length} Spotted)`);
    }
  }

  /* -------------------------------------------------------------
     2 Outermost Dashed Tangent Lines between C0 and {C1, C2}
     ------------------------------------------------------------- */
  _drawOuterTangentLines(ctx, p0x, p0y, dragX, dragY, r, ang, color) {
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);

    const p1 = { x: dragX - r * cosA, y: dragY - r * sinA };
    const p2 = { x: dragX + r * cosA, y: dragY + r * sinA };

    const getTangentsForCircle = (targetCenter) => {
      const dx = targetCenter.x - p0x;
      const dy = targetCenter.y - p0y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.001) return null;

      const ux = dx / dist;
      const uy = dy / dist;

      const nx = -uy;
      const ny = ux;

      return {
        targetCenter,
        nx, ny,
        pos: {
          start: { x: p0x + r * nx, y: p0y + r * ny },
          end: { x: targetCenter.x + r * nx, y: targetCenter.y + r * ny }
        },
        neg: {
          start: { x: p0x - r * nx, y: p0y - r * ny },
          end: { x: targetCenter.x - r * nx, y: targetCenter.y - r * ny }
        }
      };
    };

    const t1 = getTangentsForCircle(p1);
    const t2 = getTangentsForCircle(p2);

    if (!t1 || !t2) return;

    const testPos = (p2.x - p0x) * t1.nx + (p2.y - p0y) * t1.ny;
    const outerPos = (testPos <= 0) ? t1.pos : t2.pos;

    const testNeg = (p2.x - p0x) * (-t1.nx) + (p2.y - p0y) * (-t1.ny);
    const outerNeg = (testNeg <= 0) ? t1.neg : t2.neg;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);

    ctx.beginPath();
    ctx.moveTo(outerPos.start.x, outerPos.start.y);
    ctx.lineTo(outerPos.end.x, outerPos.end.y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(outerNeg.start.x, outerNeg.start.y);
    ctx.lineTo(outerNeg.end.x, outerNeg.end.y);
    ctx.stroke();

    ctx.restore();
  }

  copySolutionImage(btn) {
    if (!this.solutionCanvas) return;
    this.solutionCanvas.toBlob(async (blob) => {
      if (!blob) return;
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const originalText = btn.innerHTML;
        btn.innerHTML = '✓ Copied!';
        setTimeout(() => { btn.innerHTML = originalText; }, 1800);
      } catch (err) {
        alert('Clipboard write failed. Please use "Download PNG" instead.');
      }
    });
  }

  downloadSolutionImage() {
    if (!this.solutionCanvas) return;
    const link = document.createElement('a');
    link.download = `spot-the-difference-solution-${Date.now()}.png`;
    link.href = this.solutionCanvas.toDataURL('image/png');
    link.click();
  }

  /* -------------------------------------------------------------
     Scrolling Stripes Implementation
     ------------------------------------------------------------- */
  startStripes() {
    this.stopFlashing();
    this.stopStripes();
    this.isStripesMode = true;
    this.stripeRunning = true;

    if (this.overlayClippedImg) {
      this.overlayClippedImg.style.opacity = '1.0';
    }
    if (this.overlayViewport) {
      this.overlayViewport.style.opacity = '1.0';
    }

    this._applyStripeMask();

    let lastTime = performance.now();
    const loop = (currentTime) => {
      if (!this.isStripesMode || !this.stripeRunning) return;
      const dt = Math.min(0.1, (currentTime - lastTime) / 1000);
      lastTime = currentTime;

      const cycle = (this.stripeWidth || 50) * 2;
      this.stripeOffset = (this.stripeOffset + dt * this.stripeSpeed * this.stripeDirection) % cycle;
      this._updateStripePosition();

      this.stripeRafId = requestAnimationFrame(loop);
    };

    this.stripeRafId = requestAnimationFrame(loop);
  }

  stopStripes() {
    if (this.stripeRafId) {
      cancelAnimationFrame(this.stripeRafId);
      this.stripeRafId = null;
    }
    this.isStripesMode = false;
    this.stripeRunning = false;
    this._clearStripeMask();
    if (this.overlayClippedImg) {
      this.overlayClippedImg.style.opacity = `${this.currentOpacity}`;
    }
  }

  toggleStripePlay() {
    if (!this.isStripesMode) {
      this.startStripes();
      return;
    }
    this.stripeRunning = !this.stripeRunning;
    if (this.stripeRunning) {
      let lastTime = performance.now();
      const loop = (currentTime) => {
        if (!this.isStripesMode || !this.stripeRunning) return;
        const dt = Math.min(0.1, (currentTime - lastTime) / 1000);
        lastTime = currentTime;

        const cycle = (this.stripeWidth || 50) * 2;
        this.stripeOffset = (this.stripeOffset + dt * this.stripeSpeed * this.stripeDirection) % cycle;
        this._updateStripePosition();

        this.stripeRafId = requestAnimationFrame(loop);
      };
      this.stripeRafId = requestAnimationFrame(loop);
    } else if (this.stripeRafId) {
      cancelAnimationFrame(this.stripeRafId);
      this.stripeRafId = null;
    }
  }

  setStripeWidth(width) {
    this.stripeWidth = Math.max(8, Math.min(200, width));
    this._applyStripeMask();
  }

  _applyStripeMask() {
    if (!this.overlayViewport) return;
    const w = this.stripeWidth || 50;
    const cycle = w * 2;
    const grad = `linear-gradient(90deg, #000 0px, #000 ${w}px, transparent ${w}px, transparent ${cycle}px)`;
    this.overlayViewport.style.webkitMaskImage = grad;
    this.overlayViewport.style.maskImage = grad;
    this.overlayViewport.style.webkitMaskSize = `${cycle}px 100%`;
    this.overlayViewport.style.maskSize = `${cycle}px 100%`;
    this.overlayViewport.style.webkitMaskRepeat = 'repeat-x';
    this.overlayViewport.style.maskRepeat = 'repeat-x';
    this._updateStripePosition();
  }

  _updateStripePosition() {
    if (!this.overlayViewport) return;
    const pos = `${this.stripeOffset}px 0`;
    this.overlayViewport.style.webkitMaskPosition = pos;
    this.overlayViewport.style.maskPosition = pos;
  }

  _clearStripeMask() {
    if (!this.overlayViewport) return;
    this.overlayViewport.style.webkitMaskImage = '';
    this.overlayViewport.style.maskImage = '';
    this.overlayViewport.style.webkitMaskSize = '';
    this.overlayViewport.style.maskSize = '';
    this.overlayViewport.style.webkitMaskRepeat = '';
    this.overlayViewport.style.maskRepeat = '';
    this.overlayViewport.style.webkitMaskPosition = '';
    this.overlayViewport.style.maskPosition = '';
  }

  destroy() {
    this.stopFlashing();
    this.stopStripes();
    window.removeEventListener('paste', this._onPaste);
    window.removeEventListener('keydown', this._onKeyDown);
    if (this.solutionDialog) this.solutionDialog.close();
    if (this.overlayDialog) this.overlayDialog.close();
    if (this.mainDialog) this.mainDialog.close();
  }
}

globalThis.FindTheDifferenceCheater = FindTheDifferenceCheater;
if (typeof module !== 'undefined' && module.exports) module.exports = FindTheDifferenceCheater;