import React, { useState, useEffect, useRef, useCallback } from 'react';
import Webcam from 'react-webcam'; 
import { 
  Brain, 
  ArrowLeft, 
  Camera, 
  Video, 
  CheckCircle, 
  Mic, 
  Upload, 
  CameraIcon,
  PlayIcon, 
  StopCircle,
  ImageIcon
} from 'lucide-react';

// Audio Worklet Processor Code - 16kHz PCM16 Little Endian
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

// Playback audio context at 24kHz (Gemini output rate)
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
    try { 
      source.stop(); 
      source.disconnect(); 
    } catch (e) {}
  });
  audioQueue = [];
  nextPlayTime = 0;
}

async function playPcmAudio(base64Data) {
  try {
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();
    
    // Decode base64 to PCM16
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const pcm16 = new Int16Array(len / 2);
    
    for (let i = 0; i < pcm16.length; i++) {
      pcm16[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
    }
    
    // Convert to float32 for Web Audio
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

  // SignUp State
  const [name, setName] = useState('');
  const [signupUserId, setSignupUserId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupErrorMsg, setSignupErrorMsg] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);

  // Login State
  const [loginUserId, setLoginUserId] = useState(''); 
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErrorMsg, setLoginErrorMsg] = useState(''); 
  const [isLoginLoading, setIsLoginLoading] = useState(false);

  // Photo Upload State
  const [photoFile, setPhotoFile] = useState(null); 
  const [photoDescription, setPhotoDescription] = useState('');
  const [photoDate, setPhotoDate] = useState('');
  const [photoUploadErrorMsg, setPhotoUploadErrorMsg] = useState('');
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const fileInputRef = useRef(null);

  // Camera Capture State
  const [isCameraActive, setIsCameraActive] = useState(false); 
  const webcamRefCapture = useRef(null); 
  const [capturedImageSrc, setCapturedImageSrc] = useState(null);

  // Live Assistance State
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const webcamRefLive = useRef(null); 
  const [liveVideoError, setLiveVideoError] = useState('');
  const [processingFrame, setProcessingFrame] = useState(false);
  const [aiTextResponse, setAiTextResponse] = useState(''); 
  const wsRef = useRef(null); 
  const frameIntervalRef = useRef(null); 
  
  // Audio Capture Refs
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);

  const BACKEND_API_BASE = "https://alzheimer-backend-902738993392.us-central1.run.app";
    
  useEffect(() => {
    let timer;
    if (showSuccess) {
      timer = setTimeout(() => {
        setShowSuccess(false);
        setCurrentScreen('dashboard');
      }, 2000);
    }
    return () => clearTimeout(timer);
  }, [showSuccess]);

  useEffect(() => {
    return () => {
      stopLiveAssistance();
    };
  }, [currentScreen]);

  // Start microphone capture at 16kHz
  const startMicCapture = async () => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      micStreamRef.current = stream;

      // Create AudioContext at 16kHz for Gemini input
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      // Load audio worklet
      const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      // Create worklet node
      const workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
      workletNodeRef.current = workletNode;

      // Handle audio data from worklet
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

      // Connect microphone to worklet
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(workletNode);
      
      console.log("🎤 Microphone capture started at 16kHz");

    } catch (err) {
      console.error("Microphone error:", err);
      setLiveVideoError("Microphone access failed: " + err.message);
    }
  };

  // Send video frames
  const sendVideoFrame = () => {
    if (!webcamRefLive.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      const imageSrc = webcamRefLive.current.getScreenshot({ 
        width: 640, 
        height: 480 
      });
      
      if (imageSrc) {
        const base64Data = imageSrc.split(',')[1];
        wsRef.current.send(JSON.stringify({ 
          type: "frame", 
          frameBase64: base64Data 
        }));
      }
    } catch (err) {
      console.error("Error capturing frame:", err);
    }
  };
  
  const startLiveAssistance = async () => {
    // Initialize playback context with user gesture
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
    
    const token = localStorage.getItem('token');
    if (!token) {
      setLiveVideoError("Please log in to use live assistance.");
      setCurrentScreen('login');
      return;
    }

    setIsLiveAssistanceActive(true);
    setLiveVideoError('');
    setAiTextResponse('');
    clearAudioQueue();

    const wsUrl = `wss://${new URL(BACKEND_API_BASE).host}/api/live/ws/live/process-stream?token=${token}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = () => {
      console.log('WebSocket connected');
      
      // Start mic capture after connection
      startMicCapture();
      
      // Start sending video frames every 2 seconds
      frameIntervalRef.current = setInterval(sendVideoFrame, 2000);
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "audioResponse" && data.audioBase64) {
          playPcmAudio(data.audioBase64);
        }
        
        if (data.type === "textResponse" && data.text) {
          setAiTextResponse(prev => prev + data.text);
        }
        
        if (data.type === "interrupted") {
          clearAudioQueue();
        }
        
        if (data.error) {
          setLiveVideoError(`AI Error: ${data.error}`);
        }
      } catch (err) {
        console.error("Error parsing message:", err);
      }
    };

    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setLiveVideoError("Connection error. Please try again.");
      stopLiveAssistance();
    };

    wsRef.current.onclose = (event) => {
      console.log('WebSocket disconnected:', event.code, event.reason);
      if (isLiveAssistanceActive) {
        stopLiveAssistance();
      }
    };
  };
  
  const stopLiveAssistance = () => {
    // Stop frame capture
    if (frameIntervalRef.current) {
      clearInterval(frameIntervalRef.current);
      frameIntervalRef.current = null;
    }
    
    // Close WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    
    // Stop audio worklet
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    
    // Close audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    // Stop microphone
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // Clear audio queue
    clearAudioQueue();

    setIsLiveAssistanceActive(false);
    setAiTextResponse('');
    setProcessingFrame(false);
  };

  const handleLogin = async () => {
    setIsLoginLoading(true);
    setLoginErrorMsg('');
    if (!loginUserId || !loginPassword) {
      setLoginErrorMsg('Please enter both User ID and password.');
      setIsLoginLoading(false);
      return;
    }
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: loginUserId, password: loginPassword })
      });

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Server configuration error.");
      }
      
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setLoginUserId(''); 
        setLoginPassword('');
        setCurrentScreen('dashboard');
      } else {
        setLoginErrorMsg(data.message || 'Login failed.');
      }
    } catch (err) {
      setLoginErrorMsg('Failed to connect to the server.');
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
      setSignupErrorMsg('Please fill out all fields.');
      setIsSignupLoading(false);
      return;
    }
    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, userId: signupUserId, password: signupPassword })
      });

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Server configuration error.");
      }
      
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setName(''); 
        setSignupUserId(''); 
        setSignupPassword(''); 
        setConfirmPassword('');
        setCurrentScreen('dashboard');
      } else {
        setSignupErrorMsg(data.message || 'Signup failed.');
      }
    } catch (err) {
      setSignupErrorMsg('Failed to connect to the server.');
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
      try {
        const response = await fetch(capturedImageSrc);
        const blob = await response.blob();
        photoToSend = new File([blob], `captured_${Date.now()}.jpeg`, { type: blob.type });
      } catch (error) {
        setPhotoUploadErrorMsg('Failed to process captured image.');
        setIsPhotoUploading(false);
        return;
      }
    }
    
    if (!photoToSend || !photoDescription || !photoDate) {
      setPhotoUploadErrorMsg('Please provide photo, description, and date.');
      setIsPhotoUploading(false);
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setPhotoUploadErrorMsg('You must be logged in.');
      setIsPhotoUploading(false);
      return;
    }

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
      
      const data = await response.json();
      if (response.ok) {
        setPhotoFile(null); 
        setPhotoDescription('');
        setPhotoDate('');
        setIsCameraActive(false); 
        setCapturedImageSrc(null); 
        setShowSuccess(true);
      } else {
        setPhotoUploadErrorMsg(data.message || 'Upload failed.');
      }
    } catch (err) {
      setPhotoUploadErrorMsg('Server error. Failed to upload.');
    } finally {
      setIsPhotoUploading(false);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setPhotoFile(e.target.files[0]);
      setCapturedImageSrc(null); 
      setIsCameraActive(false); 
      setPhotoUploadErrorMsg('');
    }
  };

  const handleClearPhoto = () => {
    setPhotoFile(null);
    setCapturedImageSrc(null);
    setIsCameraActive(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = null; 
    }
  };

  const videoConstraintsCapture = {
    facingMode: "environment" 
  };

  const capturePhoto = useCallback(() => {
    const imageSrc = webcamRefCapture.current.getScreenshot({ width: 1280, height: 720 }); 
    setCapturedImageSrc(imageSrc);
    setPhotoFile(null); 
    setPhotoUploadErrorMsg('');
  }, [webcamRefCapture]);
  
  const handleRetryCameraCapture = () => {
    setCapturedImageSrc(null);
  };
  
  const handleCancelCameraCapture = () => {
    setIsCameraActive(false);
    setCapturedImageSrc(null);
    setPhotoFile(null);
  };

  const BackButton = ({ onClick }) => (
    <button 
      onClick={() => {
        setSignupErrorMsg(''); 
        setLoginErrorMsg(''); 
        setPhotoUploadErrorMsg(''); 
        setLiveVideoError('');
        setLoginUserId(''); 
        setLoginPassword('');
        setName(''); 
        setSignupUserId(''); 
        setSignupPassword(''); 
        setConfirmPassword('');
        setPhotoFile(null); 
        setPhotoDescription(''); 
        setPhotoDate('');
        setIsCameraActive(false); 
        setCapturedImageSrc(null); 
        stopLiveAssistance();
        onClick();
      }}
      className="flex items-center justify-center w-full max-w-xl bg-slate-200 text-blue-900 text-3xl font-bold py-6 px-8 rounded-2xl shadow-md border-4 border-slate-300 hover:bg-slate-300 active:bg-slate-400 transition-colors mt-6"
    >
      <ArrowLeft size={32} className="mr-4" />
      Go Back
    </button>
  );

  // 1. HOME SCREEN
  const renderHome = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-center mb-16">
        <Brain size={120} className="text-blue-800 mb-6" />
        <h1 className="text-6xl font-extrabold text-blue-900 tracking-tight text-center">
          MemoryMate
        </h1>
      </div>
      <div className="w-full max-w-xl flex flex-col space-y-8">
        <button 
          onClick={() => setCurrentScreen('login')}
          className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 px-8 rounded-2xl shadow-xl hover:bg-blue-900 active:bg-blue-950 transition-colors border-4 border-blue-900"
        >
          Login
        </button>
        <button 
          onClick={() => setCurrentScreen('signup')}
          className="w-full bg-white text-blue-900 text-4xl font-extrabold py-8 px-8 rounded-2xl shadow-xl hover:bg-slate-100 active:bg-slate-200 transition-colors border-4 border-blue-800"
        >
          Sign Up
        </button>
      </div>
    </div>
  );

  // 2. LOGIN SCREEN
  const renderLogin = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-12">Login</h2>
      <div className="w-full max-w-xl flex flex-col space-y-8">
        
        {loginErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {loginErrorMsg}
          </div>
        )}

        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">User ID</label>
          <input 
            type="text" 
            value={loginUserId}
            onChange={(e) => setLoginUserId(e.target.value)}
            placeholder="Type your User ID here" 
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">Password</label>
          <input 
            type="password" 
            value={loginPassword}
            onChange={(e) => setLoginPassword(e.target.value)}
            placeholder="Type your password here" 
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <button 
          onClick={handleLogin} 
          disabled={isLoginLoading}
          className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-blue-900 mt-8 disabled:opacity-70 disabled:cursor-not-allowed transition-all"
        >
          {isLoginLoading ? 'Logging In...' : 'Login'}
        </button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  // 3. SIGN UP SCREEN
  const renderSignup = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-10">Sign Up</h2>
      
      <div className="w-full max-w-xl flex flex-col space-y-6">
        
        {signupErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {signupErrorMsg}
          </div>
        )}

        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Your Name</label>
          <input 
            type="text" 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type your name here"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">User ID</label>
          <input 
            type="text" 
            value={signupUserId}
            onChange={(e) => setSignupUserId(e.target.value)}
            placeholder="Choose a unique User ID"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Password</label>
          <input 
            type="password" 
            value={signupPassword}
            onChange={(e) => setSignupPassword(e.target.value)}
            placeholder="Type a password here"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Type Password Again</label>
          <input 
            type="password" 
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type your password again"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 focus:ring-4 focus:ring-blue-200 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        
        <button 
          onClick={handleSignup}
          disabled={isSignupLoading}
          className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-blue-900 mt-6 disabled:opacity-70 disabled:cursor-not-allowed transition-all"
        >
          {isSignupLoading ? 'Creating Account...' : 'Sign Up'}
        </button>
        
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  // 4. DASHBOARD SCREEN
  const renderDashboard = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-12 animate-in fade-in">
      <h2 className="text-4xl md:text-5xl font-extrabold text-blue-900 mb-12 text-center max-w-3xl leading-tight">
        Hello {localStorage.getItem('userId') || ''}! What would you like to do today?
      </h2>
      <div className="w-full max-w-2xl flex flex-col space-y-8 flex-grow">
        <button onClick={() => setCurrentScreen('store_photos')} className="flex-1 flex flex-col items-center justify-center bg-blue-800 text-white rounded-3xl shadow-2xl p-8 hover:bg-blue-900 active:bg-blue-950 transition-all border-4 border-blue-900">
          <Camera size={80} className="mb-6" />
          <span className="text-4xl md:text-5xl font-extrabold text-center">Store New Photos</span>
        </button>
        <button onClick={() => setCurrentScreen('live_view')} className="flex-1 flex flex-col items-center justify-center bg-teal-800 text-white rounded-3xl shadow-2xl p-8 hover:bg-teal-900 active:bg-teal-950 transition-all border-4 border-teal-900 mb-8">
          <Video size={80} className="mb-6" />
          <span className="text-4xl md:text-5xl font-extrabold text-center">Understand the place live</span>
        </button>
      </div>
    </div>
  );

  // 5. STORE PHOTOS SCREEN
  const renderStorePhotos = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 animate-in fade-in relative">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Store A Photo</h2>
      
      <div className="w-full max-w-2xl flex flex-col space-y-8">
        
        {photoUploadErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {photoUploadErrorMsg}
          </div>
        )}

        {!isCameraActive && !photoFile && !capturedImageSrc && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <button 
              onClick={() => fileInputRef.current.click()}
              className="flex flex-col items-center justify-center bg-blue-100 border-4 border-blue-300 text-blue-900 p-8 rounded-2xl shadow-md hover:bg-blue-200 transition-colors"
            >
              <Upload size={64} className="mb-4" />
              <span className="text-3xl font-bold">Upload from Device</span>
              <span className="text-xl font-medium mt-2">Choose photo from your phone or computer</span>
            </button>
            <button 
              onClick={() => setIsCameraActive(true)}
              className="flex flex-col items-center justify-center bg-green-100 border-4 border-green-300 text-green-900 p-8 rounded-2xl shadow-md hover:bg-green-200 transition-colors"
            >
              <CameraIcon size={64} className="mb-4 text-green-900" />
              <span className="text-3xl font-bold text-green-900">Take a Photo Now</span>
              <span className="text-xl font-medium mt-2">Use your device's camera</span>
            </button>
          </div>
        )}

        {isCameraActive && !capturedImageSrc && (
          <div className="bg-slate-800 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-slate-900 shadow-2xl space-y-6">
            <Webcam
              audio={false}
              ref={webcamRefCapture}
              screenshotFormat="image/jpeg"
              videoConstraints={videoConstraintsCapture}
              className="rounded-xl w-full max-w-2xl aspect-video object-cover" 
            />
            <div className="flex w-full justify-around space-x-4">
              <button 
                onClick={capturePhoto}
                className="flex-1 bg-green-700 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-green-800 transition-colors flex items-center justify-center"
              >
                <CameraIcon size={32} className="mr-4" /> Capture Photo
              </button>
              <button 
                onClick={handleCancelCameraCapture}
                className="flex-1 bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-red-200 transition-colors flex items-center justify-center"
              >
                <ArrowLeft size={32} className="mr-4" /> Cancel
              </button>
            </div>
          </div>
        )}

        {capturedImageSrc && (
          <div className="bg-slate-100 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-blue-500 shadow-2xl space-y-6">
            <h3 className="text-3xl font-bold text-blue-900 mt-2">Captured Photo Preview:</h3>
            <img src={capturedImageSrc} alt="Captured" className="rounded-xl max-w-full h-auto max-h-96 object-contain border-4 border-blue-300" />
            <div className="flex w-full justify-around space-x-4">
              <button 
                onClick={handleRetryCameraCapture}
                className="flex-1 bg-orange-500 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-orange-600 transition-colors flex items-center justify-center"
              >
                <ArrowLeft size={32} className="mr-4" /> Retake Photo
              </button>
              <button 
                onClick={handlePhotoUpload} 
                disabled={isPhotoUploading || !photoDescription || !photoDate}
                className="flex-1 bg-blue-700 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-blue-800 transition-colors flex items-center justify-center disabled:opacity-70 disabled:cursor-not-allowed"
              >
                {isPhotoUploading ? 'Uploading...' : 'Use & Save Photo'}
              </button>
            </div>
          </div>
        )}

        {photoFile && !isCameraActive && !capturedImageSrc && (
          <div className="bg-blue-50 border-8 border-dashed border-blue-300 rounded-3xl p-12 flex flex-col items-center justify-center shadow-md">
            <ImageIcon size={64} className="text-blue-800 mb-4" />
            <span className="text-3xl font-bold text-blue-900 text-center">{photoFile.name} (Ready to upload)</span>
            <button 
              onClick={handleClearPhoto} 
              className="mt-6 px-6 py-3 bg-red-500 text-white text-xl font-bold rounded-xl hover:bg-red-600 transition-colors"
            >
              Remove Photo
            </button>
          </div>
        )}

        <input 
          type="file" 
          accept="image/*" 
          onChange={handleFileChange} 
          ref={fileInputRef} 
          className="hidden" 
        />

        {(photoFile || capturedImageSrc || (!photoFile && !capturedImageSrc && !isCameraActive)) && ( 
          <>
            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 block">
                Who or what is in this photo?
              </label>
              <input 
                type="text" 
                value={photoDescription}
                onChange={(e) => setPhotoDescription(e.target.value)}
                placeholder="Type details for this picture..."
                className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900" 
              />
            </div>

            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 block">
                Date of photo
              </label>
              <input 
                type="date" 
                value={photoDate}
                onChange={(e) => setPhotoDate(e.target.value)}
                className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900" 
              />
            </div>
          </>
        )}

        {(photoFile && !capturedImageSrc) && ( 
          <div className="flex flex-col space-y-6 pt-6">
            <button 
              onClick={handlePhotoUpload}
              disabled={isPhotoUploading || !photoDescription || !photoDate}
              className="w-full bg-green-700 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-green-800 border-4 border-green-800 disabled:opacity-70 disabled:cursor-not-allowed transition-all"
            >
              {isPhotoUploading ? 'Uploading...' : 'Save Photo'}
            </button>
            
            <button 
              onClick={() => {
                setPhotoUploadErrorMsg(''); 
                setPhotoFile(null); 
                setPhotoDescription('');
                setPhotoDate('');
                setIsCameraActive(false); 
                setCapturedImageSrc(null); 
                setCurrentScreen('dashboard');
              }}
              className="w-full bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl shadow-md border-4 border-red-300 hover:bg-red-200"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {showSuccess && (
        <div 
          className="fixed inset-0 bg-blue-950/90 flex flex-col items-center justify-center z-50 p-6 animate-in fade-in duration-300"
          onClick={() => {
            setShowSuccess(false);
            setCurrentScreen('dashboard');
          }}
        >
          <div className="bg-white rounded-3xl p-12 max-w-2xl w-full flex flex-col items-center text-center shadow-2xl border-8 border-green-500 transform transition-all scale-100">
            <CheckCircle size={120} className="text-green-600 mb-8" />
            <h2 className="text-5xl font-extrabold text-blue-900 leading-tight">
              Information has been stored safely!
            </h2>
          </div>
        </div>
      )}
    </div>
  );

  // 6. LIVE ASSISTANCE SCREEN
  const renderLiveView = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Live Assistance</h2>
      
      {liveVideoError && (
        <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8 animate-in fade-in">
          {liveVideoError}
        </div>
      )}

      {isLiveAssistanceActive ? (
        <>
          <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl flex flex-col items-center justify-center shadow-2xl border-8 border-slate-900 mb-10 overflow-hidden relative">
            <Webcam 
              audio={false}
              ref={webcamRefLive} 
              screenshotFormat="image/jpeg"
              videoConstraints={{ facingMode: "environment" }} 
              className="rounded-xl w-full h-full object-cover" 
            />
            <div className="absolute top-6 right-6 flex items-center bg-black/50 px-4 py-2 rounded-full">
              <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse mr-3"></div>
              <span className="text-white text-xl font-bold">LIVE STREAM</span>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center space-y-6 mb-12 p-8 bg-blue-50 rounded-3xl border-4 border-blue-200 w-full max-w-3xl">
            <div className="flex items-center space-x-6 text-blue-800">
              <Mic size={48} className="bg-blue-200 p-3 rounded-full animate-pulse" />
              <div className="flex space-x-2">
                <div className="w-4 h-12 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-4 h-16 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-4 h-10 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                <div className="w-4 h-14 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '450ms' }}></div>
              </div>
            </div>
            <span className="text-3xl font-bold text-blue-900 text-center">
              Listening and analyzing context in real time...
            </span>
            {aiTextResponse && (
              <p className="text-2xl text-blue-800 text-center mt-4 p-4 bg-white rounded-xl">
                {aiTextResponse}
              </p>
            )}
          </div>

          <button onClick={stopLiveAssistance} className="w-full max-w-3xl bg-red-700 text-white text-5xl font-extrabold py-10 rounded-3xl shadow-2xl hover:bg-red-800 active:bg-red-900 border-8 border-red-900 transition-all mt-auto mb-6 flex justify-center items-center">
            <StopCircle size={48} className="mr-6" /> Stop Live Assistance
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center p-6 space-y-8 w-full max-w-3xl">
          <button onClick={startLiveAssistance} className="w-full bg-teal-600 text-white text-5xl font-extrabold py-12 rounded-3xl shadow-2xl hover:bg-teal-700 active:bg-teal-800 border-8 border-teal-800 transition-all">
            <Video size={48} className="inline mr-6" /> Start Live Assistance
          </button>
          <BackButton onClick={() => setCurrentScreen('dashboard')} />
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 font-sans selection:bg-blue-200">
      {currentScreen === 'home' && renderHome()}
      {currentScreen === 'login' && renderLogin()}
      {currentScreen === 'signup' && renderSignup()}
      {currentScreen === 'dashboard' && renderDashboard()}
      {currentScreen === 'store_photos' && renderStorePhotos()}
      {currentScreen === 'live_view' && renderLiveView()}
    </div>
  );
}
