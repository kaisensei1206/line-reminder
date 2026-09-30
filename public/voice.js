// 語音對話：麥克風 → Gemini 3.8 Live → 喇叭
// Gemini 決定要建立提醒時，會請我們呼叫 create_reminder，我們再交給雲端建立。

const toBase64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export class VoiceChat {
  constructor({ onState, onCreated, onError }) {
    this.onState = onState;
    this.onCreated = onCreated;
    this.onError = onError;
    this.active = false;
  }

  async start() {
    this.active = true;
    this.onState('connecting');

    // 喇叭（Gemini 回傳 24kHz 的聲音）與麥克風要在點擊當下建立，手機才允許出聲
    this.speaker = new AudioContext({ sampleRate: 24000 });
    this.mic = new AudioContext({ sampleRate: 16000 });
    this.playAt = 0;
    this.playing = new Set();

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      this.stop();
      this.onError('需要允許使用麥克風，才能用說的建立提醒');
      return;
    }

    const res = await fetch('/api/voice/session', { method: 'POST' });
    const session = await res.json().catch(() => ({}));
    if (!res.ok || !this.active) {
      this.stop();
      if (res.ok === false) this.onError(session.error || '無法開始對話');
      return;
    }

    this.ws = new WebSocket(session.url);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ setup: session.setup }));
    this.ws.onmessage = (e) => this.handle(e.data);
    this.ws.onerror = () => this.fail('連線中斷了，請再按一次麥克風');
    this.ws.onclose = (e) => {
      if (this.active) this.fail(e.code === 1000 ? '對話結束了' : '連線中斷了，請再按一次麥克風');
    };
  }

  async startMic() {
    await this.mic.audioWorklet.addModule('/mic-worklet.js');
    const src = this.mic.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.mic, 'mic-processor');
    this.node.port.onmessage = (e) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: toBase64(e.data), mimeType: 'audio/pcm;rate=16000' } } }));
      }
    };
    src.connect(this.node);
  }

  async handle(raw) {
    const text = typeof raw === 'string' ? raw : await raw.text();
    const msg = JSON.parse(text);

    if (msg.setupComplete) {
      await this.startMic();
      this.onState('listening');
      // 請 AI 先打招呼
      this.ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '（開始）' }] }], turnComplete: true } }));
      return;
    }

    const sc = msg.serverContent;
    if (sc) {
      if (sc.interrupted) this.stopPlayback();
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) this.play(part.inlineData.data);
      }
    }

    if (msg.toolCall) {
      const responses = [];
      for (const call of msg.toolCall.functionCalls || []) {
        let result;
        if (call.name === 'create_reminder') {
          const r = await fetch('/api/voice/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(call.args || {}),
          });
          result = await r.json().catch(() => ({ ok: false, reason: '系統發生錯誤' }));
          if (result.ok) this.onCreated();
        } else {
          result = { ok: false, reason: '不支援的動作' };
        }
        responses.push({ id: call.id, name: call.name, response: result });
      }
      this.ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
    }

    if (msg.goAway) this.fail('對話時間到了，請再按一次麥克風');
  }

  play(b64) {
    const bin = atob(b64);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
    const buf = this.speaker.createBuffer(1, pcm.length, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.speaker.createBufferSource();
    src.buffer = buf;
    src.connect(this.speaker.destination);
    this.playAt = Math.max(this.playAt, this.speaker.currentTime + 0.05);
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.playing.add(src);
    this.onState('speaking');
    src.onended = () => {
      this.playing.delete(src);
      if (!this.playing.size && this.active) this.onState('listening');
    };
  }

  stopPlayback() {
    for (const s of this.playing) s.stop();
    this.playing.clear();
    this.playAt = 0;
  }

  fail(message) {
    this.stop();
    this.onError(message);
  }

  stop() {
    this.active = false;
    try { this.ws?.close(1000); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.mic?.close().catch(() => {});
    this.speaker?.close().catch(() => {});
    this.ws = this.stream = this.node = this.mic = this.speaker = null;
    this.onState('idle');
  }
}
