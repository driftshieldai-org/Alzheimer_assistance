class AudioProcessor extends AudioWorkletProcessor {

  constructor() {
    super()

    this.buffer = []
    this.bufferSize = 1600
    this.speeching = false
    this.silenceFrames = 0
    this.SILENCE_LIMIT = 15
  }

  floatTo16BitPCM(float32Array) {

    const buffer = new ArrayBuffer(float32Array.length * 2)
    const view = new DataView(buffer)

    let offset = 0

    for (let i = 0; i < float32Array.length; i++, offset += 2) {

      let s = Math.max(-1, Math.min(1, float32Array[i]))

      view.setInt16(
        offset,
        s < 0 ? s * 0x8000 : s * 0x7fff,
        true
      )

    }

    return buffer
  }

  base64ArrayBuffer(arrayBuffer) {

    let binary = ""
    const bytes = new Uint8Array(arrayBuffer)

    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }

    return btoa(binary)
  }

  process(inputs) {

    const input = inputs[0]

    if (!input || input.length === 0) return true

    const channelData = input[0]

    let energy = 0

    for (let i = 0; i < channelData.length; i++) {
      energy += Math.abs(channelData[i])
    }

    energy = energy / channelData.length

    if (energy > 0.01) {

      this.silenceFrames = 0

      if (!this.speeching) {
        this.speeching = true
        this.port.postMessage({ type: "speech_start" })
      }

    } else {

      this.silenceFrames++

      if (this.silenceFrames > this.SILENCE_LIMIT && this.speeching) {

        this.speeching = false

        this.port.postMessage({ type: "end_of_turn" })
      }

    }

    this.buffer.push(...channelData)

    if (this.buffer.length >= this.bufferSize) {

      const floatArray = new Float32Array(this.buffer)

      const pcmBuffer = this.floatTo16BitPCM(floatArray)

      const base64 = this.base64ArrayBuffer(pcmBuffer)

      this.port.postMessage({
        type: "audio_data",
        audioBase64: base64
      })

      this.buffer = []
    }

    return true
  }
}

registerProcessor("audio-processor", AudioProcessor)
