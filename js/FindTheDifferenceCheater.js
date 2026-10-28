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
      const dlgW = Math.max(280, dispCropW + 4);
      const dlgH = dispCropH + 32 + 42; // Header (32px) + Toolbar (42px)

      const mainRect = this.mainDialog ? this.mainDialog.element.getBoundingClientRect() : { left: 40, top: 40 };
      const posX = Math.min(window.innerWidth - dlgW - 20, Math.max(10, mainRect.left + 50));
      const posY = Math.min(window.innerHeight - dlgH - 20, Math.max(10, mainRect.top + 50));

      // Create the overlay dialog with contentTransparent API so title bars stay solid while content is see-through
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

      this.overlayViewport.appendChild(this.overlayClippedImg);
      content.appendChild(this.overlayViewport);

      // Overlay Bottom Controls: Stripes Mode, Flash, Opacity presets, Nudge
      const toolbar = document.createElement('div');
      toolbar.className = 'fdr-overlay-toolbar';

      // Secondary toolbar for Stripe width, speed, pause controls
      const stripeToolbar = document.createElement('div');
      stripeToolbar.className = 'fdr-stripe-toolbar';

      const stripesBtn = document.createElement('button');
      stripesBtn.className = 'fdr-btn fdr-btn-sm fdr-btn-accent';
      stripesBtn.innerHTML = '▤ Stripes';
      stripesBtn.title = 'Scrolling alternating stripes of overlay image vs underlying image';

      const flashBtn = document.createElement('button');
      flashBtn.className = 'fdr-btn fdr-btn-sm';
      flashBtn.innerHTML = '⚡ Flash';
      flashBtn.title = 'Blink overlay between transparent and opaque';

      const opGroup = document.createElement('div');
      opGroup.className = 'fdr-toolbar-group';
      const opBtns = [25, 50, 75, 100].map(pct => {
        const b = document.createElement('button');
        b.className = `fdr-btn fdr-btn-sm${pct === 50 ? ' active' : ''}`;
        b.textContent = `${pct}%`;
        b.onclick = () => {
          this.stopFlashing();
          this.stopStripes();
          stripesBtn.classList.remove('active');
          flashBtn.classList.remove('active');
          opBtns.forEach(btn => btn.classList.remove('active'));
          b.classList.add('active');
          stripeToolbar.style.display = 'none';
          this.setOverlayOpacity(pct / 100);
        };
        opGroup.appendChild(b);
        return b;
      });

      stripesBtn.onclick = () => {
        this.stopFlashing();
        flashBtn.classList.remove('active');
        opBtns.forEach(btn => btn.classList.remove('active'));
        stripesBtn.classList.add('active');
        stripeToolbar.style.display = 'flex';
        this.startStripes();
      };

      flashBtn.onclick = () => {
        this.stopStripes();
        stripesBtn.classList.remove('active');
        opBtns.forEach(btn => btn.classList.remove('active'));
        stripeToolbar.style.display = 'none';
        this.toggleFlash(flashBtn);
      };

      // Stripe Toolbar Items: Play/Pause, Direction, Width Slider, Speed Slider
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

      toolbar.append(stripesBtn, opGroup, flashBtn, nudgeGrid);
      content.appendChild(toolbar);
      content.appendChild(stripeToolbar);

      this.updateOverlayGeometry();
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

      const targetDlgW = Math.max(260, dispCropW + 4);
      const targetDlgH = dispCropH + 32 + 38;
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
  }

  destroy() {
      this.stopFlashing();
      this.stopStripes();
      window.removeEventListener('paste', this._onPaste);
      window.removeEventListener('keydown', this._onKeyDown);
      if (this.overlayDialog) this.overlayDialog.close();
      if (this.mainDialog) this.mainDialog.close();
    }

  generateDiffWindow() {
      // Differencing window removed per request
    }

  _computeDiffCanvas() {
      // Differencing computation removed per request
    }
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
      // Hard-stop gradient mask creating alternating 100% opaque and 100% transparent strips
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
}

globalThis.FindTheDifferenceCheater = FindTheDifferenceCheater;
if (typeof module !== 'undefined' && module.exports) module.exports = FindTheDifferenceCheater;