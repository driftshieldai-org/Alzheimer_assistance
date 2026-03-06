// Base64 encoding table (AudioWorklet does not have access to window.btoa)
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeBase64(bytes) {
  let result = '';
  // Loop through bytes in chunks of 3 to avoid needing padding characters
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
    // 4092 Int16s = 8184 bytes (evenly divisible by 3 for clean Base64 encoding)
    this.bufferSize = 4092; 
    this.buffer = new Int16Array(this.bufferSize);
    this.bytesWritten = 0;
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.vadThreshold = 0.02; // Volume threshold for speech detection
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      let hasSpeech = false;

      for (let i = 0; i < channelData.length; i++) {
        let val = channelData[i];
        
        // Detect if volume passes threshold
        if (Math.abs(val) > this.vadThreshold) hasSpeech = true;
        
        // Convert Float32 audio to PCM Int16
        let s = Math.max(-1, Math.min(1, val));
        this.buffer[this.bytesWritten++] = s < 0 ? s * 0x8000 : s * 0x7FFF;

        // When buffer is full, send Base64 back to frontend
        if (this.bytesWritten >= this.bufferSize) {
          const bytes = new Uint8Array(this.buffer.buffer);
          const base64 = encodeBase64(bytes);
          this.port.postMessage({ type: 'audio_data', audioBase64: base64 });
          this.bytesWritten = 0; // Reset buffer
        }
      }

      // Voice Activity Detection (VAD) events
      if (hasSpeech) {
        this.silenceFrames = 0;
        if (!this.isSpeaking) {
          this.isSpeaking = true;
          this.port.postMessage({ type: 'speech_start' });
        }
      } else {
        this.silenceFrames++;
        // ~0.5 seconds of silence
        if (this.isSpeaking && this.silenceFrames > 60) { 
          this.isSpeaking = false;
          this.port.postMessage({ type: 'end_of_turn' });
        }
      }
    }
    return true; // Keep processor alive
  }
}

registerProcessor('audio-processor', AudioProcessor);
