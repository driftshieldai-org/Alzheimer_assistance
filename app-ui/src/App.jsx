import React, { useState, useEffect } from 'react';
import { 
  Brain, 
  ArrowLeft, 
  Camera, 
  Video, 
  CheckCircle, 
  Mic, 
  Upload
} from 'lucide-react';

export default function MemoryMateApp() {
  const [currentScreen, setCurrentScreen] = useState('home');
  const [showSuccess, setShowSuccess] = useState(false);

  // --- SignUp State Variables ---
  const [name, setName] = useState('');
  const [signupEmail, setSignupEmail] = useState(''); // Renamed to avoid collision with loginEmail
  const [signupPassword, setSignupPassword] = useState(''); // Renamed
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupErrorMsg, setSignupErrorMsg] = useState(''); // Renamed
  const [isSignupLoading, setIsSignupLoading] = useState(false); // Renamed

  // --- Login State Variables --- NEW
  const [loginEmail, setLoginEmail] = useState(''); 
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErrorMsg, setLoginErrorMsg] = useState(''); 
  const [isLoginLoading, setIsLoginLoading] = useState(false); 

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


  // --- NEW: handleLogin Function ---
  const handleLogin = async () => {
    setIsLoginLoading(true);
    setLoginErrorMsg('');

    if (!loginEmail || !loginPassword) {
      setLoginErrorMsg('Please enter both email and password.');
      setIsLoginLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail, password: loginPassword })
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
        localStorage.setItem('userName', data.user.name);
        
        // Clear form and go to Dashboard
        setLoginEmail(''); setLoginPassword('');
        setCurrentScreen('dashboard');
      } else {
        setLoginErrorMsg(data.message || 'Login failed. Please try again.');
      }
    } catch (err) {
      console.error("Login Error:", err);
      setLoginErrorMsg('Failed to connect to the server. Please check your internet connection.');
    } finally {
      setIsLoginLoading(false);
    }
  };

  // --- Updated handleSignup Function ---
  const handleSignup = async () => {
    setIsSignupLoading(true);
    setSignupErrorMsg('');

    if (signupPassword !== confirmPassword) {
      setSignupErrorMsg('Passwords do not match. Please try again.');
      setIsSignupLoading(false);
      return;
    }

    if (!name || !signupEmail || !signupPassword) {
      setSignupErrorMsg('Please fill out all fields.');
      setIsSignupLoading(false);
      return;
    }

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email: signupEmail, password: signupPassword })
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
        localStorage.setItem('userName', data.user.name);
        
        setName(''); setSignupEmail(''); setSignupPassword(''); setConfirmPassword('');
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

  // Reusable Back Button Component
  const BackButton = ({ onClick }) => (
    <button 
      onClick={() => {
        setSignupErrorMsg(''); // Clear signup errors when going back
        setLoginErrorMsg(''); // Clear login errors when going back
        setLoginEmail(''); setLoginPassword(''); // Clear login form
        setName(''); setSignupEmail(''); setSignupPassword(''); setConfirmPassword(''); // Clear signup form
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

  // 2. LOGIN SCREEN (Updated with state & fetch)
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
          <label className="text-3xl font-bold text-blue-900 mb-4 block">Email Address</label>
          <input 
            type="email" 
            value={loginEmail}
            onChange={(e) => setLoginEmail(e.target.value)}
            placeholder="Type your email here" 
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

  // 3. SIGN UP SCREEN (Renamed state variables to avoid confusion)
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
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Email Address</label>
          <input 
            type="email" 
            value={signupEmail}
            onChange={(e) => setSignupEmail(e.target.value)}
            placeholder="Type your email here"
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
        Hello {localStorage.getItem('userName') || ''}! What would you like to do today?
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
        <div className="w-full bg-blue-50 border-8 border-dashed border-blue-300 rounded-3xl p-12 flex flex-col items-center justify-center cursor-pointer hover:bg-blue-100">
          <Upload size={64} className="text-blue-800 mb-4" />
          <span className="text-3xl font-bold text-blue-900 text-center">Tap here to choose a photo</span>
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">Who or what is in this photo?</label>
          <input type="text" placeholder="Type details here..." className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900" />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-4 block">Date of photo</label>
          <input type="date" className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900" />
        </div>
        <div className="flex flex-col space-y-6 pt-6">
          <button onClick={() => setShowSuccess(true)} className="w-full bg-green-700 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-green-800 border-4 border-green-800">
            Save Photo
          </button>
          <button onClick={() => setCurrentScreen('dashboard')} className="w-full bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl shadow-md border-4 border-red-300 hover:bg-red-200">
            Cancel
          </button>
        </div>
      </div>
      {showSuccess && (
        <div className="fixed inset-0 bg-blue-950/90 flex flex-col items-center justify-center z-50 p-6 animate-in fade-in duration-300" onClick={() => {setShowSuccess(false); setCurrentScreen('dashboard');}}>
          <div className="bg-white rounded-3xl p-12 max-w-2xl w-full flex flex-col items-center text-center shadow-2xl border-8 border-green-500 transform transition-all scale-100">
            <CheckCircle size={120} className="text-green-600 mb-8" />
            <h2 className="text-5xl font-extrabold text-blue-900 leading-tight">Information has been stored safely!</h2>
          </div>
        </div>
      )}
    </div>
  );

  // 6. UNDERSTAND THE PLACE LIVE SCREEN
  const renderLiveView = () => (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-8 text-center">Live View</h2>
      <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl flex flex-col items-center justify-center shadow-2xl border-8 border-slate-900 mb-10 overflow-hidden relative">
        <Camera size={80} className="text-slate-400 mb-4" />
        <span className="text-3xl font-bold text-slate-300">Live Camera Feed</span>
        <div className="absolute top-6 right-6 flex items-center bg-black/50 px-4 py-2 rounded-full">
          <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse mr-3"></div>
          <span className="text-white text-xl font-bold">LIVE</span>
        </div>
      </div>
      <div className="flex flex-col items-center justify-center space-y-6 mb-12 p-8 bg-blue-50 rounded-3xl border-4 border-blue-200 w-full max-w-3xl">
        <div className="flex items-center space-x-6 animate-pulse text-blue-800">
          <Mic size={64} className="bg-blue-200 p-3 rounded-full" />
          <div className="flex space-x-2">
            <div className="w-4 h-12 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
            <div className="w-4 h-16 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
            <div className="w-4 h-10 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
            <div className="w-4 h-14 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '450ms' }}></div>
          </div>
        </div>
        <span className="text-4xl font-extrabold text-blue-900 text-center">Listening and analyzing...</span>
      </div>
      <button onClick={() => setCurrentScreen('dashboard')} className="w-full max-w-3xl bg-red-700 text-white text-5xl font-extrabold py-10 rounded-3xl shadow-2xl hover:bg-red-800 active:bg-red-900 border-8 border-red-900 transition-all mt-auto mb-6 flex justify-center items-center">
        <ArrowLeft size={48} className="mr-6" />
        Stop / Go Back
      </button>
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
