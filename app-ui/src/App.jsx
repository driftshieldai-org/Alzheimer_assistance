import React, { useState, useEffect } from 'react';
import Home from './screens/Home';
import Login from './screens/Login';
import Signup from './screens/Signup';
import Dashboard from './screens/Dashboard';
import StorePhotos from './screens/StorePhotos';
import LiveView from './screens/LiveView';

export default function App() {
  // Read the last visited screen from localStorage so it survives a refresh
  const [currentScreen, setCurrentScreen] = useState(() => {
    return localStorage.getItem('currentScreen') || 'home';
  });

  // Save the current screen to localStorage every time it changes
  useEffect(() => {
    localStorage.setItem('currentScreen', currentScreen);
  }, [currentScreen]);

  return (
    <div className="min-h-screen bg-slate-50 font-sans selection:bg-blue-200">
      {currentScreen === 'home' && <Home setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'login' && <Login setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'signup' && <Signup setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'dashboard' && <Dashboard setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'store_photos' && <StorePhotos setCurrentScreen={setCurrentScreen} />}
      {currentScreen === 'live_view' && <LiveView setCurrentScreen={setCurrentScreen} />}
    </div>
  );
}
