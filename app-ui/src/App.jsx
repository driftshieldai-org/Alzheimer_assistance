import React, { useState, useEffect, useRef, useCallback } from 'react';
import Webcam from 'react-webcam'; 
import { 
  Brain, ArrowLeft, Camera, Video, CheckCircle, Mic, Upload, 
  CameraIcon, StopCircle, ImageIcon
} from 'lucide-react';

const AUDIO_WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = [];
    this.BUFFER_SIZE = 1600;
    this.gain = 5.0;
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
        let sample = chunk[i] * this.gain;
        sample = Math.max(-1, Math.min(1, sample));
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

function initPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  }
  return playbackContext;
}

function clearAudioQueue() {
  audioQueue.forEach(s => { try { s.stop(); s.disconnect(); } catch(e){} });
  audioQueue = [];
  nextPlayTime = 0;
}

async function playPcmAudio(base64Data) {
  try {
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();
    
    const bin = window.atob(base64Data);
    const pcm16 = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm16.length; i++) {
      pcm16[i] = bin.charCodeAt(i*2) | (bin.charCodeAt(i*2+1) << 8);
    }
    
    const buffer = ctx.createBuffer(1, pcm16.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm16.length; i++) {
      channel[i] = pcm16[i] / 32768.0;
    }
    
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => { audioQueue = audioQueue.filter(s => s !== source); };
    
    if (nextPlayTime < ctx.currentTime) nextPlayTime = ctx.currentTime;
    source.start(nextPlayTime);
    audioQueue.push(source);
    nextPlayTime += buffer.duration;
  } catch (e) {
    console.error("Playback error:", e);
  }
}

