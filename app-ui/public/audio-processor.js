class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioBuffer = [];
    this.bufferSize = 4096; // Send chunk size
    this.gain = 2.0; // Lowered slightly to prevent microphone clipping
  }

  float32To16BitPCMBase64(buffer) {
    let pcm16Buffer = new ArrayBuffer(buffer.length * 2);
    let view = new DataView(pcm16Buffer);
    for (let i = 0; i < buffer.length; i++) {
      let s = Math.max(-1, Math.min(1, buffer[i] * this.gain));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    let binary = '';
    let bytes = new Uint8Array(pcm16Buffer);
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      // Simply buffer and send continuously
      this.audioBuffer.push(...channelData);

      while (this.audioBuffer.length >= this.bufferSize) {
        const chunkToSend = this.audioBuffer.slice(0, this.bufferSize);
        this.audioBuffer = this.audioBuffer.slice(this.bufferSize);

        const audioBase64 = this.float32To16BitPCMBase64(chunkToSend);
        
        this.port.postMessage({ 
          type: 'audio_data', 
          audioBase64: audioBase64 
        });
      }
    }
    return true; 
  }
}
registerProcessor('audio-processor', AudioProcessor);
