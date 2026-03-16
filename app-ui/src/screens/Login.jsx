import React, { useState } from 'react';
import BackButton from '../components/BackButton';

export default function Login({ setCurrentScreen }) {
  const BACKEND_API_BASE = window.runtimeConfig?.BACKEND_URL || "http://localhost:5000";
  const [loginUserId, setLoginUserId] = useState(''); 
  const [loginPassword, setLoginPassword] = useState('');
  const [loginErrorMsg, setLoginErrorMsg] = useState(''); 
  const [isLoginLoading, setIsLoginLoading] = useState(false);

  const handleLogin = async () => {
    setIsLoginLoading(true);
    setLoginErrorMsg('');
    if (!loginUserId || !loginPassword) {
      setLoginErrorMsg('Please enter both User ID and password.');
      setIsLoginLoading(false);
      return;
    }
    try {
      const response = await fetch('${BACKEND_API_BASE}/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: loginUserId, password: loginPassword })
      });
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
        localStorage.setItem('trackLocation', data.user.trackLocation);
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

  return (
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
}
