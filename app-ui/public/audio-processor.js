class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
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
        if (Math.abs(channelData[i]) > maxVol) maxVol = Math.abs(channelData[i]);
      }

      // Send raw, unmodified slice directly to React
      this.port.postMessage({ 
        type: 'audio_data', 
        audioChunk: channelData.slice() 
      });

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
