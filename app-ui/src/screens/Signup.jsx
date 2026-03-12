import React, { useState } from 'react';
import BackButton from '../components/BackButton';

export default function Signup({ setCurrentScreen }) {
  const [name, setName] = useState('');
  const [signupUserId, setSignupUserId] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  
  // New fields state
  const [emergencyEmail, setEmergencyEmail] = useState('');
  const [trackLocation, setTrackLocation] = useState('no'); // default to 'no'

  const [signupErrorMsg, setSignupErrorMsg] = useState('');
  const [isSignupLoading, setIsSignupLoading] = useState(false);

  const validateUserId = (id) => {
    // Alphanumeric, at least 1 letter, 1 number, 8-15 length
    const regex = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z\d]{8,15}$/;
    return regex.test(id);
  };

  const validatePassword = (pass) => {
    // At least 1 letter, 1 number, 1 safe special char, 8-15 length
    const regex = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@#$])[A-Za-z\d@#$]{8,15}$/;
    return regex.test(pass);
  };

  const validateEmail = (email) => {
    // Basic email validation regex
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  };

  const handleSignup = async () => {
    setIsSignupLoading(true);
    setSignupErrorMsg('');
    
    // Check required fields
    if (!name || !signupUserId || !signupPassword || !confirmPassword) {
      setSignupErrorMsg('Please fill out all required fields.');
      setIsSignupLoading(false);
      return;
    }

    if (!validateUserId(signupUserId)) {
      setSignupErrorMsg('User ID must be 8-15 characters, alphanumeric only, with at least one letter and one number.');
      setIsSignupLoading(false);
      return;
    }

    if (!validatePassword(signupPassword)) {
      setSignupErrorMsg('Password must be 8-15 characters, with at least one letter, one number, and one special character ( @ # $ ).');
      setIsSignupLoading(false);
      return;
    }

    if (signupPassword !== confirmPassword) {
      setSignupErrorMsg('Passwords do not match.');
      setIsSignupLoading(false);
      return;
    }

    // Validate email ONLY if it was provided
    if (emergencyEmail && !validateEmail(emergencyEmail)) {
      setSignupErrorMsg('Please enter a valid emergency email address.');
      setIsSignupLoading(false);
      return;
    }

    // Convert trackLocation "yes"/"no" string to boolean for the database
    const isLocationTracked = trackLocation === 'yes';

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name, 
          userId: signupUserId, 
          password: signupPassword,
          emergencyEmail: emergencyEmail || null, 
          trackLocation: isLocationTracked
        })
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
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>
        
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">User ID</label>
          <input 
            type="text" 
            value={signupUserId}
            onChange={(e) => setSignupUserId(e.target.value)}
            placeholder="Choose a unique User ID"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
          <p className="text-lg text-blue-700 mt-2 font-medium">
            Must be 8-15 characters. Letters and numbers only (at least one of each).
          </p>
        </div>
        
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Password</label>
          <input 
            type="password" 
            value={signupPassword}
            onChange={(e) => setSignupPassword(e.target.value)}
            placeholder="Type a password here"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
          <p className="text-lg text-blue-700 mt-2 font-medium leading-tight">
            Must be 8-15 characters. Include at least one letter, one number, and one special character (@ # $).
          </p>
        </div>
        
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Type Password Again</label>
          <input 
            type="password" 
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Type your password again"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>

        {/* --- NEW FIELDS START --- */}
        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Emergency Email (Optional)</label>
          <input 
            type="email" 
            value={emergencyEmail}
            onChange={(e) => setEmergencyEmail(e.target.value)}
            placeholder="e.g. parent@example.com"
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900 placeholder:text-slate-400" 
          />
        </div>

        <div>
          <label className="text-3xl font-bold text-blue-900 mb-3 block">Enable Location Tracking?</label>
          <select 
            value={trackLocation}
            onChange={(e) => setTrackLocation(e.target.value)}
            className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl focus:border-blue-800 outline-none bg-white text-blue-900"
          >
            <option value="no">No</option>
            <option value="yes">Yes</option>
          </select>
          <p className="text-lg text-blue-700 mt-2 font-medium">
            Allows the app to track your current location.
          </p>
        </div>
        {/* --- NEW FIELDS END --- */}
        
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
}
