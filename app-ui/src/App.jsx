import React, { useState, useEffect, useRef, useCallback } from 'react';
import Webcam from 'react-webcam'; 
import { 
  Brain, ArrowLeft, Camera, Video, CheckCircle, Mic, Upload, 
  CameraIcon, StopCircle, ImageIcon
} from 'lucide-react';

// Audio Worklet for 16kHz PCM capture
const AUDIO_WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.BUFFER_SIZE = 1600; // 100ms at 16kHz
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
      
      // Convert to PCM16 Little Endian
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

// Playback at 24kHz (Gemini output rate)
let playbackContext = null;
let nextPlayTime = 0;
let audioQueue = [];

function initPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  }
  return playbackContext;
}

function clearAudioQueue() {
  audioQueue.forEach(source => {
    try { source.stop(); source.disconnect(); } catch (e) {}
  });
  audioQueue = [];
  nextPlayTime = 0;
}

async function playPcmAudio(base64Data) {
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

export default function MemoryMateApp() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [showSuccess, setShowSuccess] = useState(false);

  // Auth State
  const [name, setName] = useState('');
  const [signupUserId, setSignupUserId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupErrorMsg, setSignupErrorMsg] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);
  const [loginUserId, setLoginUserId] = useState(''); 
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErrorMsg, setLoginErrorMsg] = useState(''); 
  const [isLoginLoading, setIsLoginLoading] = useState(false);

  // Photo State
  const [photoFile, setPhotoFile] = useState(null); 
  const [photoDescription, setPhotoDescription] = useState('');
  const [photoDate, setPhotoDate] = useState('');
  const [photoUploadErrorMsg, setPhotoUploadErrorMsg] = useState('');
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false); 
  const webcamRefCapture = useRef(null); 
  const [capturedImageSrc, setCapturedImageSrc] = useState(null);

  // Live Assistance State
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const webcamRefLive = useRef(null); 
  const [liveVideoError, setLiveVideoError] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const wsRef = useRef(null); 
  const frameIntervalRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);

  const BACKEND_API_BASE = "https://alzheimer-backend-902738993392.us-central1.run.app";
    
  useEffect(() => {
    if (showSuccess) {
      const timer = setTimeout(() => {
        setShowSuccess(false);
        setCurrentScreen('dashboard');
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [showSuccess]);

  useEffect(() => {
    return () => stopLiveAssistance();
  }, [currentScreen]);

  const startMicCapture = async () => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
      workletNodeRef.current = workletNode;

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
      };

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(workletNode);
      
      console.log("🎤 Microphone started at 16kHz");
      setIsStreaming(true);

    } catch (err) {
      console.error("Microphone error:", err);
      setLiveVideoError("Microphone access failed: " + err.message);
    }
  };

  const sendVideoFrame = () => {
    if (!webcamRefLive.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const imageSrc = webcamRefLive.current.getScreenshot({ width: 640, height: 480 });
      if (imageSrc) {
        const base64Data = imageSrc.split(',')[1];
        wsRef.current.send(JSON.stringify({ type: "frame", frameBase64: base64Data }));
      }
    } catch (err) {
      console.error("Frame error:", err);
    }
  };
  
  const startLiveAssistance = async () => {
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();
    
    const token = localStorage.getItem('token');
    if (!token) {
      setLiveVideoError("Please log in first.");
      setCurrentScreen('login');
      return;
    }

    setIsLiveAssistanceActive(true);
    setLiveVideoError('');
    clearAudioQueue();

    const wsUrl = `wss://${new URL(BACKEND_API_BASE).host}/api/live/ws/live/process-stream?token=${token}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = () => {
      console.log('WebSocket connected');
      startMicCapture();
      frameIntervalRef.current = setInterval(sendVideoFrame, 2000);
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "audioResponse" && data.audioBase64) {
          playPcmAudio(data.audioBase64);
        }
        if (data.type === "interrupted") {
          clearAudioQueue();
        }
      } catch (err) {
        console.error("Message error:", err);
      }
    };

    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setLiveVideoError("Connection error.");
      stopLiveAssistance();
    };

    wsRef.current.onclose = (event) => {
      console.log('WebSocket closed:', event.code);
      stopLiveAssistance();
    };
  };
  
  const stopLiveAssistance = () => {
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    clearAudioQueue();
    setIsLiveAssistanceActive(false);
    setIsStreaming(false);
  };

  // Auth handlers
  const handleLogin = async () => {
    setIsLoginLoading(true);
    setLoginErrorMsg('');
    if (!loginUserId || !loginPassword) {
      setLoginErrorMsg('Please enter User ID and password.');
      setIsLoginLoading(false);
      return;
    }
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: loginUserId, password: loginPassword })
      });
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setCurrentScreen('dashboard');
      } else {
        setLoginErrorMsg(data.message || 'Login failed.');
      }
    } catch (err) {
      setLoginErrorMsg('Connection failed.');
    } finally {
      setIsLoginLoading(false);
    }
  };

  const handleSignup = async () => {
    setIsSignupLoading(true);
    setSignupErrorMsg('');
    if (signupPassword !== confirmPassword) {
      setSignupErrorMsg('Passwords do not match.');
      setIsSignupLoading(false);
      return;
    }
    if (!name || !signupUserId || !signupPassword) {
      setSignupErrorMsg('Please fill all fields.');
      setIsSignupLoading(false);
      return;
    }
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, userId: signupUserId, password: signupPassword })
      });
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setCurrentScreen('dashboard');
      } else {
        setSignupErrorMsg(data.message || 'Signup failed.');
      }
    } catch (err) {
      setSignupErrorMsg('Connection failed.');
    } finally {
      setIsSignupLoading(false);
    }
  };

  const handlePhotoUpload = async (e) => {
    e.preventDefault();
    setIsPhotoUploading(true);
    setPhotoUploadErrorMsg('');

    let photoToSend = photoFile;
    if (capturedImageSrc) {
      const response = await fetch(capturedImageSrc);
      const blob = await response.blob();
      photoToSend = new File([blob], `photo_${Date.now()}.jpeg`, { type: blob.type });
    }
    
    if (!photoToSend || !photoDescription || !photoDate) {
      setPhotoUploadErrorMsg('Please provide all details.');
      setIsPhotoUploading(false);
      return;
    }

    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('photo', photoToSend);
    formData.append('description', photoDescription);
    formData.append('photoDate', photoDate);

    try {
      const response = await fetch('/api/photos/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      if (response.ok) {
        setPhotoFile(null); 
        setPhotoDescription('');
        setPhotoDate('');
        setCapturedImageSrc(null);
        setIsCameraActive(false);
        setShowSuccess(true);
      } else {
        setPhotoUploadErrorMsg('Upload failed.');
      }
    } catch (err) {
      setPhotoUploadErrorMsg('Server error.');
    } finally {
      setIsPhotoUploading(false);
    }
  };

  const capturePhoto = useCallback(() => {
    const imageSrc = webcamRefCapture.current.getScreenshot({ width: 1280, height: 720 });
    setCapturedImageSrc(imageSrc);
    setPhotoFile(null);
  }, []);

  const BackButton = ({ onClick }) => (
    <button onClick={() => { stopLiveAssistance(); onClick(); }} className="flex items-center justify-center w-full max-w-xl bg-slate-200 text-blue-900 text-3xl font-bold py-6 px-8 rounded-2xl shadow-md border-4 border-slate-300 hover:bg-slate-300 mt-6">
      <ArrowLeft size={32} className="mr-4" /> Go Back
    </button>
  );

  // Render screens
  const renderHome = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <Brain size={120} className="text-blue-800 mb-6" />
      <h1 className="text-6xl font-extrabold text-blue-900 mb-16">MemoryMate</h1>
      <div className="w-full max-w-xl space-y-8">
        <button onClick={() => setCurrentScreen('login')} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl border-4 border-blue-900">Login</button>
        <button onClick={() => setCurrentScreen('signup')} className="w-full bg-white text-blue-900 text-4xl font-extrabold py-8 rounded-2xl shadow-xl border-4 border-blue-800">Sign Up</button>
      </div>
    </div>
  );

  const renderLogin = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-12">Login</h2>
      <div className="w-full max-w-xl space-y-8">
        {loginErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center">{loginErrorMsg}</div>}
        <input type="text" value={loginUserId} onChange={(e) => setLoginUserId(e.target.value)} placeholder="User ID" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <button onClick={handleLogin} disabled={isLoginLoading} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl disabled:opacity-70">{isLoginLoading ? 'Loading...' : 'Login'}</button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  const renderSignup = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-10">Sign Up</h2>
      <div className="w-full max-w-xl space-y-6">
        {signupErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center">{signupErrorMsg}</div>}
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your Name" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="text" value={signupUserId} onChange={(e) => setSignupUserId(e.target.value)} placeholder="User ID" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={signupPassword} onChange={(e) => setSignupPassword(e.target.value)} placeholder="Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <button onClick={handleSignup} disabled={isSignupLoading} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl disabled:opacity-70">{isSignupLoading ? 'Loading...' : 'Sign Up'}</button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  const renderDashboard = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-12">
      <h2 className="text-4xl font-extrabold text-blue-900 mb-12 text-center">Hello {localStorage.getItem('userId')}!</h2>
      <div className="w-full max-w-2xl space-y-8">
        <button onClick={() => setCurrentScreen('store_photos')} className="w-full flex flex-col items-center bg-blue-800 text-white rounded-3xl shadow-2xl p-8 border-4 border-blue-900">
          <Camera size={80} className="mb-6" />
          <span className="text-4xl font-extrabold">Store New Photos</span>
        </button>
        <button onClick={() => setCurrentScreen('live_view')} className="w-full flex flex-col items-center bg-teal-800 text-white rounded-3xl shadow-2xl p-8 border-4 border-teal-900">
          <Video size={80} className="mb-6" />
          <span className="text-4xl font-extrabold">Live Assistance</span>
        </button>
      </div>
    </div>
  );

  const renderStorePhotos = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8">Store Photo</h2>
      <div className="w-full max-w-2xl space-y-8">
        {photoUploadErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center">{photoUploadErrorMsg}</div>}
        
        {!isCameraActive && !photoFile && !capturedImageSrc && (
          <div className="grid grid-cols-2 gap-8">
            <button onClick={() => fileInputRef.current.click()} className="flex flex-col items-center bg-blue-100 border-4 border-blue-300 p-8 rounded-2xl">
              <Upload size={64} className="mb-4 text-blue-800" />
              <span className="text-2xl font-bold text-blue-900">Upload</span>
            </button>
            <button onClick={() => setIsCameraActive(true)} className="flex flex-col items-center bg-green-100 border-4 border-green-300 p-8 rounded-2xl">
              <CameraIcon size={64} className="mb-4 text-green-800" />
              <span className="text-2xl font-bold text-green-900">Camera</span>
            </button>
          </div>
        )}

        {isCameraActive && !capturedImageSrc && (
          <div className="bg-slate-800 rounded-3xl p-4 border-8 border-slate-900">
            <Webcam audio={false} ref={webcamRefCapture} screenshotFormat="image/jpeg" videoConstraints={{ facingMode: "environment" }} className="rounded-xl w-full aspect-video" />
            <div className="flex space-x-4 mt-4">
              <button onClick={capturePhoto} className="flex-1 bg-green-700 text-white text-2xl font-bold py-4 rounded-2xl">Capture</button>
              <button onClick={() => setIsCameraActive(false)} className="flex-1 bg-red-600 text-white text-2xl font-bold py-4 rounded-2xl">Cancel</button>
            </div>
          </div>
        )}

        {capturedImageSrc && (
          <div className="bg-slate-100 rounded-3xl p-4 border-8 border-blue-500">
            <img src={capturedImageSrc} alt="Captured" className="rounded-xl max-h-96 mx-auto" />
            <div className="flex space-x-4 mt-4">
              <button onClick={() => setCapturedImageSrc(null)} className="flex-1 bg-orange-500 text-white text-2xl font-bold py-4 rounded-2xl">Retake</button>
            </div>
          </div>
        )}

        {photoFile && <div className="bg-blue-50 border-4 border-blue-300 rounded-2xl p-8 text-center"><ImageIcon size={48} className="mx-auto mb-4 text-blue-800" /><span className="text-2xl font-bold text-blue-900">{photoFile.name}</span></div>}

        <input type="file" accept="image/*" onChange={(e) => { setPhotoFile(e.target.files[0]); setCapturedImageSrc(null); }} ref={fileInputRef} className="hidden" />

        <input type="text" value={photoDescription} onChange={(e) => setPhotoDescription(e.target.value)} placeholder="Who/what is in this photo?" className="w-full text-2xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="date" value={photoDate} onChange={(e) => setPhotoDate(e.target.value)} className="w-full text-2xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />

        {(photoFile || capturedImageSrc) && (
          <button onClick={handlePhotoUpload} disabled={isPhotoUploading || !photoDescription || !photoDate} className="w-full bg-green-700 text-white text-3xl font-extrabold py-8 rounded-2xl disabled:opacity-70">{isPhotoUploading ? 'Uploading...' : 'Save Photo'}</button>
        )}
        
        <BackButton onClick={() => setCurrentScreen('dashboard')} />
      </div>

      {showSuccess && (
        <div className="fixed inset-0 bg-blue-950/90 flex items-center justify-center z-50" onClick={() => setShowSuccess(false)}>
          <div className="bg-white rounded-3xl p-12 border-8 border-green-500 text-center">
            <CheckCircle size={120} className="text-green-600 mx-auto mb-8" />
            <h2 className="text-4xl font-extrabold text-blue-900">Photo Saved!</h2>
          </div>
        </div>
      )}
    </div>
  );

  const renderLiveView = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8">Live Assistance</h2>
      
      {liveVideoError && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8 w-full max-w-3xl">{liveVideoError}</div>}

      {isLiveAssistanceActive ? (
        <>
          <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl border-8 border-slate-900 mb-6 overflow-hidden relative">
            <Webcam audio={false} ref={webcamRefLive} screenshotFormat="image/jpeg" videoConstraints={{ facingMode: "environment" }} className="w-full h-full object-cover" />
            <div className="absolute top-4 right-4 flex items-center bg-black/60 px-4 py-2 rounded-full">
              <div className="w-4 h-4 rounded-full bg-red-500 animate-pulse mr-2"></div>
              <span className="text-white font-bold">LIVE</span>
            </div>
          </div>

          <div className="w-full max-w-3xl p-6 bg-blue-50 rounded-3xl border-4 border-blue-200 mb-6">
            <div className="flex items-center justify-center space-x-4">
              <Mic size={48} className={`${isStreaming ? 'text-green-600 animate-pulse' : 'text-gray-400'}`} />
              <span className="text-2xl font-bold text-blue-900">
                {isStreaming ? "Listening... Speak naturally!" : "Starting microphone..."}
              </span>
            </div>
          </div>

          <button onClick={stopLiveAssistance} className="w-full max-w-3xl bg-red-700 text-white text-4xl font-extrabold py-8 rounded-3xl border-8 border-red-900 flex items-center justify-center">
            <StopCircle size={48} className="mr-4" /> Stop
          </button>
        </>
      ) : (
        <div className="w-full max-w-3xl space-y-8">
          <button onClick={startLiveAssistance} className="w-full bg-teal-600 text-white text-4xl font-extrabold py-12 rounded-3xl border-8 border-teal-800 flex items-center justify-center">
            <Video size={48} className="mr-4" /> Start Live Assistance
          </button>
          <BackButton onClick={() => setCurrentScreen('dashboard')} />
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 font-sans">
      {currentScreen === 'home' && renderHome()}
      {currentScreen === 'login' && renderLogin()}
      {currentScreen === 'signup' && renderSignup()}
      {currentScreen === 'dashboard' && renderDashboard()}
      {currentScreen === 'store_photos' && renderStorePhotos()}
      {currentScreen === 'live_view' && renderLiveView()}
    </div>
  );
}
