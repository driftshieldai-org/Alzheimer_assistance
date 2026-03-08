// Add this to the Audio Worklet to detect silence
const AUDIO_WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.BUFFER_SIZE = 2048;
    this.silenceThreshold = 0.01;
    this.silentFrames = 0;
    this.SILENCE_FRAMES_THRESHOLD = 50; // ~1.5 seconds at 16kHz
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    
    const channelData = input[0];
    
    // Calculate RMS for silence detection
    let sum = 0;
    for (let i = 0; i < channelData.length; i++) {
      sum += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sum / channelData.length);
    
    // Track silence
    if (rms < this.silenceThreshold) {
      this.silentFrames++;
      if (this.silentFrames === this.SILENCE_FRAMES_THRESHOLD) {
        this.port.postMessage({ type: 'silence_detected' });
      }
    } else {
      this.silentFrames = 0;
    }
    
    for (let i = 0; i < channelData.length; i++) {
      this.buffer.push(channelData[i]);
    }

    while (this.buffer.length >= this.BUFFER_SIZE) {
      const chunk = this.buffer.splice(0, this.BUFFER_SIZE);
      
      const pcmData = new ArrayBuffer(chunk.length * 2);
      const view = new DataView(pcmData);
      
      for (let i = 0; i < chunk.length; i++) {
        const sample = Math.max(-1, Math.min(1, chunk[i]));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(i * 2, int16, true);
      }
      
      this.port.postMessage({ type: 'audio', buffer: pcmData }, [pcmData]);
    }
    
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

// In startMicCapture, handle silence detection:
workletNode.port.onmessage = (event) => {
  if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
  
  const { type, buffer } = event.data;
  
  if (type === 'audio' && buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = window.btoa(binary);
    wsRef.current.send(JSON.stringify({ type: "audio", audioBase64: base64 }));
  }
  
  // When silence is detected, signal end of turn
  if (type === 'silence_detected') {
    console.log("🔇 Silence detected, signaling end of turn");
    wsRef.current.send(JSON.stringify({ type: "endTurn" }));
  }
};
