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
    this.stripeSpeed = 45; // pixels per second
    this.stripeOffset = 0;
    this.stripeRunning = false;
    this.stripeDirection = 1;
    this.stripeRafId = null;

    // Difference Circles State
    this.diffCircles = []; // Array of { id, cropX, cropY, radius, baseDx, baseDy }
    this.isCircleDiffMode = false;
    this.circleDrawSurface = null;
    this.overlaySvgLayer = null;
    this.solutionDialog = null;

    // Solution Canvas Settings
    this.solutionDarken = 0.35; // 35% darkening
    this.solutionBlur = 4; // 4px blur
    this.solutionOutlineColor = '#00e676'; // Neon green default
    this.solutionOutlineWidth = 3; // 3px default
    this.solutionOrientation = 'horizontal'; // 'horizontal' or 'vertical'
    this.solutionSceneMode = 'crop'; // 'crop' (single puzzle view) or 'full'

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
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        if (this.diffCircles.length > 0) {
          this.undoLastDiff();
          e.preventDefault();
        }
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
      ctx.fillStyle = hasDifferences ? '#fef08a' : '#67e8f9'; // Diff 4: Window light
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
    solBtn.innerHTML = '🎨 Solution Canvas';
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

    // Clipped Viewport Container
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

    // SVG Marker Layer for Diff Circles
    this.overlaySvgLayer = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlaySvgLayer.setAttribute('class', 'fdr-diff-svg-layer');

    // Interactive Drawing Surface for Circle Diff
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
    stripesBtn.title = 'Scrolling alternating stripes of overlay image vs underlying image';

    const flashBtn = document.createElement('button');
    flashBtn.className = 'fdr-btn fdr-btn-sm';
    flashBtn.innerHTML = '⚡ Flash';
    flashBtn.title = 'Blink overlay between transparent and opaque';

    // Compact Opacity Slider & Quick Toggle
    const opacityGroup = document.createElement('div');
    opacityGroup.className = 'fdr-opacity-group fdr-opacity-active';
    opacityGroup.title = 'Adjust overlay transparency (Tap to reset to 50%)';

    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range';
    opacitySlider.min = '0';
    opacitySlider.max = '100';
    opacitySlider.value = '50';

    const opacityLabel = document.createElement('span');
    opacityLabel.className = 'fdr-opacity-lbl';
    opacityLabel.textContent = '50%';
    opacityLabel.title = 'Click to reset opacity to 50%';

    const btn100 = document.createElement('button');
    btn100.className = 'fdr-btn fdr-btn-sm';
    btn100.textContent = '100%';
    btn100.title = 'Set overlay to 100% opaque';
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

    // Tapping the slider track resets back to 50%
    opacitySlider.addEventListener('click', (e) => {
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

    this.opacityUi = {
      group: opacityGroup,
      slider: opacitySlider,
      label: opacityLabel
    };

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

    // Stripe Toolbar items
    const playPauseBtn = document.createElement('button');
    playPauseBtn.className = 'fdr-btn fdr-btn-sm';
    playPauseBtn.textContent = '⏸';
    playPauseBtn.title = 'Play / Pause scrolling stripes';
    playPauseBtn.onclick = () => {
      this.toggleStripePlay();
      playPauseBtn.textContent = this.stripeRunning ? '⏸' : '▶';
    };

    const dirBtn = document.createElement('button');
    dirBtn.className = 'fdr-btn fdr-btn-sm';
    dirBtn.textContent = '⇄';
    dirBtn.title = 'Reverse scroll direction';
    dirBtn.onclick = () => {
      this.stripeDirection *= -1;
    };

    const widthGroup = document.createElement('div');
    widthGroup.className = 'fdr-stripe-control-group';
    widthGroup.title = 'Adjust stripe width';
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

    const speedGroup = document.createElement('div');
    speedGroup.className = 'fdr-stripe-control-group';
    speedGroup.title = 'Adjust scrolling speed';
    const speedLabel = document.createElement('span');
    speedLabel.textContent = 'Speed:';
    const speedSlider = document.createElement('input');
    speedSlider.type = 'range';
    speedSlider.min = '10';
    speedSlider.max = '150';
    speedSlider.value = String(this.stripeSpeed);
    speedSlider.oninput = (e) => {
      this.stripeSpeed = parseInt(e.target.value, 10);
    };
    speedGroup.append(speedLabel, speedSlider);

    stripeToolbar.append(playPauseBtn, dirBtn, widthGroup, speedGroup);

    // Difference Circle Tool Button
    this.diffCircleBtn = document.createElement('button');
    this.diffCircleBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
    this.diffCircleBtn.innerHTML = '⭕ Circle Diff';
    this.diffCircleBtn.title = 'Click and drag diametrically across a difference to capture side-by-side snapshots';
    this.diffCircleBtn.onclick = () => this.toggleCircleDiffMode();

    // Solution Studio Button
    this.solutionBtn = document.createElement('button');
    this.solutionBtn.className = 'fdr-btn fdr-btn-sm';
    this.solutionBtn.innerHTML = `🎨 Solution (${this.diffCircles.length})`;
    this.solutionBtn.title = 'Generate solution graphic with side-by-side circles, blur, and darkening controls';
    this.solutionBtn.onclick = () => this.openSolutionStudio();

    // Nudge controls
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
     Circle Difference Tool (Diametrically Opposed Points)
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

      // Create preview SVG group
      previewGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      this.overlaySvgLayer.appendChild(previewGroup);
    };

    const onPointerMove = (e) => {
      if (!isDrawing || !p1) return;
      e.preventDefault();

      const cx = e.clientX ?? e.touches?.[0]?.clientX;
      const cy = e.clientY ?? e.touches?.[0]?.clientY;
      const p2 = getVpCoords(cx, cy);

      // Distance is diameter D; center is midpoint between p1 and p2
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const diam = Math.hypot(dx, dy);
      const radius = diam / 2;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;

      previewGroup.innerHTML = `
        <!-- Diametric guide line -->
        <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="#facc15" stroke-dasharray="3,3" stroke-width="1.5" opacity="0.8" />
        <circle cx="${p1.x}" cy="${p1.y}" r="3" fill="#facc15" />
        <circle cx="${p2.x}" cy="${p2.y}" r="3" fill="#facc15" />

        <!-- Original Diff Circle at center -->
        <circle cx="${midX}" cy="${midY}" r="${radius}" fill="none" stroke="#facc15" stroke-width="1.5" stroke-dasharray="4,4" />

        <!-- Side-by-Side Touching Circles Preview -->
        <circle cx="${midX - radius}" cy="${midY}" r="${radius}" fill="rgba(0, 230, 118, 0.15)" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${midX + radius}" cy="${midY}" r="${radius}" fill="rgba(59, 130, 246, 0.15)" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${midX}" cy="${midY}" r="3" fill="#ffffff" />
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

      // Meaningful circle size minimum
      if (diam >= 8) {
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;

        const mainRect = this.mainImgElement.getBoundingClientRect();
        const ovRect = this.overlayViewport.getBoundingClientRect();

        // Exact natural coordinate translation
        const cropNatX = midX / this.zoom;
        const cropNatY = midY / this.zoom;
        const natRadius = radiusDisp / this.zoom;

        const baseRelDispX = ovRect.left - mainRect.left;
        const baseRelDispY = ovRect.top - mainRect.top;
        const baseNatOriginX = baseRelDispX / this.zoom;
        const baseNatOriginY = baseRelDispY / this.zoom;

        const diffRecord = {
          id: 'diff_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          // Position relative to cropped scene in natural pixels
          cropX: cropNatX,
          cropY: cropNatY,
          radius: Math.max(4, natRadius),
          // Base image natural alignment offsets
          baseOriginX: baseNatOriginX,
          baseOriginY: baseNatOriginY
        };

        this.diffCircles.push(diffRecord);
        this.renderDiffMarkers();

        if (this.solutionBtn) {
          this.solutionBtn.innerHTML = `🎨 Solution (${this.diffCircles.length})`;
        }

        if (this.solutionDialog) {
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
      this.diffCircles.pop();
      this.renderDiffMarkers();
      if (this.solutionBtn) {
        this.solutionBtn.innerHTML = `🎨 Solution (${this.diffCircles.length})`;
      }
      if (this.solutionDialog) {
        this.renderSolutionCanvas();
      }
    }
  }

  clearAllDiffs() {
    this.diffCircles = [];
    this.renderDiffMarkers();
    if (this.solutionBtn) {
      this.solutionBtn.innerHTML = `🎨 Solution (0)`;
    }
    if (this.solutionDialog) {
      this.renderSolutionCanvas();
    }
  }

  renderDiffMarkers() {
    if (!this.overlaySvgLayer) return;
    this.overlaySvgLayer.innerHTML = '';

    const isH = this.solutionOrientation === 'horizontal';

    this.diffCircles.forEach((diff, idx) => {
      const cx = diff.cropX * this.zoom;
      const cy = diff.cropY * this.zoom;
      const r = diff.radius * this.zoom;

      const c1x = isH ? cx - r : cx;
      const c1y = isH ? cy : cy - r;
      const c2x = isH ? cx + r : cx;
      const c2y = isH ? cy : cy + r;

      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.innerHTML = `
        <!-- Side-by-side touching circles -->
        <circle cx="${c1x}" cy="${c1y}" r="${r}" fill="none" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${c2x}" cy="${c2y}" r="${r}" fill="none" stroke="${this.solutionOutlineColor}" stroke-width="${this.solutionOutlineWidth}" />
        <circle cx="${cx}" cy="${cy}" r="3" fill="#ffffff" />
        <text x="${cx}" y="${cy - r - 4}" fill="${this.solutionOutlineColor}" font-size="10" font-family="monospace" font-weight="bold" text-anchor="middle">#${idx + 1}</text>
      `;
      this.overlaySvgLayer.appendChild(g);
    });
  }

  /* -------------------------------------------------------------
     Solution Canvas Studio (Side-by-Side Touching Circles, Blur & Darken)
     ------------------------------------------------------------- */
  openSolutionStudio() {
    if (this.solutionDialog) {
      this.solutionDialog.bringToFront();
      this.renderSolutionCanvas();
      return;
    }

    const dlgW = Math.min(window.innerWidth - 40, 840);
    const dlgH = Math.min(window.innerHeight - 60, 680);

    this.solutionDialog = UITools.makeDialog({
      title: `Difference Solution Studio (${this.diffCircles.length} Spotted)`,
      size: [dlgW, dlgH],
      position: [Math.max(20, (window.innerWidth - dlgW) / 2), Math.max(20, (window.innerHeight - dlgH) / 2)],
      noPadding: true,
      allowMaximize: true,
      onResize: () => {
        // Fits dynamically
      },
      onClose: () => {
        this.solutionDialog = null;
      }
    });

    const root = document.createElement('div');
    root.className = 'fdr-solution-studio';

    // Toolbar with all customization controls
    const toolbar = document.createElement('div');
    toolbar.className = 'fdr-solution-toolbar';

    // Darkening Slider
    const darkenGroup = document.createElement('div');
    darkenGroup.className = 'fdr-solution-control-item';
    darkenGroup.title = 'Darken the background area outside the difference circles';
    const darkenLbl = document.createElement('span');
    darkenLbl.textContent = 'Darken:';
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
    darkenGroup.append(darkenLbl, darkenSlider, darkenVal);

    // Blur Slider
    const blurGroup = document.createElement('div');
    blurGroup.className = 'fdr-solution-control-item';
    blurGroup.title = 'Blur the background area outside the difference circles';
    const blurLbl = document.createElement('span');
    blurLbl.textContent = 'Blur:';
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
    blurGroup.append(blurLbl, blurSlider, blurVal);

    // Border Thickness Slider
    const thickGroup = document.createElement('div');
    thickGroup.className = 'fdr-solution-control-item';
    thickGroup.title = 'Thickness of circular outlines';
    const thickLbl = document.createElement('span');
    thickLbl.textContent = 'Border:';
    const thickSlider = document.createElement('input');
    thickSlider.type = 'range';
    thickSlider.min = '1';
    thickSlider.max = '12';
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
    thickGroup.append(thickLbl, thickSlider, thickVal);

    // Color picker & presets
    const colorGroup = document.createElement('div');
    colorGroup.className = 'fdr-solution-control-item';
    colorGroup.title = 'Border color for difference circles';
    const colorPicker = document.createElement('input');
    colorPicker.type = 'color';
    colorPicker.value = this.solutionOutlineColor;
    colorPicker.oninput = (e) => {
      this.solutionOutlineColor = e.target.value;
      this.renderDiffMarkers();
      this.renderSolutionCanvas();
    };

    const swatches = document.createElement('div');
    swatches.className = 'fdr-color-swatches';
    const colors = ['#00e676', '#facc15', '#06b6d4', '#f43f5e', '#fb923c', '#ffffff'];
    colors.forEach(col => {
      const b = document.createElement('button');
      b.className = 'fdr-swatch-btn';
      b.style.background = col;
      b.onclick = () => {
        this.solutionOutlineColor = col;
        colorPicker.value = col;
        this.renderDiffMarkers();
        this.renderSolutionCanvas();
      };
      swatches.appendChild(b);
    });
    colorGroup.append(colorPicker, swatches);

    // Orientation toggle (Side-by-Side Horizontal vs Vertical)
    const orientBtn = document.createElement('button');
    orientBtn.className = 'fdr-btn fdr-btn-sm';
    orientBtn.innerHTML = this.solutionOrientation === 'horizontal' ? '⇄ Side-by-Side (H)' : '⇅ Side-by-Side (V)';
    orientBtn.title = 'Toggle horizontal or vertical side-by-side circle alignment';
    orientBtn.onclick = () => {
      this.solutionOrientation = this.solutionOrientation === 'horizontal' ? 'vertical' : 'horizontal';
      orientBtn.innerHTML = this.solutionOrientation === 'horizontal' ? '⇄ Side-by-Side (H)' : '⇅ Side-by-Side (V)';
      this.renderDiffMarkers();
      this.renderSolutionCanvas();
    };

    // Undo & Clear
    const undoBtn = document.createElement('button');
    undoBtn.className = 'fdr-btn fdr-btn-sm';
    undoBtn.textContent = '↩ Undo';
    undoBtn.onclick = () => this.undoLastDiff();

    const clearBtn = document.createElement('button');
    clearBtn.className = 'fdr-btn fdr-btn-sm';
    clearBtn.textContent = '🗑 Clear';
    clearBtn.onclick = () => {
      if (confirm('Clear all marked differences?')) this.clearAllDiffs();
    };

    // Export Buttons: Copy and Download PNG
    const copyBtn = document.createElement('button');
    copyBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-primary';
    copyBtn.innerHTML = '📋 Copy Image';
    copyBtn.title = 'Copy crisp solution canvas to clipboard';
    copyBtn.onclick = () => this.copySolutionImage(copyBtn);

    const dlBtn = document.createElement('button');
    dlBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
    dlBtn.innerHTML = '💾 Download PNG';
    dlBtn.onclick = () => this.downloadSolutionImage();

    toolbar.append(darkenGroup, blurGroup, thickGroup, colorGroup, orientBtn, undoBtn, clearBtn, copyBtn, dlBtn);
    root.appendChild(toolbar);

    // Viewport with Solution Canvas
    const viewport = document.createElement('div');
    viewport.className = 'fdr-solution-viewport';

    this.solutionCanvas = document.createElement('canvas');
    this.solutionCanvas.className = 'fdr-solution-canvas';
    viewport.appendChild(this.solutionCanvas);
    root.appendChild(viewport);

    this.solutionDialog.contentElement.appendChild(root);
    this.renderSolutionCanvas();
  }

  renderSolutionCanvas() {
    if (!this.solutionCanvas || !this.sourceImage) return;

    const crop = this.activeCrop || { x: 0, y: 0, width: this.naturalWidth, height: this.naturalHeight };
    const w = crop.width;
    const h = crop.height;

    this.solutionCanvas.width = w;
    this.solutionCanvas.height = h;
    const ctx = this.solutionCanvas.getContext('2d');

    // 1. Prepare Base & Overlay full-resolution patch canvases
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = w;
    cropCanvas.height = h;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(this.sourceImage, crop.x, crop.y, w, h, 0, 0, w, h);

    const baseCanvas = document.createElement('canvas');
    baseCanvas.width = w;
    baseCanvas.height = h;
    const baseCtx = baseCanvas.getContext('2d');

    // Calculate base alignment offset
    let baseOriginX = crop.x;
    let baseOriginY = crop.y;
    if (this.overlayDialog && this.overlayViewport && this.mainImgElement) {
      const mainRect = this.mainImgElement.getBoundingClientRect();
      const ovRect = this.overlayViewport.getBoundingClientRect();
      baseOriginX = (ovRect.left - mainRect.left) / this.zoom;
      baseOriginY = (ovRect.top - mainRect.top) / this.zoom;
    }

    baseCtx.drawImage(this.sourceImage, baseOriginX, baseOriginY, w, h, 0, 0, w, h);

    // 2. Render background scene (with blur and darkening applied)
    ctx.clearRect(0, 0, w, h);

    if (this.solutionBlur > 0) {
      ctx.save();
      ctx.filter = `blur(${this.solutionBlur}px)`;
      ctx.drawImage(cropCanvas, 0, 0);
      ctx.restore();
    } else {
      ctx.drawImage(cropCanvas, 0, 0);
    }

    // Apply Darkening overlay
    if (this.solutionDarken > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(0, 0, 0, ${this.solutionDarken})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }

    // 3. Render side-by-side touching circles at each difference
    const isH = this.solutionOrientation === 'horizontal';

    this.diffCircles.forEach((diff) => {
      const cx = diff.cropX;
      const cy = diff.cropY;
      const r = diff.radius;

      // Touching Centers: point of contact is exactly at (cx, cy)
      const c1x = isH ? cx - r : cx;
      const c1y = isH ? cy : cy - r;
      const c2x = isH ? cx + r : cx;
      const c2y = isH ? cy : cy + r;

      // Circle 1: Overlay / Crop Image 1 (Full opacity, crisp)
      ctx.save();
      ctx.beginPath();
      ctx.arc(c1x, c1y, r, 0, Math.PI * 2);
      ctx.clip();
      // Translate crop image so local feature at (cx, cy) lines up inside (c1x, c1y)
      const off1x = c1x - cx;
      const off1y = c1y - cy;
      ctx.drawImage(cropCanvas, off1x, off1y);
      ctx.restore();

      // Circle 2: Base Image 2 (Full opacity, crisp)
      ctx.save();
      ctx.beginPath();
      ctx.arc(c2x, c2y, r, 0, Math.PI * 2);
      ctx.clip();
      // Translate base image so local feature at (cx, cy) lines up inside (c2x, c2y)
      const off2x = c2x - cx;
      const off2y = c2y - cy;
      ctx.drawImage(baseCanvas, off2x, off2y);
      ctx.restore();

      // Colored Outlines: Touching/overlapping at (cx, cy)
      ctx.save();
      ctx.strokeStyle = this.solutionOutlineColor;
      ctx.lineWidth = this.solutionOutlineWidth;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 4;

      ctx.beginPath();
      ctx.arc(c1x, c1y, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(c2x, c2y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });

    if (this.solutionDialog) {
      this.solutionDialog.setTitle(`Difference Solution Studio (${this.diffCircles.length} Spotted)`);
    }
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