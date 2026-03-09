import React, { useState } from 'react';
import BackButton from '../components/BackButton';

export default function Signup({ setCurrentScreen }) {
  const [name, setName] = useState('');
  const [signupUserId, setSignupUserId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [signupErrorMsg, setSignupErrorMsg] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);

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
      const data = await response.json();
      if (response.ok) {
        localStorage.setItem('token', data.token);
        localStorage.setItem('userId', data.user.userId);
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

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 animate-in fade-in">
      <h2 className="text-5xl font-extrabold text-blue-900 mb-10">Sign Up</h2>
      <div className="w-full max-w-xl flex flex-col space-y-6">
        {signupErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {}
          </div>
        )}
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Your Name</label>
          <input 
            type="text" 
            value={}
            onChange={(e) => setName(e.target.value)}
            placeholder="Type your name here"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">User ID</label>
          <input 
            type="text" 
            value={}
            onChange={(e) => setSignupUserId(e.target.value)}
            placeholder="Choose a unique User ID"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Password</label>
          <input 
            type="password" 
            value={}
            onChange={(e) => setSignupPassword(e.target.value)}
            placeholder="Type a password here"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Type Password Again</label>
          <input 
            type="password" 
            value={}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type your password again"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        <button 
          onClick={}
          disabled={}
          className="w-full bg-blue-800 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl hover:bg-blue-900 mt-6 disabled:opacity-70 disabled:cursor-not-allowed transition-all"
        >
          {isSignupLoading ? 'Creating Account...' : 'Sign Up'}
        </button>
        <BackButton onClick={() => setCurrentScreen('home')} />
      </div>
    </div>
  );
}
