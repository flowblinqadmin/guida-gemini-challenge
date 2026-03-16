/**
 * Guida Frontend — WebSocket client with mic, camera, and audio playback.
 * Connects to FastAPI server which bridges to Gemini Live API via ADK.
 *
 * Audio: sent as raw binary PCM (16kHz 16-bit mono) for efficiency.
 * Camera: sent as base64 JPEG via JSON envelope.
 * Responses: audio arrives as raw binary, text/tools as JSON.
 */

class GuidaApp {
  constructor() {
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.cameraStream = null;
    this.cameraInterval = null;
    this.micActive = true;
    this.camActive = false;
    this.connected = false;

    // Audio playback queue
    this.audioQueue = [];
    this.isPlaying = false;

    // Gate: don't send mic audio until first response arrives
    // (prevents mic noise from interrupting Gemini's greeting)
    this._allowMicSend = false;

    // Session IDs
    this.userId = 'user_' + Math.random().toString(36).slice(2, 10);
    this.sessionId = 'session_' + Math.random().toString(36).slice(2, 10);

    // DOM refs
    this.startScreen = document.getElementById('startScreen');
    this.startBtn = document.getElementById('startBtn');
    this.statusDot = document.getElementById('statusDot');
    this.statusText = document.getElementById('statusText');
    this.chatArea = document.getElementById('chatArea');
    this.productCards = document.getElementById('productCards');
    this.guidaAvatar = document.getElementById('guidaAvatar');
    this.guidaIdle = document.getElementById('guidaIdle');
    this.guidaSpeaking = document.getElementById('guidaSpeaking');
    this.cameraFeed = document.getElementById('cameraFeed');
    this.micBtn = document.getElementById('micBtn');
    this.camBtn = document.getElementById('camBtn');
    this.endBtn = document.getElementById('endBtn');
    this.cartPanel = document.getElementById('cartPanel');
    this.productCardsHeader = document.getElementById('productCardsHeader');
    this.checkoutSuccess = document.getElementById('checkoutSuccess');
    this.orderDetails = document.getElementById('orderDetails');
    this.continueBtn = document.getElementById('continueBtn');

    // Cart state — accumulates across multiple add_to_cart calls
    this.cartItems = []; // [{product_id, title, quantity, price, image_url}]
    this.cartSessionId = null;

    this.bindEvents();
  }

  bindEvents() {
    this.startBtn.addEventListener('click', () => this.start());
    this.micBtn.addEventListener('click', () => this.toggleMic());
    this.camBtn.addEventListener('click', () => this.toggleCamera());
    this.endBtn.addEventListener('click', () => this.end());
    this.continueBtn.addEventListener('click', () => {
      this.checkoutSuccess.classList.remove('visible');
    });
  }

