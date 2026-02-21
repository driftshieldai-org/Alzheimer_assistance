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
  CloudUpload, 
  ImageIcon,
  CameraIcon,
  PlayIcon, // NEW for audio playback
  StopCircle // NEW for stopping live assistance
} from 'lucide-react';

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
  const [isCameraActive, setIsCameraActive] = useState(false); // For Store Photos screen
  const webcamRefCapture = useRef(null); // Ref for Webcam component on Store Photos screen
  const [capturedImageSrc, setCapturedImageSrc] = useState(null); // Stores base64 of captured image

  // --- NEW: Live Assistance State Variables ---
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const webcamRefLive = useRef(null); // Ref for Webcam component on Live View screen
  const [liveVideoError, setLiveVideoError] = useState('');
  const [processingFrame, setProcessingFrame] = useState(false);
  const [aiAudioResponse, setAiAudioResponse] = useState(''); // Stores base64 audio or URL
  const [aiTextResponse, setAiTextResponse] = useState(''); // Stores text response
  const audioPlayerRef = useRef(null); // Ref for audio element
  const captureIntervalRef = useRef(null); // To manage interval for sending frames


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

  // --- NEW: Live Assistance Effects ---
  useEffect(() => {
    if (aiAudioResponse && audioPlayerRef.current) {
        audioPlayerRef.current.play().catch(e => console.error("Error playing audio:", e));
    }
  }, [aiAudioResponse]);

  useEffect(() => {
    // Cleanup interval if component unmounts or leaves live view
    return () => {
      if (captureIntervalRef.current) {
        clearInterval(captureIntervalRef.current);
        captureIntervalRef.current = null;
      }
    };
  }, []);

  // --- NEW: Live Assistance Functions ---
  const startLiveAssistance = () => {
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

    // Start sending frames periodically
    captureIntervalRef.current = setInterval(processLiveFrame, 2000); // Send frame every 2 seconds
  };
  
  const stopLiveAssistance = () => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
    setIsLiveAssistanceActive(false);
    setAiTextResponse('');
    setAiAudioResponse('');
    setProcessingFrame(false);
  };

  const processLiveFrame = async () => {
    if (!webcamRefLive.current || processingFrame) return;

    setProcessingFrame(true);
    setLiveVideoError('');
    setAiTextResponse('');
    setAiAudioResponse('');

    const imageSrc = webcamRefLive.current.getScreenshot({width: 640, height: 360}); // Capture screenshot
    if (!imageSrc) {
        setLiveVideoError("Failed to capture image from webcam.");
        setProcessingFrame(false);
        return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
        setLiveVideoError("Authentication token missing for live assistance.");
        stopLiveAssistance();
        setCurrentScreen('login');
        return;
    }

    // Convert base64 to Blob for FormData
    const byteString = atob(imageSrc.split(',')[1]);
    const mimeString = imageSrc.split(',')[0].split(':')[1].split(';')[0];
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mimeString });

    const formData = new FormData();
    formData.append('frame', blob, 'live-frame.jpeg'); // 'frame' key must match backend multer config

    try {
      const response = await fetch('/api/live/process-frame', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const textError = await response.text();
        console.error("Server returned HTML or text instead of JSON (Live Frame):", textError);
        throw new Error("Server configuration error for live frame. Check console.");
      }

      const data = await response.json();

      if (response.ok) {
        setAiTextResponse(data.description);
        setAiAudioResponse(data.audio); // Play audio if available
      } else {
        setLiveVideoError(data.message || 'Error processing live frame.');
      }
    } catch (err) {
      console.error("Live Frame API Error:", err);
      setLiveVideoError('Failed to connect to the backend for live processing.');
    } finally {
      setProcessingFrame(false);
    }
  };


  // --- handleLogin Function ---
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
      console.error("Login Error:", err);
      setLoginErrorMsg('Failed to connect to the server. Please check your internet connection.');
    } finally {
      setIsLoginLoading(false);
    }
  };

  // --- handleSignup Function ---
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
      console.error("Signup Error:", err);
      setSignupErrorMsg('Failed to connect to the server. Check browser console for more details.');
    } finally {
      setIsSignupLoading(false);
    }
  };

  // --- handlePhotoUpload Function ---
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
            console.error("Error converting captured image to file:", error);
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

    if (!photoDescription) {
      setPhotoUploadErrorMsg('Please add a description for the photo.');
      setIsPhotoUploading(false);
      return;
    }
    if (!photoDate) {
      setPhotoUploadErrorMsg('Please select the date the photo was taken.');
      setIsPhotoUploading(false);
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
        setPhotoUploadErrorMsg('You must be logged in to upload photos.');
        setIsPhotoUploading(false);
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
        headers: {
          'Authorization': `Bearer ${token}`
        },
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
        setPhotoUploadErrorMsg(data.message || 'Photo upload failed. Please try again.');
      }
    } catch (err) {
      console.error("Photo Upload Error:", err);
      if (err.message.includes("File too large")) {
          setPhotoUploadErrorMsg("The photo file is too large (max 5MB).");
      } else {
          setPhotoUploadErrorMsg('Failed to connect to the server for photo upload. Check browser console.');
      }
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
    [webcamRefCapture, setCapturedImageSrc]
  );
  
  const handleRetryCameraCapture = () => {
    setCapturedImageSrc(null);
  };
  
  const handleCancelCameraCapture = () => {
    setIsCameraActive(false);
    setCapturedImageSrc(null);
    setPhotoFile(null);
  };


  // Reusable Back Button Component
  const BackButton = ({ onClick }) => (
    <button 
      onClick={() => {
        // Clear all errors and form states when going back
        setSignupErrorMsg(''); setLoginErrorMsg(''); setPhotoUploadErrorMsg(''); setLiveVideoError('');
        setLoginUserId(''); setLoginPassword('');
        setName(''); setSignupUserId(''); setSignupPassword(''); setConfirmPassword('');
        setPhotoFile(null); setPhotoDescription(''); setPhotoDate('');
        setIsCameraActive(false); setCapturedImageSrc(null); 
        stopLiveAssistance(); // Ensure live assistance is stopped
        onClick();
      }}
      className="flex items-center justify-center w-full max-w-xl bg-slate-200 text-blue-900 text-3xl font-bold py-6 px-8 rounded-2xl shadow-md border-4 border-slate-300 hover:bg-slate-300 active:bg-slate-400 transition-colors mt-6"
    >
      <ArrowLeft size={40} className="mr-4" />
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
              className="rounded-xl w-full max-w-2xl aspect-video object-cover" // Ensure it covers the area and maintains aspect ratio
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
                onClick={handlePhotoUpload} // Directly trigger upload with captured image
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
        {(photoFile && !capturedImageSrc) && ( // Show save button only if a file is uploaded, and not for a captured image that has its own save button
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

  // 6. UNDERSTAND THE PLACE LIVE SCREEN (UPDATED)
  const renderLiveView = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Live View Assistance</h2>
      
      {liveVideoError && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8 animate-in fade-in">
            {liveVideoError}
          </div>
        )}

      {isLiveAssistanceActive ? (
        <>
          {/* Live Camera Feed */}
          <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl flex flex-col items-center justify-center shadow-2xl border-8 border-slate-900 mb-10 overflow-hidden relative">
            <Webcam
              audio={false}
              ref={webcamRefLive}
              videoConstraints={{ facingMode: "environment" }}
              className="rounded-xl w-full h-full object-cover"
              onUserMediaError={(err) => {
                console.error("Webcam Error:", err);
                setLiveVideoError("Could not access camera. Please allow camera permissions.");
                stopLiveAssistance(); // Stop if camera fails
              }}
            />
            {/* Red recording dot */}
            <div className="absolute top-6 right-6 flex items-center bg-black/50 px-4 py-2 rounded-full">
              <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse mr-3"></div>
              <span className="text-white text-xl font-bold">LIVE</span>
            </div>
          </div>

          {/* Voice Processing Indicator */}
          <div className="flex flex-col items-center justify-center space-y-6 mb-12 p-8 bg-blue-50 rounded-3xl border-4 border-blue-200 w-full max-w-3xl">
            <div className="flex items-center space-x-6 text-blue-800">
              <Mic size={64} className={`bg-blue-200 p-3 rounded-full ${processingFrame ? 'animate-pulse' : ''}`} />
              <div className="flex space-x-2">
                <div className={`w-4 h-12 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '0ms' }}></div>
                <div className={`w-4 h-16 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '150ms' }}></div>
                <div className={`w-4 h-10 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '300ms' }}></div>
                <div className={`w-4 h-14 bg-blue-600 rounded-full ${processingFrame ? 'animate-bounce' : ''}`} style={{ animationDelay: '450ms' }}></div>
              </div>
            </div>
            <span className="text-4xl font-extrabold text-blue-900 text-center">
              {processingFrame ? 'Listening and analyzing...' : (aiTextResponse || 'Awaiting input...')}
            </span>
            {aiAudioResponse && (
                <div className="mt-4">
                  <audio ref={audioPlayerRef} src={aiAudioResponse} controls className="hidden"></audio> {/* Hidden controls, audio plays via useEffect */}
                  <button onClick={() => audioPlayerRef.current.play()} className="bg-blue-600 text-white p-4 rounded-xl text-2xl font-bold flex items-center hover:bg-blue-700">
                    <PlayIcon size={32} className="mr-3" /> Play Message Again
                  </button>
                </div>
            )}
          </div>

          {/* Stop / Go Back Button */}
          <button 
            onClick={stopLiveAssistance}
            className="w-full max-w-3xl bg-red-700 text-white text-5xl font-extrabold py-10 rounded-3xl shadow-2xl hover:bg-red-800 active:bg-red-900 border-8 border-red-900 transition-all mt-auto mb-6 flex justify-center items-center"
          >
            <StopCircle size={48} className="mr-6" />
            Stop Live Assistance
          </button>
        </>
      ) : (
        // Start Live Assistance button
        <div className="flex flex-col items-center justify-center p-6 space-y-8 w-full max-w-3xl">
          <button 
            onClick={startLiveAssistance}
            className="w-full bg-teal-600 text-white text-5xl font-extrabold py-12 rounded-3xl shadow-2xl hover:bg-teal-700 active:bg-teal-800 border-8 border-teal-800 transition-all"
          >
            <Video size={64} className="inline mr-6" />
            Start Live Assistance
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
