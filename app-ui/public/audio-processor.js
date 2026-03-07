class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.vadThreshold = 0.05;
    
    // Audio buffer and settings
    this.audioBuffer = [];
    this.bufferSize = 4096; // Send data when buffer reaches this size
    this.gain = 5.0; // Audio amplification
    
    this.port.onmessage = (event) => {
      if (event.data.type === 'stop') {
        // Clean up if needed, though not strictly necessary here
      }
    };
  }

  // Helper to convert Float32Array to Base64 encoded PCM16
  float32To16BitPCMBase64(buffer) {
    let pcm16Buffer = new ArrayBuffer(buffer.length * 2);
    let view = new DataView(pcm16Buffer);
    for (let i = 0; i < buffer.length; i++) {
      // Amplify and clamp
      let s = Math.max(-1, Math.min(1, buffer[i] * this.gain));
      // Convert to 16-bit integer
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    
    // Convert buffer to binary string then to base64
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
      
      // --- VAD Logic ---
      let maxVol = 0;
      for (let i = 0; i < channelData.length; i++) {
        if (Math.abs(channelData[i]) > maxVol) {
          maxVol = Math.abs(channelData[i]);
        }
      }

      if (maxVol > this.vadThreshold) {
        this.silenceFrames = 0;
        this.speechFrames++;
        if (!this.isSpeaking && this.speechFrames > 10) { // Start speech after 10 consecutive speech frames
          this.isSpeaking = true;
          this.port.postMessage({ type: 'speech_start' });
        }
      } else {
        this.speechFrames = 0;
        this.silenceFrames++;
        if (this.isSpeaking && this.silenceFrames > 125) { // End turn after 125 consecutive silence frames
          this.isSpeaking = false;
          this.port.postMessage({ type: 'end_of_turn' });
        }
      }

      // --- Buffering and Sending Audio Data ---
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
