/**
 * Guida Frontend — WebSocket client with mic, camera, and audio playback.
 * Connects to FastAPI server which bridges to Gemini Live API via ADK.
 */

class GuidaApp {
  constructor() {
    this.ws = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.audioWorklet = null;
    this.cameraStream = null;
    this.cameraInterval = null;
    this.micActive = true;
    this.camActive = false;
    this.connected = false;

    // Audio playback queue
    this.audioQueue = [];
    this.isPlaying = false;

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
      // Initialize audio context
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

      // Set up audio capture via ScriptProcessor (AudioWorklet needs HTTPS)
      await this.setupAudioCapture();

      // Connect WebSocket
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      this.ws = new WebSocket(`${protocol}//${location.host}/ws`);

      this.ws.onopen = () => {
        this.connected = true;
        this.setStatus('connected', 'Connected to Guida');
        this.addChat('guida', 'Hello, dear! I\'m Guida. Tell me about your little one — how old is your baby?');
      };

      this.ws.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
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
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);

    // Use ScriptProcessor for broad compatibility
    // (AudioWorklet requires secure context + separate file)
    const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (!this.connected || !this.micActive) return;

      const inputData = e.inputBuffer.getChannelData(0);

      // Downsample from audioContext.sampleRate to 16000
      const ratio = this.audioContext.sampleRate / 16000;
      const outputLength = Math.floor(inputData.length / ratio);
      const pcm16 = new Int16Array(outputLength);

      for (let i = 0; i < outputLength; i++) {
        const srcIdx = Math.floor(i * ratio);
        const sample = Math.max(-1, Math.min(1, inputData[srcIdx]));
        pcm16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      }

      // Send as base64
      const b64 = this.arrayBufferToBase64(pcm16.buffer);
      this.sendWs({ type: 'audio', data: b64 });
    };

    source.connect(processor);
    processor.connect(this.audioContext.destination);
  }

  handleMessage(msg) {
    switch (msg.type) {
      case 'text':
        this.addChat(msg.author || 'guida', msg.data);
        break;

      case 'audio':
        this.queueAudio(msg.data, msg.mime_type);
        break;

      case 'tool_result':
        this.handleToolResult(msg.tool, msg.data);
        break;

      case 'tool_call':
        // Visual indicator that Guida is searching
        if (msg.tool === 'search_products') {
          this.addChat('guida', '🔍 Searching the catalog...');
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
      this.addChat('system', `Added to cart! Session: ${data.session_id.slice(0, 8)}...`);
    }
  }

  showProducts(products) {
    this.productCards.innerHTML = '';
    products.forEach(p => {
      const card = document.createElement('div');
      card.className = 'product-card';
      card.innerHTML = `
        <img src="${p.image_url || '/static/product-placeholder.svg'}"
             alt="${p.name}" onerror="this.src='/static/product-placeholder.svg'">
        <div class="product-info">
          <h4>${p.name || 'Product'}</h4>
          <div class="price">${this.formatPrice(p.price, p.currency)}</div>
          <div class="availability">${p.available === 'in_stock' || p.available === true ? 'In Stock' : p.available || ''}</div>
        </div>
        <button class="add-btn" data-id="${p.id}">Add to Cart</button>
      `;
      card.querySelector('.add-btn').addEventListener('click', () => {
        this.sendWs({ type: 'text', data: `Add "${p.name}" to my cart please` });
      });
      this.productCards.appendChild(card);
    });
  }

  formatPrice(price, currency = 'USD') {
    if (!price) return '';
    const num = typeof price === 'string' ? parseFloat(price) : price;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(num);
    } catch {
      return `$${num.toFixed(2)}`;
    }
  }

  queueAudio(b64Data, mimeType) {
    this.audioQueue.push(b64Data);
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
    const b64 = this.audioQueue.shift();
    const bytes = this.base64ToArrayBuffer(b64);

    // PCM 24kHz mono 16-bit → AudioBuffer
    const pcm16 = new Int16Array(bytes);
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

  addChat(author, text) {
    const div = document.createElement('div');
    div.className = `chat-msg ${author}`;
    div.textContent = text;
    this.chatArea.appendChild(div);
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  async toggleMic() {
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

        // Send frames at ~1 FPS
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
              this.sendWs({ type: 'video', data: b64 });
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
    this.sendWs({ type: 'end' });
    this.handleDisconnect();
  }

  handleDisconnect() {
    this.connected = false;
    this.setStatus('', 'Disconnected');

    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.cameraInterval) clearInterval(this.cameraInterval);
    if (this.cameraStream) this.cameraStream.getTracks().forEach(t => t.stop());
    if (this.mediaStream) this.mediaStream.getTracks().forEach(t => t.stop());

    this.startScreen.classList.remove('hidden');
  }

  sendWs(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  setStatus(state, text) {
    this.statusDot.className = `status-dot ${state}`;
    this.statusText.textContent = text;
  }

  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Boot
const app = new GuidaApp();