  async start() {
    this.startScreen.classList.add('hidden');
    this.setStatus('connecting', 'Connecting...');
    console.log('[guida] Starting...');

    try {
      // Audio context for playback — use default sample rate, we specify per-buffer
      this.audioContext = new AudioContext();
      console.log(`[guida] Playback AudioContext: ${this.audioContext.sampleRate}Hz, state=${this.audioContext.state}`);

      // Get microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      console.log('[guida] Mic acquired');

      await this.setupAudioCapture();

      // Connect WebSocket with user_id/session_id in path
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${location.host}/ws/${this.userId}/${this.sessionId}`;
      console.log(`[guida] Connecting WS: ${wsUrl}`);
      this.ws = new WebSocket(wsUrl);
      this.ws.binaryType = 'arraybuffer';  // Receive audio as ArrayBuffer

      this.ws.onopen = () => {
        this.connected = true;
        this.setStatus('connected', 'Connected — waiting for Guida...');
        console.log('[guida] WS connected');
        // Resume AudioContext (browsers require user gesture)
        this.audioContext.resume().then(() => {
          console.log(`[guida] Playback AudioContext resumed: state=${this.audioContext.state}`);
        });
        if (this._captureCtx && this._captureCtx.state === 'suspended') {
          this._captureCtx.resume().then(() => {
            console.log(`[guida] Capture AudioContext resumed: state=${this._captureCtx.state}`);
          });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            console.log(`[ws] Audio: ${event.data.byteLength} bytes`);
            this.queueAudio(event.data);
          } else {
            const text = typeof event.data === 'string' ? event.data : '';
            console.log(`[ws] Text: ${text.substring(0, 120)}`);
            if (text) {
              this.handleMessage(JSON.parse(text));
            }
          }
        } catch (err) {
          console.error('[ws] Message handling error:', err);
        }
      };

      this.ws.onclose = (e) => {
        console.log(`[ws] Closed: code=${e.code} reason=${e.reason} wasClean=${e.wasClean}`);
        this.handleDisconnect();
      };
      this.ws.onerror = (e) => {
        console.error('[ws] Error event:', e);
        this.setStatus('', 'Connection error');
      };
    } catch (err) {
      console.error('[guida] Start failed:', err);
      this.setStatus('', `Error: ${err.message}`);
      this.startScreen.classList.remove('hidden');
    }
  }

  async setupAudioCapture() {
    // Use a separate AudioContext for mic capture (avoids sample rate conflicts)
    this._captureCtx = new AudioContext();
    console.log(`[guida] Capture AudioContext: ${this._captureCtx.sampleRate}Hz`);

    const source = this._captureCtx.createMediaStreamSource(this.mediaStream);
    const processor = this._captureCtx.createScriptProcessor(4096, 1, 1);

    let chunkCount = 0;
    processor.onaudioprocess = (e) => {
      if (!this.connected || !this.micActive || !this._allowMicSend) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Detect if user is actually speaking (not just background noise)
      let maxAmp = 0;
      for (let i = 0; i < inputData.length; i += 16) {
        const abs = Math.abs(inputData[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      // If user is speaking loudly enough, interrupt Guida's playback
      if (maxAmp > 0.02 && this.isPlaying) {
        this.interruptPlayback();
      }

      // Downsample to 16kHz
      const ratio = this._captureCtx.sampleRate / 16000;
      const outputLength = Math.floor(inputData.length / ratio);
      const pcm16 = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        const sample = Math.max(-1, Math.min(1, inputData[srcIdx]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      try {
        this.ws.send(pcm16.buffer);
        chunkCount++;
        if (chunkCount <= 3 || chunkCount % 100 === 0) {
          console.log(`[mic] Sent chunk #${chunkCount}: ${pcm16.buffer.byteLength}b`);
        }
      } catch (err) {
        console.error('[mic] Send error:', err);
      }
    };

    source.connect(processor);
    // Connect to a silent destination to keep the processor alive
    const silentGain = this._captureCtx.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(this._captureCtx.destination);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'text':
        this.addChat(msg.author || 'guida', msg.data);
        break;

      case 'tool_result':
        this.handleToolResult(msg.tool, msg.data);
        break;

      case 'tool_call':
        if (msg.tool === 'search_products') {
          this.addChat('system', 'Searching the catalog...');
        } else if (msg.tool === 'add_to_cart') {
          this.addChat('system', 'Adding to cart...');
        } else if (msg.tool === 'get_product_details') {
          this.addChat('system', 'Getting product details...');
        } else if (msg.tool === 'check_availability') {
          this.addChat('system', 'Checking availability...');
        }
        break;

      case 'interrupted':
        console.log('[guida] Server says interrupted — flushing audio');
        this.interruptPlayback();
        break;

      case 'error':
        console.error('Server error:', msg.data);
        this.addChat('system', `Error: ${msg.data}`);
        break;
    }
  }

  handleToolResult(tool, data) {
    console.log(`[tool_result] tool=${tool}`, JSON.stringify(data).substring(0, 200));
    if (tool === 'search_products' && data?.products) {
      this.showProducts(data.products);
    } else if (tool === 'get_product_details' && data?.id) {
      this.showProducts([data]);
    } else if (tool === 'add_to_cart' && data?.session_id) {
      this.cartSessionId = data.session_id;
      // Accumulate new items into cart
      const newItems = data.line_items || [];
      for (const item of newItems) {
        const existing = this.cartItems.find(c => c.product_id === item.product_id);
        if (existing) {
          existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
        } else {
          this.cartItems.push({ ...item });
        }
      }
      this.showCart();
      const itemName = newItems[0]?.title || 'Item';
      this.addChat('system', `Added ${itemName} to cart. Tap "Checkout Now" below!`);
      // Mark product cards as added
      this.productCards.querySelectorAll('.add-btn').forEach(btn => {
        if (btn.textContent === 'Adding...') {
          btn.textContent = 'Added';
          btn.style.background = 'rgba(76, 175, 80, 0.2)';
          btn.style.borderColor = 'rgba(76, 175, 80, 0.4)';
          btn.style.color = '#81c784';
          btn.style.opacity = '1';
        }
      });
    } else if (tool === 'add_to_cart' && data?.error) {
      this.addChat('system', `Could not add to cart: ${data.error}`);
      this.productCards.querySelectorAll('.add-btn').forEach(btn => {
        if (btn.textContent === 'Adding...') {
          btn.textContent = 'Add to Cart';
          btn.style.opacity = '1';
          btn.disabled = false;
        }
      });
    } else if (tool === 'get_cart' && data?.id) {
      this.cart = {
        session_id: data.id,
        line_items: data.line_items || [],
        totals: data.totals || {},
        status: data.status,
      };
      this.showCart(this.cart);
    }
  }

  showProducts(products) {
    this.productCards.innerHTML = '';
    this.productCardsHeader.textContent = 'Products';
    products.forEach(p => {
      const card = document.createElement('div');
      card.className = 'product-card';

      const name = this.escapeHtml(p.name || p.title || 'Product');
      const imgSrc = p.image_url || p.image_link || '/static/product-placeholder.svg';

      card.innerHTML = `
        <img src="${this.escapeHtml(imgSrc)}"
             alt="${name}" onerror="this.src='/static/product-placeholder.svg'">
        <div class="product-info">
          <h4>${name}</h4>
          <div class="price">${this.formatPrice(p.price, p.currency)}</div>
          <div class="availability">${
            p.available === 'in_stock' || p.available === true
              ? 'In Stock'
              : this.escapeHtml(String(p.available || ''))
          }</div>
        </div>
        <button class="add-btn">Add to Cart</button>
      `;

      const addBtn = card.querySelector('.add-btn');
      addBtn.addEventListener('click', () => {
        addBtn.textContent = 'Adding...';
        addBtn.style.opacity = '0.6';
        addBtn.disabled = true;
        this.sendJson({ type: 'text', data: `Add "${p.name || p.title}" to my cart` });
      });
      this.productCards.appendChild(card);
    });
  }

  showCart() {
    this.cartPanel.classList.add('visible');
    const items = this.cartItems;
    const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.price) || 0) * (i.quantity || 1), 0);

    let html = `
      <div class="cart-header">
        <h3>Cart (${items.length} item${items.length !== 1 ? 's' : ''})</h3>
      </div>
    `;

    items.forEach(item => {
      const imgSrc = item.image_url || '/static/product-placeholder.svg';
      const lineTotal = (parseFloat(item.price) || 0) * (item.quantity || 1);
      html += `
        <div class="cart-item">
          <img src="${this.escapeHtml(imgSrc)}" alt="" onerror="this.src='/static/product-placeholder.svg'">
          <div class="cart-item-info">
            <div class="name">${this.escapeHtml(item.title || item.name || 'Item')}</div>
            <div class="qty">Qty: ${item.quantity || 1}</div>
          </div>
          <div class="cart-item-price">${this.formatPrice(lineTotal, 'USD')}</div>
        </div>
      `;
    });

    html += `<div class="cart-totals">`;
    html += `<div class="cart-total-row total"><span>Total</span><span>${this.formatPrice(subtotal, 'USD')}</span></div>`;
    html += `</div>`;

    html += `<button class="checkout-btn pulse" id="checkoutBtn">Checkout Now — ${this.formatPrice(subtotal, 'USD')}</button>`;
    this.cartPanel.innerHTML = html;

    this.cartPanel.querySelector('#checkoutBtn').addEventListener('click', () => {
      this.handleCheckout();
    });
  }

  handleCheckout() {
    const items = this.cartItems;
    const subtotal = items.reduce((sum, i) => sum + (parseFloat(i.price) || 0) * (i.quantity || 1), 0);

    let detailsHtml = `<strong>${items.length} item${items.length !== 1 ? 's' : ''}</strong><br>`;
    items.forEach(item => {
      detailsHtml += `${this.escapeHtml(item.title || item.name || 'Item')} x${item.quantity || 1}<br>`;
    });
    detailsHtml += `<br><strong>Total: ${this.formatPrice(subtotal, 'USD')}</strong>`;
    detailsHtml += `<br><span style="font-size:12px;color:rgba(180,210,255,0.4)">Order #${(this.cartSessionId || '').slice(0, 8)}</span>`;

    this.orderDetails.innerHTML = detailsHtml;
    this.checkoutSuccess.classList.add('visible');

    // Clear cart
    this.cartItems = [];
    this.cartSessionId = null;
    this.cartPanel.classList.remove('visible');
    this.cartPanel.innerHTML = '';

    // Tell Guida the order was placed
    this.sendJson({ type: 'text', data: 'I just completed checkout. Confirm my order is placed.' });
  }

  formatPrice(price, currency = 'USD') {
    if (!price) return '';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (isNaN(num)) return '';
    // Force USD — checkout API has hardcoded INR but products are USD
    const cur = 'USD';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(num);
    } catch {
      return `$${num.toFixed(2)}`;
    }
  }

  interruptPlayback() {
    if (!this.isPlaying) return;
    console.log('[guida] Interrupting playback — user speaking');
    this.audioQueue = [];
    this.isPlaying = false;
    this._nextStartTime = 0;
    // Stop all scheduled sources
    if (this._activeSources) {
      for (const src of this._activeSources) {
        try { src.stop(); } catch {}
      }
      this._activeSources = [];
    }
    this.setSpeaking(false);
    this.setStatus('connected', 'Connected to Guida');
  }

  // --- Audio Playback (gapless scheduled with gain node) ---

  queueAudio(arrayBuffer) {
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return;

    this.audioQueue.push(arrayBuffer);
    this.setSpeaking(true);
    this.setStatus('connected', 'Guida is speaking...');

    // First audio received — enable mic sending after a short delay
    if (!this._allowMicSend) {
      console.log('[guida] First audio received — enabling mic in 1s');
      setTimeout(() => {
        this._allowMicSend = true;
        console.log('[guida] Mic sending enabled');
      }, 1000);
    }

    if (!this.isPlaying) this.scheduleAudio();
  }

  scheduleAudio() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      this._speakingTimeout = setTimeout(() => {
        if (!this.isPlaying) {
          this.setSpeaking(false);
          this.setStatus('connected', 'Connected to Guida');
        }
      }, 400);
      return;
    }

    if (this._speakingTimeout) {
      clearTimeout(this._speakingTimeout);
      this._speakingTimeout = null;
    }

    this.isPlaying = true;
    if (!this._activeSources) this._activeSources = [];

    // Ensure gain node for smooth output
    if (!this._gainNode) {
      this._gainNode = this.audioContext.createGain();
      this._gainNode.gain.value = 1.0;
      this._gainNode.connect(this.audioContext.destination);
    }

    // Start scheduling from now if we've fallen behind
    const now = this.audioContext.currentTime;
    if (!this._nextStartTime || this._nextStartTime < now) {
      this._nextStartTime = now + 0.01; // tiny buffer to avoid underruns
    }

    // Schedule all queued chunks
    let lastSource = null;
    while (this.audioQueue.length > 0) {
      const buffer = this.audioQueue.shift();
      try {
        const pcm16 = new Int16Array(buffer);
        const float32 = new Float32Array(pcm16.length);
        for (let i = 0; i < pcm16.length; i++) {
          float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
        }

        const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
        audioBuffer.getChannelData(0).set(float32);

        const source = this.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this._gainNode);
        source.start(this._nextStartTime);
        this._nextStartTime += audioBuffer.duration;

        this._activeSources.push(source);
        lastSource = source;

        // Clean up finished sources
        source.onended = () => {
          const idx = this._activeSources.indexOf(source);
          if (idx >= 0) this._activeSources.splice(idx, 1);
        };
      } catch (err) {
        console.error('[audio] Playback error:', err);
      }
    }

    // When the last chunk ends, check for more or stop
    if (lastSource) {
      lastSource.onended = () => {
        const idx = this._activeSources.indexOf(lastSource);
        if (idx >= 0) this._activeSources.splice(idx, 1);
        if (this.audioQueue.length > 0) {
          this.scheduleAudio();
        } else {
          this.isPlaying = false;
          this._speakingTimeout = setTimeout(() => {
            if (!this.isPlaying) {
              this.setSpeaking(false);
              this.setStatus('connected', 'Connected to Guida');
            }
          }, 400);
        }
      };
    }
  }

  /** Crossfade between idle and speaking video clips */
  setSpeaking(speaking) {
    if (!this.guidaSpeaking || !this.guidaIdle) return;
    if (speaking && !this._isSpeaking) {
      this._isSpeaking = true;
      this.guidaAvatar.classList.add('speaking');
      this.guidaSpeaking.currentTime = Math.random() * 2;
      this.guidaSpeaking.playbackRate = 0.9 + Math.random() * 0.2;
      this.guidaSpeaking.style.opacity = '1';
      this.guidaSpeaking.play().catch(() => {});
    } else if (!speaking && this._isSpeaking) {
      this._isSpeaking = false;
      this.guidaAvatar.classList.remove('speaking');
      this.guidaSpeaking.style.opacity = '0';
    }
  }

  // --- Chat ---

  addChat(author, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${author}`;
    div.textContent = text;
    this.chatArea.appendChild(div);
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  // --- Controls ---

  toggleMic() {
    this.micActive = !this.micActive;
    this.micBtn.classList.toggle('active', this.micActive);
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach(t => t.enabled = this.micActive);
    }
    console.log(`[guida] Mic: ${this.micActive ? 'on' : 'off'}`);
  }

  async toggleCamera() {
    this.camActive = !this.camActive;
    this.camBtn.classList.toggle('active', this.camActive);

    if (this.camActive) {
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 768, height: 768, facingMode: 'environment' }
        });
        this.cameraFeed.srcObject = this.cameraStream;
        this.cameraFeed.classList.add('active');

        const canvas = document.createElement('canvas');
        canvas.width = 768;
        canvas.height = 768;
        const ctx = canvas.getContext('2d');

        this.cameraInterval = setInterval(() => {
          if (!this.connected || !this.camActive) return;
          ctx.drawImage(this.cameraFeed, 0, 0, 768, 768);
          canvas.toBlob((blob) => {
            if (!blob) return;
            const reader = new FileReader();
            reader.onload = () => {
              const b64 = reader.result.split(',')[1];
              this.sendJson({ type: 'image', data: b64, mimeType: 'image/jpeg' });
            };
            reader.readAsDataURL(blob);
          }, 'image/jpeg', 0.7);
        }, 1000);
      } catch (err) {
        console.error('Camera error:', err);
        this.camActive = false;
        this.camBtn.classList.remove('active');
      }
    } else {
      if (this.cameraInterval) clearInterval(this.cameraInterval);
      if (this.cameraStream) {
        this.cameraStream.getTracks().forEach(t => t.stop());
        this.cameraFeed.srcObject = null;
        this.cameraFeed.classList.remove('active');
      }
    }
  }

  end() {
    this.sendJson({ type: 'end' });
    this.handleDisconnect();
  }

  handleDisconnect() {
    this.connected = false;
    this._allowMicSend = false;
    this.setStatus('', 'Disconnected');

    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.cameraInterval) clearInterval(this.cameraInterval);
    if (this.cameraStream) this.cameraStream.getTracks().forEach(t => t.stop());
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
    if (this._captureCtx) this._captureCtx.close().catch(() => {});

    this.audioQueue = [];
    this.isPlaying = false;
    this.startScreen.classList.remove('hidden');
  }

  // --- Helpers ---

  sendJson(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  setStatus(state, text) {
    this.statusDot.className = `status-dot ${state}`;
    this.statusText.textContent = text;
  }

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}

// Boot
const app = new GuidaApp();
