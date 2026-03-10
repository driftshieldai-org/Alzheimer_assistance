export const AUDIO_WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
 constructor() {
  super();
  this.buffer = [];
  this.BUFFER_SIZE = 2048; 
 }

 process(inputs, outputs, parameters) {
  const input = inputs[0];
  if (!input || !input[0]) return true;
   
  const channelData = input[0];
   
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

let playbackContext = null;
let nextPlayTime = 0;
let audioQueue = [];

export function initPlaybackContext() {
 if (!playbackContext) {
  playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
 }
 return playbackContext;
}

export function clearAudioQueue() {
 audioQueue.forEach(source => {
  try { 
   source.stop(); 
   source.disconnect(); 
  } catch (e) {}
 });
 audioQueue = [];
 nextPlayTime = 0;
}

export async function playPcmAudio(base64Data) {
 try {
  const ctx = initPlaybackContext();
  if (ctx.state === 'suspended') await ctx.resume();
   
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const pcm16 = new Int16Array(len / 2);
   
  for (let i = 0; i < pcm16.length; i++) {
   pcm16[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
  }
   
  const audioBuffer = ctx.createBuffer(1, pcm16.length, 24000);
  const channelData = audioBuffer.getChannelData(0);
   
  for (let i = 0; i < pcm16.length; i++) {
   channelData[i] = pcm16[i] / 32768.0;
  }
   
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
   
  source.onended = () => {
   audioQueue = audioQueue.filter(s => s !== source);
  };
   
  const currentTime = ctx.currentTime;
  if (nextPlayTime < currentTime) {
   nextPlayTime = currentTime;
  }
   
  source.start(nextPlayTime);
  audioQueue.push(source);
  nextPlayTime += audioBuffer.duration;
   
 } catch (err) {
  console.error("Audio playback error:", err);
 }
}
