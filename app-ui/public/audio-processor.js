class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Int16Array(this.bufferSize);
    this.bytesWritten = 0;
    
    this.isSpeaking = false;
    this.silenceFrames = 0;
    this.speechFrames = 0;
    this.vadThreshold = 0.05; 
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      let maxVol = 0;

      for (let i = 0; i < channelData.length; i++) {
        let val = channelData[i];
        if (Math.abs(val) > maxVol) maxVol = Math.abs(val);
        
        // Convert Float32 audio to PCM Int16 correctly
        let s = Math.max(-1, Math.min(1, val));
        this.buffer[this.bytesWritten++] = s < 0 ? s * 0x8000 : s * 0x7FFF;

        if (this.bytesWritten >= this.bufferSize) {
          // Send raw ArrayBuffer safely across the thread
          const bufferCopy = new Int16Array(this.buffer);
          this.port.postMessage({ type: 'audio_data', pcmData: bufferCopy.buffer });
          this.bytesWritten = 0;
        }
      }

      // VAD Logic
      if (maxVol > this.vadThreshold) {
        this.silenceFrames = 0;
        this.speechFrames++;
        if (!this.isSpeaking && this.speechFrames > 10) {
          this.isSpeaking = true;
          this.port.postMessage({ type: 'speech_start' });
        }
      } else {
        this.speechFrames = 0;
        this.silenceFrames++;
        if (this.isSpeaking && this.silenceFrames > 125) { 
          this.isSpeaking = false;
          this.port.postMessage({ type: 'end_of_turn' });
        }
      }
    }
    return true; 
  }
}
registerProcessor('audio-processor', AudioProcessor);
