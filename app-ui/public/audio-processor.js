// Base64 encoding table
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeBase64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    result += chars[bytes[i] >> 2];
    result += chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
    result += chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
    result += chars[bytes[i + 2] & 63];
  }
  return result;
}

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4092; 
    this.buffer = new Int16Array(this.bufferSize);
    this.bytesWritten = 0;
    
    // VAD (Voice Activity Detection) State
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.speechFrames = 0;
    
    // INCREASED THRESHOLD: 0.05 requires actual speaking volume, ignoring fans/static.
    this.vadThreshold = 0.05; 
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      let maxVol = 0;

      for (let i = 0; i < channelData.length; i++) {
        let val = channelData[i];
        
        // Find the loudest peak in this audio frame
        if (Math.abs(val) > maxVol) {
          maxVol = Math.abs(val);
        }
        
        // Convert Float32 audio to PCM Int16
        let s = Math.max(-1, Math.min(1, val));
        this.buffer[this.bytesWritten++] = s < 0 ? s * 0x8000 : s * 0x7FFF;

        // When buffer is full, send Base64 back to frontend
        if (this.bytesWritten >= this.bufferSize) {
          const bytes = new Uint8Array(this.buffer.buffer);
          const base64 = encodeBase64(bytes);
          this.port.postMessage({ type: 'audio_data', audioBase64: base64 });
          this.bytesWritten = 0;
        }
      }

      // VAD Logic: ~8ms per frame
      if (maxVol > this.vadThreshold) {
        this.silenceFrames = 0;
        this.speechFrames++;
        
        // Require ~80ms of continuous sound to count as speech (ignores clicks/pops)
        if (!this.isSpeaking && this.speechFrames > 10) {
          this.isSpeaking = true;
          this.port.postMessage({ type: 'speech_start' });
        }
      } else {
        this.speechFrames = 0;
        this.silenceFrames++;
        
        // Require ~1 second of pure silence to end the turn
        if (this.isSpeaking && this.silenceFrames > 125) { 
          this.isSpeaking = false;
          this.port.postMessage({ type: 'end_of_turn' });
        }
      }
    }
    return true; // Keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);
