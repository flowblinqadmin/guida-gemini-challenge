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
    this.cameraFeed = document.getElementById('cameraFeed');
    this.micBtn = document.getElementById('micBtn');
    this.camBtn = document.getElementById('camBtn');
    this.endBtn = document.getElementById('endBtn');

    this.bindEvents();
  }

  bindEvents() {
    this.startBtn.addEventListener('click', () => this.start());
    this.micBtn.addEventListener('click', () => this.toggleMic());
    this.camBtn.addEventListener('click', () => this.toggleCamera());
    this.endBtn.addEventListener('click', () => this.end());
  }

  async start() {
    this.startScreen.classList.add('hidden');
    this.setStatus('connecting', 'Connecting...');

    try {
      // Audio context at 24kHz for playback (Gemini outputs 24kHz PCM)
      this.audioContext = new AudioContext({ sampleRate: 24000 });

      // Get microphone
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        }
      });

      await this.setupAudioCapture();

      // Connect WebSocket with user_id/session_id in path
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(
        `${protocol}//${location.host}/ws/${this.userId}/${this.sessionId}`
      );
      this.ws.binaryType = 'arraybuffer';  // Receive audio as ArrayBuffer

      this.ws.onopen = () => {
        this.connected = true;
        this.setStatus('connected', 'Connected to Guida');
      };

      this.ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary = audio response from Gemini
          this.queueAudio(event.data);
        } else {
          // Text = JSON (text transcript, tool calls, tool results, errors)
          this.handleMessage(JSON.parse(event.data));
        }
      };

      this.ws.onclose = () => this.handleDisconnect();
      this.ws.onerror = (e) => {
        console.error('WebSocket error:', e);
        this.setStatus('', 'Connection error');
      };
    } catch (err) {
      console.error('Start failed:', err);
      this.setStatus('', `Error: ${err.message}`);
      this.startScreen.classList.remove('hidden');
    }
  }

  async setupAudioCapture() {
    // Create a separate context for capture at native rate
    const captureCtx = new AudioContext();
    const source = captureCtx.createMediaStreamSource(this.mediaStream);
    const processor = captureCtx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!this.connected || !this.micActive) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Downsample to 16kHz
      const ratio = captureCtx.sampleRate / 16000;
      const outputLength = Math.floor(inputData.length / ratio);
      const pcm16 = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        const sample = Math.max(-1, Math.min(1, inputData[srcIdx]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      // Send as raw binary (most efficient — matches bidi-demo pattern)
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(pcm16.buffer);
      }
    };

    source.connect(processor);
    processor.connect(captureCtx.destination);
    this._captureCtx = captureCtx;
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
        }
        break;

      case 'error':
        console.error('Server error:', msg.data);
        this.addChat('system', `Error: ${msg.data}`);
        break;
    }
  }

  handleToolResult(tool, data) {
    if (tool === 'search_products' && data?.products) {
      this.showProducts(data.products);
    } else if (tool === 'get_product_details' && data?.id) {
      this.showProducts([data]);
    } else if (tool === 'add_to_cart' && data?.session_id) {
      this.addChat('system', `Added to cart!`);
    }
  }

  showProducts(products) {
    this.productCards.innerHTML = '';
    products.forEach(p => {
      const card = document.createElement('div');
      card.className = 'product-card';

      const name = this.escapeHtml(p.name || 'Product');
      const imgSrc = p.image_url || '/static/product-placeholder.svg';

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

      card.querySelector('.add-btn').addEventListener('click', () => {
        this.sendJson({ type: 'text', data: `Add "${p.name}" to my cart` });
      });
      this.productCards.appendChild(card);
    });
  }

  formatPrice(price, currency = 'USD') {
    if (!price) return '';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    if (isNaN(num)) return '';
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(num);
    } catch {
      return `$${num.toFixed(2)}`;
    }
  }

  // --- Audio Playback ---

  queueAudio(arrayBuffer) {
    this.audioQueue.push(arrayBuffer);
    this.guidaAvatar.classList.add('speaking');
    if (!this.isPlaying) this.playNextAudio();
  }

  async playNextAudio() {
    if (this.audioQueue.length === 0) {
      this.isPlaying = false;
      this.guidaAvatar.classList.remove('speaking');
      return;
    }

    this.isPlaying = true;
    const buffer = this.audioQueue.shift();

    // PCM 24kHz mono 16-bit LE → Float32
    const pcm16 = new Int16Array(buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
    }

    const audioBuffer = this.audioContext.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    source.onended = () => this.playNextAudio();
    source.start();
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

        const canvas = document.createElement('canvas');
        canvas.width = 768;
        canvas.height = 768;
        const ctx = canvas.getContext('2d');

        // Send JPEG frames at ~1 FPS via JSON (image type)
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
      }
    }
  }

  end() {
    this.sendJson({ type: 'end' });
    this.handleDisconnect();
  }

  handleDisconnect() {
    this.connected = false;
    this.setStatus('', 'Disconnected');

    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.cameraInterval) clearInterval(this.cameraInterval);
    if (this.cameraStream) this.cameraStream.getTracks().forEach(t => t.stop());
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());
    if (this._captureCtx) this._captureCtx.close();

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