export default function MemoryMateApp() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [showSuccess, setShowSuccess] = useState(false);

  // Auth
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

  // Photo
  const [photoFile, setPhotoFile] = useState(null);
  const [photoDescription, setPhotoDescription] = useState('');
  const [photoDate, setPhotoDate] = useState('');
  const [photoUploadErrorMsg, setPhotoUploadErrorMsg] = useState('');
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const fileInputRef = useRef(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const webcamRefCapture = useRef(null);
  const [capturedImageSrc, setCapturedImageSrc] = useState(null);

  // Live
  const [isLiveActive, setIsLiveActive] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const webcamRefLive = useRef(null);
  const wsRef = useRef(null);
  const frameIntervalRef = useRef(null);
  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletRef = useRef(null);

  const BACKEND = "https://alzheimer-backend-902738993392.us-central1.run.app";

  useEffect(() => {
    if (showSuccess) {
      const t = setTimeout(() => { setShowSuccess(false); setCurrentScreen('dashboard'); }, 2000);
      return () => clearTimeout(t);
    }
  }, [showSuccess]);

  useEffect(() => () => stopLive(), [currentScreen]);

  const startMic = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: 16000, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      micStreamRef.current = stream;

      const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioCtxRef.current = ctx;
      if (ctx.state === 'suspended') await ctx.resume();

      const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);

      const worklet = new AudioWorkletNode(ctx, 'audio-processor');
      workletRef.current = worklet;

      worklet.port.onmessage = (e) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        if (e.data.type === 'audio' && e.data.buffer) {
          const bytes = new Uint8Array(e.data.buffer);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          wsRef.current.send(JSON.stringify({ type: "audio", audioBase64: window.btoa(bin) }));
        }
      };

      ctx.createMediaStreamSource(stream).connect(worklet);
      setIsStreaming(true);
      console.log("🎤 Mic started");
    } catch (e) {
      console.error("Mic error:", e);
      setLiveError("Microphone failed: " + e.message);
    }
  };

  const sendFrame = () => {
    if (!webcamRefLive.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      const img = webcamRefLive.current.getScreenshot({ width: 640, height: 480 });
      if (img) wsRef.current.send(JSON.stringify({ type: "frame", frameBase64: img.split(',')[1] }));
    } catch (e) {}
  };

  const startLive = async () => {
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const token = localStorage.getItem('token');
    if (!token) { setLiveError("Please log in."); setCurrentScreen('login'); return; }

    setIsLiveActive(true);
    setLiveError('');
    clearAudioQueue();

    wsRef.current = new WebSocket(`wss://${new URL(BACKEND).host}/api/live/ws/live/process-stream?token=${token}`);

    wsRef.current.onopen = () => {
      console.log('WS connected');
      startMic();
      frameIntervalRef.current = setInterval(sendFrame, 2000);
    };

    wsRef.current.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d.type === "audioResponse" && d.audioBase64) playPcmAudio(d.audioBase64);
        if (d.type === "interrupted") clearAudioQueue();
      } catch {}
    };

    wsRef.current.onerror = () => { setLiveError("Connection error."); stopLive(); };
    wsRef.current.onclose = () => stopLive();
  };

  const stopLive = () => {
    if (frameIntervalRef.current) { clearInterval(frameIntervalRef.current); frameIntervalRef.current = null; }
    if (workletRef.current) { workletRef.current.disconnect(); workletRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach(t => t.stop()); micStreamRef.current = null; }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    clearAudioQueue();
    setIsLiveActive(false);
    setIsStreaming(false);
  };

  // Auth handlers
  const handleLogin = async () => {
    setIsLoginLoading(true); setLoginErrorMsg('');
    if (!loginUserId || !loginPassword) { setLoginErrorMsg('Enter credentials.'); setIsLoginLoading(false); return; }
    try {
      const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: loginUserId, password: loginPassword }) });
      const d = await r.json();
      if (r.ok) { localStorage.setItem('token', d.token); localStorage.setItem('userId', d.user.userId); setCurrentScreen('dashboard'); }
      else setLoginErrorMsg(d.message || 'Login failed.');
    } catch { setLoginErrorMsg('Connection failed.'); }
    setIsLoginLoading(false);
  };

  const handleSignup = async () => {
    setIsSignupLoading(true); setSignupErrorMsg('');
    if (signupPassword !== confirmPassword) { setSignupErrorMsg('Passwords mismatch.'); setIsSignupLoading(false); return; }
    if (!name || !signupUserId || !signupPassword) { setSignupErrorMsg('Fill all fields.'); setIsSignupLoading(false); return; }
    try {
      const r = await fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, userId: signupUserId, password: signupPassword }) });
      const d = await r.json();
      if (r.ok) { localStorage.setItem('token', d.token); localStorage.setItem('userId', d.user.userId); setCurrentScreen('dashboard'); }
      else setSignupErrorMsg(d.message || 'Signup failed.');
    } catch { setSignupErrorMsg('Connection failed.'); }
    setIsSignupLoading(false);
  };

  const handlePhotoUpload = async (e) => {
    e.preventDefault();
    setIsPhotoUploading(true); setPhotoUploadErrorMsg('');
    let photo = photoFile;
    if (capturedImageSrc) {
      const r = await fetch(capturedImageSrc);
      const b = await r.blob();
      photo = new File([b], `photo_${Date.now()}.jpeg`, { type: b.type });
    }
    if (!photo || !photoDescription || !photoDate) { setPhotoUploadErrorMsg('Provide all details.'); setIsPhotoUploading(false); return; }
    const fd = new FormData();
    fd.append('photo', photo); fd.append('description', photoDescription); fd.append('photoDate', photoDate);
    try {
      const r = await fetch('/api/photos/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` }, body: fd });
      if (r.ok) { setPhotoFile(null); setPhotoDescription(''); setPhotoDate(''); setCapturedImageSrc(null); setIsCameraActive(false); setShowSuccess(true); }
      else setPhotoUploadErrorMsg('Upload failed.');
    } catch { setPhotoUploadErrorMsg('Server error.'); }
    setIsPhotoUploading(false);
  };

  const capturePhoto = useCallback(() => {
    const img = webcamRefCapture.current.getScreenshot({ width: 1280, height: 720 });
    setCapturedImageSrc(img); setPhotoFile(null);
  }, []);

  const BackButton = ({ onClick }) => (
    <button onClick={() => { stopLive(); onClick(); }} className="flex items-center justify-center w-full max-w-xl bg-slate-200 text-blue-900 text-3xl font-bold py-6 px-8 rounded-2xl shadow-md border-4 border-slate-300 hover:bg-slate-300 mt-6">
      <ArrowLeft size={32} className="mr-4" /> Go Back
    </button>
  );

  // Screens
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
        <input type="text" value={loginUserId} onChange={e => setLoginUserId(e.target.value)} placeholder="User ID" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} placeholder="Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
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
        <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Your Name" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="text" value={signupUserId} onChange={e => setSignupUserId(e.target.value)} placeholder="User ID" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={signupPassword} onChange={e => setSignupPassword(e.target.value)} placeholder="Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Confirm Password" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
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
          <Camera size={80} className="mb-6" /><span className="text-4xl font-extrabold">Store Photos</span>
        </button>
        <button onClick={() => setCurrentScreen('live_view')} className="w-full flex flex-col items-center bg-teal-800 text-white rounded-3xl shadow-2xl p-8 border-4 border-teal-900">
          <Video size={80} className="mb-6" /><span className="text-4xl font-extrabold">Live Assistance</span>
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
              <Upload size={64} className="mb-4 text-blue-800" /><span className="text-2xl font-bold text-blue-900">Upload</span>
            </button>
            <button onClick={() => setIsCameraActive(true)} className="flex flex-col items-center bg-green-100 border-4 border-green-300 p-8 rounded-2xl">
              <CameraIcon size={64} className="mb-4 text-green-800" /><span className="text-2xl font-bold text-green-900">Camera</span>
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
            <button onClick={() => setCapturedImageSrc(null)} className="w-full mt-4 bg-orange-500 text-white text-2xl font-bold py-4 rounded-2xl">Retake</button>
          </div>
        )}

        {photoFile && <div className="bg-blue-50 border-4 border-blue-300 rounded-2xl p-8 text-center"><ImageIcon size={48} className="mx-auto mb-4 text-blue-800" /><span className="text-2xl font-bold text-blue-900">{photoFile.name}</span></div>}

        <input type="file" accept="image/*" onChange={e => { setPhotoFile(e.target.files[0]); setCapturedImageSrc(null); }} ref={fileInputRef} className="hidden" />

        <input type="text" value={photoDescription} onChange={e => setPhotoDescription(e.target.value)} placeholder="Who/what is in this photo?" className="w-full text-2xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />
        <input type="date" value={photoDate} onChange={e => setPhotoDate(e.target.value)} className="w-full text-2xl p-6 border-4 border-blue-300 rounded-2xl bg-white" />

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
      
      {liveError && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8 w-full max-w-3xl">{liveError}</div>}

      {isLiveActive ? (
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
              <Mic size={48} className={isStreaming ? 'text-green-600 animate-pulse' : 'text-gray-400'} />
              <span className="text-2xl font-bold text-blue-900">{isStreaming ? "Listening... Speak naturally!" : "Starting..."}</span>
            </div>
          </div>

          <button onClick={stopLive} className="w-full max-w-3xl bg-red-700 text-white text-4xl font-extrabold py-8 rounded-3xl border-8 border-red-900 flex items-center justify-center">
            <StopCircle size={48} className="mr-4" /> Stop
          </button>
        </>
      ) : (
        <div className="w-full max-w-3xl space-y-8">
          <button onClick={startLive} className="w-full bg-teal-600 text-white text-4xl font-extrabold py-12 rounded-3xl border-8 border-teal-800 flex items-center justify-center">
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
