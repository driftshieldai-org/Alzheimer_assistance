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
  StopCircle 
} from 'lucide-react';

// --- EMBEDDED AUDIO PROCESSOR ---
const AUDIO_WORKLET_CODE = `
class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.audioBuffer = [];
    this.bufferSize = 4096;
    this.gain = 5.0; // INCREASED GAIN to ensure VAD triggers
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channelData = input[0];
      
      // DEBUG: Check if audio is actually present (not just zeros)
      let maxVal = 0;
      for (let i = 0; i < channelData.length; i++) {
        if (Math.abs(channelData[i]) > maxVal) maxVal = Math.abs(channelData[i]);
        this.audioBuffer.push(channelData[i]);
      }
      
      // If maxVal stays 0, your mic is muted or broken.

      if (this.audioBuffer.length >= this.bufferSize) {
        const chunkToSend = this.audioBuffer.slice(0, this.bufferSize);
        this.audioBuffer = this.audioBuffer.slice(this.bufferSize);
        
        const pcm16Buffer = new Int16Array(chunkToSend.length);
        for (let i = 0; i < chunkToSend.length; i++) {
            let s = Math.max(-1, Math.min(1, chunkToSend[i] * this.gain));
            pcm16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        this.port.postMessage({ 
            type: 'audio_data', 
            int16Buffer: pcm16Buffer.buffer 
        }, [pcm16Buffer.buffer]);
      }
    }
    return true; 
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;

const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
let nextPlayTime = 0; // Tracks when the next chunk should play
let activeAudioSources = [];

function clearAudioQueue() {
  activeAudioSources.forEach(source => {
    try { source.stop(); source.disconnect(); } catch (e) {}
  });
  activeAudioSources = [];
  nextPlayTime = audioContext.currentTime; // Reset timing back to now
}


async function playPcmAudio(base64Data) {
  try {

    
    const binaryString = window.atob(base64Data);
    const len = binaryString.length;
    const bytes = new Int16Array(len / 2);
    for (let i = 0; i < len / 2; i++) {
      bytes[i] = binaryString.charCodeAt(i * 2) | (binaryString.charCodeAt(i * 2 + 1) << 8);
    }
    
    const buffer = audioContext.createBuffer(1, bytes.length, 24000);
    const channelData = buffer.getChannelData(0);
    for (let i = 0; i < bytes.length; i++) {
      channelData[i] = bytes[i] / 32768.0;
    }
    
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    source.onended = () => {
        activeAudioSources = activeAudioSources.filter(s => s !== source);
    };
    
    const currentTime = audioContext.currentTime;
    
    if (nextPlayTime < currentTime) {
      nextPlayTime = currentTime;
    }
    
    source.start(nextPlayTime);
    activeAudioSources.push(source);
    nextPlayTime += buffer.duration;
  } catch (err) {
    console.error("Audio playback error:", err);
  }
}

export default function MemoryMateApp() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [showSuccess, setShowSuccess] = useState(false);

  // --- SignUp State Variables ---
  const [name, setName] = useState('');
  const [signupUserId, setSignupUserId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupErrorMsg, setSignupErrorMsg] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);

  // --- Login State Variables ---
  const [loginUserId, setLoginUserId] = useState(''); 
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErrorMsg, setLoginErrorMsg] = useState(''); 
  const [isLoginLoading, setIsLoginLoading] = useState(false);

  // --- Photo Upload State Variables ---
  const [photoFile, setPhotoFile] = useState(null); 
  const [photoDescription, setPhotoDescription] = useState('');
  const [photoDate, setPhotoDate] = useState('');
  const [photoUploadErrorMsg, setPhotoUploadErrorMsg] = useState('');
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const fileInputRef = useRef(null);

  // --- Live Camera State Variables (for Photo Capture) ---
  const [isCameraActive, setIsCameraActive] = useState(false); 
  const webcamRefCapture = useRef(null); 
  const [capturedImageSrc, setCapturedImageSrc] = useState(null);

  // --- Live Assistance State Variables (WebSocket based) ---
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const webcamRefLive = useRef(null); 
  const [liveVideoError, setLiveVideoError] = useState('');
  const [processingFrame, setProcessingFrame] = useState(false);
  const [aiTextResponse, setAiTextResponse] = useState(''); 
  const wsRef = useRef(null); 
  const captureIntervalIdRef = useRef(null); 
  
  // Audio Input Refs
  const audioContextMicRef = useRef(null);
  const micStreamRef = useRef(null);
  const audioProcessorRef = useRef(null);

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
      stopLiveAssistance(); // Cleanup on unmount or screen change
    };
  }, [currentScreen]);

  // This function now uses AudioWorklet for better performance and to avoid deprecated APIs.
const startMicCapture = async () => {
  try {
   if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

   // 1. Get Microphone Stream
   const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
     channelCount: 1,
     echoCancellation: true,
     autoGainControl: true,
     noiseSuppression: true,
     // Try to request 16k, but browsers might ignore this
     sampleRate: 16000 
    }
   });
   micStreamRef.current = stream;

   // 2. Initialize AudioContext with explicit sampleRate
   // This forces the browser to resample if the hardware is 48k
   const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ 
     sampleRate: 16000,
   });
   
   audioContextMicRef.current = audioCtx;

   // DEBUG LOG: Confirm the rate is actually 16000
   console.log(`🎤 Audio Context Sample Rate: ${audioCtx.sampleRate}Hz`);

   if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
   }

   // 3. Load Embedded Processor
   const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
   const workletUrl = URL.createObjectURL(blob);
   await audioCtx.audioWorklet.addModule(workletUrl);

   const processorNode = new AudioWorkletNode(audioCtx, 'audio-processor');
   audioProcessorRef.current = processorNode;

   const source = audioCtx.createMediaStreamSource(stream);

   // Optimized Base64 Helper
   const arrayBufferToBase64 = (buffer) => {
     let binary = '';
     const bytes = new Uint8Array(buffer);
     const len = bytes.byteLength;
     for (let i = 0; i < len; i++) {
       binary += String.fromCharCode(bytes[i]);
     }
     return window.btoa(binary);
   };

   // 4. Handle Audio Data
   processorNode.port.onmessage = (event) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    const { type, int16Buffer } = event.data;
    
    if (type === 'audio_data' && int16Buffer) {
      // Convert and send
      const audioBase64 = arrayBufferToBase64(int16Buffer);
      wsRef.current.send(JSON.stringify({ type: "audio", audioBase64 }));
    }
   };

   source.connect(processorNode);
   console.log("🎤 Microphone capture started.");

  } catch (err) {
   console.error("Microphone error:", err);
   setLiveVideoError("Microphone access failed.");
  }
 };

  
  const startLiveAssistance = async () => {
    // Ensure audio context is resumed by a user gesture, like the start button click
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
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

    const wsUrl = `wss://${new URL(BACKEND_API_BASE).host}/api/live/ws/live/process-stream?token=${token}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = () => {
      console.log('WebSocket connected.');
      startMicCapture(); // Start capturing audio input immediately
      // Speed up the frame capture to 1 per second for a "real-time" video feel
      captureIntervalIdRef.current = setInterval(sendLiveFrame, 1000); 
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === "audioResponse") {
        if (data.description) setAiTextResponse(data.description);
        if (data.audioBase64) playPcmAudio(data.audioBase64);
      } else if (data.type === "interrupted") {
        clearAudioQueue();
      } else if (data.error) {
        setLiveVideoError(`AI Error: ${data.error}`);
      }

      // This should be outside the conditional logic to ensure it always runs
      // after a message is processed, preventing the UI from getting stuck.
      // We can add a check to only set it if it's currently true.
      if (processingFrame) {
        setProcessingFrame(false);
      }
    };

    wsRef.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setLiveVideoError("Connection error. Please try again.");
      stopLiveAssistance();
    };

    wsRef.current.onclose = () => {
      console.log('WebSocket disconnected.');
      stopLiveAssistance();
    };
  };
  
  const stopLiveAssistance = () => {
    if (captureIntervalIdRef.current) {
      clearInterval(captureIntervalIdRef.current);
      captureIntervalIdRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    // Clean up Audio mic connections
    if (audioProcessorRef.current && audioContextMicRef.current) {
      if (audioProcessorRef.current.port) {
        audioProcessorRef.current.port.postMessage({ type: 'stop' });
      }
      audioProcessorRef.current.disconnect(); // Disconnect the worklet node
      audioContextMicRef.current.close();
      audioProcessorRef.current = null;
      audioContextMicRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    setIsLiveAssistanceActive(false);
    setAiTextResponse('');
    setProcessingFrame(false);
  };

  const sendLiveFrame = async () => {
    if (!webcamRefLive.current) return; 
    setProcessingFrame(true); 

    try {
      const imageSrc = webcamRefLive.current.getScreenshot({width: 640, height: 360}); 
      if (!imageSrc) return;

      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        const base64Data = imageSrc.split(',')[1];
        wsRef.current.send(JSON.stringify({ type: "frame", frameBase64: base64Data }));
      }
    } catch (err) {
      console.error("Error capturing or sending frame:", err);
    }
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
        const textError = await response.text();
        console.error("Server returned HTML or text instead of JSON:", textError);
        throw new Error("Server configuration error. Check console.");
      }
      
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setLoginUserId(''); setLoginPassword('');
        setCurrentScreen('dashboard');
      } else {
        setLoginErrorMsg(data.message || 'Login failed. Please check User ID or password.');
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
      setSignupErrorMsg('Passwords do not match. Please try again.');
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
        const textError = await response.text();
        console.error("Server returned HTML or text instead of JSON:", textError);
        throw new Error("Server configuration error. Check console.");
      }
      
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        setName(''); setSignupUserId(''); setSignupPassword(''); setConfirmPassword('');
        setCurrentScreen('dashboard');
      } else {
        setSignupErrorMsg(data.message || 'Something went wrong during signup.');
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
        photoToSend = new File([blob], `captured_photo_${Date.now()}.jpeg`, { type: blob.type });
        setPhotoFile(photoToSend); 
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

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const textError = await response.text();
        console.error("Server returned HTML or text instead of JSON (Photo Upload):", textError);
        throw new Error("Server configuration error for photo upload. Check console.");
      }
      
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

  // --- handleFileChange and Drag/Drop functions for photo upload ---
  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setPhotoFile(e.target.files[0]);
      setCapturedImageSrc(null); 
      setIsCameraActive(false); 
      setPhotoUploadErrorMsg('');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setPhotoFile(e.dataTransfer.files[0]);
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

  // --- Camera capture functions (for Store Photos screen) ---
  const videoConstraintsCapture = {
    facingMode: "environment" 
  };

  const capturePhoto = useCallback(
    () => {
      const imageSrc = webcamRefCapture.current.getScreenshot({width: 1280, height: 720}); 
      setCapturedImageSrc(imageSrc);
      setPhotoFile(null); 
      setPhotoUploadErrorMsg('');
    },
    [webcamRefCapture]
  );
  
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
        setSignupErrorMsg(''); setLoginErrorMsg(''); setPhotoUploadErrorMsg(''); setLiveVideoError('');
        setLoginUserId(''); setLoginPassword('');
        setName(''); setSignupUserId(''); setSignupPassword(''); setConfirmPassword('');
        setPhotoFile(null); setPhotoDescription(''); setPhotoDate('');
        setIsCameraActive(false); setCapturedImageSrc(null); 
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

  // 2. LOGIN SCREEN (Updated for userId)
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

  // 5. STORE PHOTOS SCREEN (Updated with Camera option)
  const renderStorePhotos = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 animate-in fade-in relative">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Store A Photo</h2>
      
      <div className="w-full max-w-2xl flex flex-col space-y-8">
        
        {photoUploadErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {photoUploadErrorMsg}
          </div>
        )}

        {/* --- Photo Source Selection --- */}
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

        {/* --- Camera View (for Photo Capture) --- */}
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

        {/* --- Captured Image Preview --- */} 
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

        {/* --- Uploaded File Preview --- */}
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
        {/* Hidden input for actual file selection */}
        <input 
          type="file" 
          accept="image/*" 
          onChange={handleFileChange} 
          ref={fileInputRef} 
          className="hidden" 
        />

        {/* --- Inputs (Display only if a photo is selected/captured or ready to be selected) --- */}
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
        

        {/* --- Action Buttons (only show if a photo is ready AND NOT already handled by capturedImageSrc buttons) --- */}
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

      {/* Success Modal Overlay */}
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

  // 6. UNDERSTAND THE PLACE LIVE SCREEN (UPDATED for WebSockets)  
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
              audio={false} // WE Mute this because we manually capture audio stream for Gemini
              ref={webcamRefLive} 
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
              <Mic size={48} className={`bg-blue-200 p-3 rounded-full animate-pulse`} />
              <div className="flex space-x-2">
                <div className={`w-4 h-12 bg-blue-600 rounded-full animate-bounce`} style={{ animationDelay: '0ms' }}></div>
                <div className={`w-4 h-16 bg-blue-600 rounded-full animate-bounce`} style={{ animationDelay: '150ms' }}></div>
                <div className={`w-4 h-10 bg-blue-600 rounded-full animate-bounce`} style={{ animationDelay: '300ms' }}></div>
                <div className={`w-4 h-14 bg-blue-600 rounded-full animate-bounce`} style={{ animationDelay: '450ms' }}></div>
              </div>
            </div>
            <span className="text-3xl font-bold text-blue-900 text-center">
              Listening and analyzing context in real time...
            </span>
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
