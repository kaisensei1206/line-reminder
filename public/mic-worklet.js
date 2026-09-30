// 把麥克風聲音切成小段（16kHz、16 位元），交給主程式送出去
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600); // 0.1 秒
    this.len = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.len === this.buf.length) {
          this.port.postMessage(this.buf.slice().buffer, []);
          this.len = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-processor', MicProcessor);
