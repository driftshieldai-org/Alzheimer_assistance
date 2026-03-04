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
  ImageIcon,
  CameraIcon,
  PlayIcon, 
  StopCircle 
} from 'lucide-react';

const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
let nextPlayTime = 0; // Tracks when the next
 chunk should play

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
    
    const currentTime = audioContext.currentTime;
    
    if (nextPlayTime < currentTime) {
      nextPlayTime = currentTime;
    }
    
    source.start(nextPlayTime);
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

  // --- Live Assistance State Variables (WebSocket & Audio) ---
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const webcamRefLive = useRef(null); 
  const [liveVideoError, setLiveVideoError] = useState('');
  const [processingFrame, setProcessingFrame] = useState(false); 
  const [aiAudioResponse, setAiAudioResponse] = useState(''); 
  const [aiTextResponse, setAiTextResponse] = useState(''); 
  const audioPlayerRef = useRef(null); 
  const wsRef = useRef(null); 
  
  // Real-time video/audio controls
  const isCapturingRef = useRef(false);
  const micStreamRef = useRef(null);
  const audioCaptureContextRef = useRef(null);
  const audioProcessorRef = useRef(null);
  const audioGainNodeRef = useRef(null);

  const BACKEND_API_BASE = "https://alzheimer-backend-902738993392.us-central1.run.app"
    
  // Success modal timer logic for 'store_photos'
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

  // Audio Playback trigger
  useEffect(() => {
    if (aiAudioResponse && audioPlayerRef.current) {
      audioPlayerRef.current.src = aiAudioResponse; 
      audioPlayerRef.current.play().catch(e => console.error("Error playing audio:", e));
    }
  }, [aiAudioResponse]);

  // WebSocket Cleanup
  useEffect(() => {
    return () => stopLiveAssistance();
  }, [currentScreen]);

  // Recursive loop for REAL-TIME video processing (~4 FPS)
  const captureFrameLoop = async () => {
    if (!isCapturingRef.current) return;
    
    await sendLiveFrame();
    
    // 250ms = 4 frames per second. This is the optimal speed for real-time 
    // Gemini Live video without crashing the browser or API quota.
    setTimeout(captureFrameLoop, 250);
  };

  const startLiveAssistance = async () => {
    if (audioContext.state === 'suspended') {
      audioContext.resume();
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
    setAiAudioResponse('');

    // Dynamically determine WebSocket URL
    const wsUrl = `${BACKEND_API_BASE.replace(/^http/, 'ws')}/api/live/ws/live/process-stream?token=${}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = async () => {
      console.log('WebSocket connected.');
      
      // 1. Start continuous REAL-TIME video streaming
      isCapturingRef.current = true;
      captureFrameLoop();

      // 2. Start continuous REAL-TIME audio streaming
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 16000,
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
          }
        });
        
        micStreamRef.current = stream;
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        audioCaptureContextRef.current = audioCtx;
        
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        audioProcessorRef.current = processor;

        // Gain node to avoid looping local mic back to speakers
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = 0;
        audioGainNodeRef.current = gainNode;

        processor.onaudioprocess = (e) => {
          if (!isCapturingRef.current) return;
          const float32Array = e.inputBuffer.getChannelData(0);
          const int16Array = new Int16Array(float32Array.length);
          for (let i = 0; i < float32Array.length; i++) {
            let s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }
          
          const buffer = new ArrayBuffer(int16Array.byteLength);
          new Int16Array(buffer).set(int16Array);
          
          let binary = '';
          const bytes = new Uint8Array(buffer);
          for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64Data = window.btoa(binary);

          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "audio", audioBase64: base64Data }));
          }
        };

        source.connect(processor);
        processor.connect(gainNode);
        gainNode.connect(audioCtx.destination);
      } catch (err) {
        console.error("Microphone access error:", err);
      }
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) {
        setLiveVideoError(`AI Error: ${data.error}`);
      } else {
        setAiTextResponse(data.description || "AI is speaking..."); 
        if (data.audioBase64) {
          playPcmAudio(data.audioBase64);
        }
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
      setProcessingFrame(false);
      stopLiveAssistance();
    };
  };
  
  const stopLiveAssistance = () => {
    // Stop Video Loop
    isCapturingRef.current = false;
    
    // Stop WebSocket
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    // Stop Mic Streaming
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect();
      audioProcessorRef.current = null;
    }
    if (audioGainNodeRef.current) {
      audioGainNodeRef.current.disconnect();
      audioGainNodeRef.current = null;
    }
    if (audioCaptureContextRef.current && audioCaptureContextRef.current.state !== 'closed') {
      audioCaptureContextRef.current.close();
      audioCaptureContextRef.current = null;
    }

    setIsLiveAssistanceActive(false);
    setAiTextResponse('');
    setAiAudioResponse('');
    setProcessingFrame(false);
  };

  const sendLiveFrame = async () => {
    if (!webcamRefLive.current) return; 
    setProcessingFrame(true); 

    try {
      // Small resolution for faster, real-time transmission
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

  // --- Auth & API Handlers ---
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
      console.error("Login Error:", err);
      setLoginErrorMsg('Failed to connect to the server. Please check your internet connection.');
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
      console.error("Signup Error:", err);
      setSignupErrorMsg('Failed to connect to the server. Check browser console for more details.');
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
     
    if (!photoToSend) {
      setPhotoUploadErrorMsg('Please select or capture a photo to upload.');
      setIsPhotoUploading(false);
      return;
    }

    if (!photoDescription || !photoDate) {
      setPhotoUploadErrorMsg('Please add a description and select a date for the photo.');
      setIsPhotoUploading(false);
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setCurrentScreen('login');
      return;
    }

    const formData = new FormData();
    formData.append('photo', photoToSend);
    formData.append('description', photoDescription);
    formData.append('photoDate', photoDate);

    try {
      const response = await fetch('/api/photos/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${}` },
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
        setPhotoUploadErrorMsg(data.message || 'Photo upload failed. Please try again.');
      }
    } catch (err) {
      setPhotoUploadErrorMsg('Failed to connect to the server for photo upload.');
    } finally {
      setIsPhotoUploading(false);
    }
  };

  // Reusable Back Button Component
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
      <ArrowLeft className="mr-4" />
      Go Back
    </button>
  );

  // --- Screens ---
  const renderHome = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in duration-500">
      <div className="flex flex-col items-center mb-16">
        <Brain size={} className="text-blue-800 mb-6" />
        <h1 className="text-6xl font-extrabold text-blue-900 tracking-tight text-center">MemoryMate</h1>
      </div>
      <div className="w-full max-w-xl flex flex-col space-y-8">
        <button onClick={() => setCurrentScreen('login')} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 px-8 rounded-2xl shadow-xl hover:bg-blue-900 active:bg-blue-950 transition-colors border-4 border-blue-900">Login</button>
        <button onClick={() => setCurrentScreen('signup')} className="w-full bg-white text-blue-900 text-4xl font-extrabold py-8 px-8 rounded-2xl shadow-xl hover:bg-slate-100 active:bg-slate-200 transition-colors border-4 border-blue-800">Sign Up</button>
      </div>
    </div>
  );

  const renderLogin = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-12">Login</h2>
      <div className="w-full max-w-xl flex flex-col space-y-8">
        {loginErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">{}</div>}
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">User ID</label>
          <input type="text" value={} onChange={(e) => setLoginUserId(e.target.value)} placeholder="Type your User ID here" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">Password</label>
          <input type="password" value={} onChange={(e) => setLoginPassword(e.target.value)} placeholder="Type your password here" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <button onClick={} disabled={} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-blue-900 mt-8 disabled:opacity-70 transition-all">
          {isLoginLoading ? 'Logging In...' : 'Login'}
        </button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  const renderSignup = () => (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-10">Sign Up</h2>
      <div className="w-full max-w-xl flex flex-col space-y-6">
        {signupErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">{}</div>}
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Your Name</label>
          <input type="text" value={} onChange={(e) => setName(e.target.value)} placeholder="Type your name here" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">User ID</label>
          <input type="text" value={} onChange={(e) => setSignupUserId(e.target.value)} placeholder="Choose a unique User ID" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Password</label>
          <input type="password" value={} onChange={(e) => setSignupPassword(e.target.value)} placeholder="Type a password here" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Type Password Again</label>
          <input type="password" value={} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Type your password again" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
        </div>
        <button onClick={} disabled={} className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-blue-900 mt-6 disabled:opacity-70 transition-all">
          {isSignupLoading ? 'Creating Account...' : 'Sign Up'}
        </button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );

  const renderDashboard = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-12 animate-in fade-in">
      <h2 className="text-4xl md:text-5xl font-extrabold text-blue-900 mb-12 text-center max-w-3xl leading-tight">
        Hello {localStorage.getItem('userId') || ''}! What would you like to do today?
      </h2>
      <div className="w-full max-w-2xl flex flex-col space-y-8 flex-grow">
        <button onClick={() => setCurrentScreen('store_photos')} className="flex-1 flex flex-col items-center justify-center bg-blue-800 text-white rounded-3xl shadow-2xl p-8 hover:bg-blue-900 active:bg-blue-950 transition-all border-4 border-blue-900">
          <Camera size={} className="mb-6" />
          <span className="text-4xl md:text-5xl font-extrabold text-center">Store New Photos</span>
        </button>
        <button onClick={() => setCurrentScreen('live_view')} className="flex-1 flex flex-col items-center justify-center bg-teal-800 text-white rounded-3xl shadow-2xl p-8 hover:bg-teal-900 active:bg-teal-950 transition-all border-4 border-teal-900 mb-8">
          <Video size={} className="mb-6" />
          <span className="text-4xl md:text-5xl font-extrabold text-center">Understand the place live</span>
        </button>
      </div>
    </div>
  );

  const renderStorePhotos = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 animate-in fade-in relative">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Store A Photo</h2>
      <div className="w-full max-w-2xl flex flex-col space-y-8">
        {photoUploadErrorMsg && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">{}</div>}

        {!isCameraActive && !photoFile && !capturedImageSrc && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <button onClick={() => fileInputRef.current.click()} className="flex flex-col items-center justify-center bg-blue-100 border-4 border-blue-300 text-blue-900 p-8 rounded-2xl shadow-md hover:bg-blue-200">
              <Upload size={} className="mb-4" />
              <span className="text-3xl font-bold">Upload from Device</span>
            </button>
            <button onClick={() => setIsCameraActive(true)} className="flex flex-col items-center justify-center bg-green-100 border-4 border-green-300 text-green-900 p-8 rounded-2xl shadow-md hover:bg-green-200">
               <CameraIcon size={} className="mb-4 text-green-900" />
              <span className="text-3xl font-bold text-green-900">Take a Photo Now</span>
            </button>
          </div>
        )}

        {isCameraActive && !capturedImageSrc && (
         <div className="bg-slate-800 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-slate-900 shadow-2xl space-y-6">
          <Webcam audio={} ref={} screenshotFormat="image/jpeg" videoConstraints={{facingMode: "environment"}} className="rounded-xl w-full max-w-2xl aspect-video object-cover" />
          <div className="flex w-full justify-around space-x-4">
           <button onClick={() => {
             const imageSrc = webcamRefCapture.current.getScreenshot({width: 1280, height: 720});
             setCapturedImageSrc(imageSrc); setPhotoFile(null);
           }} className="flex-1 bg-green-700 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-green-800 flex items-center justify-center">
            <CameraIcon className="mr-4" /> Capture Photo
           </button>
           <button onClick={() => setIsCameraActive(false)} className="flex-1 bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-red-200 flex items-center justify-center">
            <ArrowLeft className="mr-4" /> Cancel
           </button>
          </div>
         </div>
        )}

        {capturedImageSrc && (
         <div className="bg-slate-100 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-blue-500 shadow-2xl space-y-6">
          <h3 className="text-3xl font-bold text-blue-900 mt-2">Captured Photo Preview:</h3>
          <img src={} alt="Captured" className="rounded-xl max-w-full h-auto max-h-96 object-contain border-4 border-blue-300" />
          <div className="flex w-full justify-around space-x-4">
           <button onClick={() => setCapturedImageSrc(null)} className="flex-1 bg-orange-500 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-orange-600 flex items-center justify-center">
            <ArrowLeft className="mr-4" /> Retake
           </button>
           <button onClick={} disabled={isPhotoUploading || !photoDescription || !photoDate} className="flex-1 bg-blue-700 text-white text-3xl font-bold py-6 rounded-2xl shadow-md hover:bg-blue-800 flex items-center justify-center disabled:opacity-70">
            {isPhotoUploading ? 'Uploading...' : 'Save Photo'}
           </button>
          </div>
         </div>
        )}

        {photoFile && !isCameraActive && !capturedImageSrc && (
          <div className="bg-blue-50 border-8 border-dashed border-blue-300 rounded-3xl p-12 flex flex-col items-center justify-center shadow-md">
            <ImageIcon size={} className="text-blue-800 mb-4" />
            <span className="text-3xl font-bold text-blue-900 text-center">{photoFile.name} (Ready to upload)</span>
            <button onClick={() => setPhotoFile(null)} className="mt-6 px-6 py-3 bg-red-500 text-white text-xl font-bold rounded-xl hover:bg-red-600">Remove Photo</button>
          </div>
        )}

        <input type="file" accept="image/*" onChange={(e) => { if(e.target.files[0]) setPhotoFile(e.target.files[0]); }} ref={} className="hidden" />

        {(photoFile || capturedImageSrc || (!photoFile && !capturedImageSrc && !isCameraActive)) && ( 
          <>
            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 block">Who or what is in this photo?</label>
              <input type="text" value={} onChange={(e) => setPhotoDescription(e.target.value)} placeholder="Type details for this picture..." className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
            </div>
            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 block">Date of photo</label>
              <input type="date" value={} onChange={(e) => setPhotoDate(e.target.value)} className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none" />
            </div>
          </>
        )}
         
        {(photoFile && !capturedImageSrc) && ( 
          <div className="flex flex-col space-y-6 pt-6">
            <button onClick={} disabled={isPhotoUploading || !photoDescription || !photoDate} className="w-full bg-green-700 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-green-800 border-4 border-green-800 disabled:opacity-70">
              {isPhotoUploading ? 'Uploading...' : 'Save Photo'}
            </button>
            <button onClick={() => setCurrentScreen('dashboard')} className="w-full bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl shadow-md border-4 border-red-300 hover:bg-red-200">
              Cancel
            </button>
          </div>
        )}
      </div>

      {showSuccess && (
        <div className="fixed inset-0 bg-blue-950/90 flex flex-col items-center justify-center z-50 p-6 animate-in fade-in" onClick={() => {setShowSuccess(false); setCurrentScreen('dashboard');}}>
         <div className="bg-white rounded-3xl p-12 max-w-2xl w-full flex flex-col items-center text-center shadow-2xl border-8 border-green-500">
          <CheckCircle size={} className="text-green-600 mb-8" />
          <h2 className="text-5xl font-extrabold text-blue-900 leading-tight">Information has been stored safely!</h2>
         </div>
        </div>
      )}
    </div>
  );

  const renderLiveView = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Live View Assistance</h2>
      
      {liveVideoError && <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8">{}</div>}

      {isLiveAssistanceActive ? (
        <>
         <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl flex flex-col items-center justify-center shadow-2xl border-8 border-slate-900 mb-10 overflow-hidden relative">
          <Webcam audio={} ref={} videoConstraints={{ facingMode: "environment" }} className="rounded-xl w-full h-full object-cover" />
          <div className="absolute top-6 right-6 flex items-center bg-black/50 px-4 py-2 rounded-full">
           <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse mr-3"></div>
           <span className="text-white text-xl font-bold">LIVE STREAM</span>
          </div>
         </div>

         <div className="flex flex-col items-center justify-center space-y-6 mb-12 p-8 bg-blue-50 rounded-3xl border-4 border-blue-200 w-full max-w-3xl">
          <div className="flex items-center space-x-6 text-blue-800">
           <Mic size={} className={`bg-blue-200 p-3 rounded-full ${processingFrame ? 'animate-pulse' : ''}`} />
           <div className="flex space-x-2">
            <div className={`w-4 h-12 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '0ms' }}></div>
            <div className={`w-4 h-16 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '150ms' }}></div>
            <div className={`w-4 h-10 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '300ms' }}></div>
            <div className={`w-4 h-14 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '450ms' }}></div>
           </div>
          </div>
          <span className="text-4xl font-extrabold text-blue-900 text-center">
           {processingFrame ? 'Sending to A.I. for analysis...' : (aiTextResponse || 'Awaiting input...')}
          </span>
         </div>

         <button onClick={} className="w-full max-w-3xl bg-red-700 text-white text-5xl font-extrabold py-10 rounded-3xl shadow-2xl hover:bg-red-800 active:bg-red-900 border-8 border-red-900 mt-auto mb-6 flex justify-center items-center">
          <StopCircle size={56} className="mr-6" /> Stop Live Assistance
         </button>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center p-6 space-y-8 w-full max-w-3xl">
         <button onClick={} className="w-full bg-teal-600 text-white text-5xl font-extrabold py-12 rounded-3xl shadow-2xl hover:bg-teal-700 active:bg-teal-800 border-8 border-teal-800 transition-all">
          <Video className="inline mr-6" size={56} /> Start Live Assistance
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

              
