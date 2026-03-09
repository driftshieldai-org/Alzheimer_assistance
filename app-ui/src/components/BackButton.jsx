import React from 'react';
import { ArrowLeft } from 'lucide-react';

export default function BackButton({ onClick }) {
  return (
    <button 
      onClick={onClick}
      className="flex items-center justify-center w-full max-w-xl bg-slate-200 text-blue-900 text-3xl font-bold py-6 px-8 rounded-2xl shadow-md border-4 border-slate-300 hover:bg-slate-300 active:bg-slate-400 transition-colors mt-6"
    >
      <ArrowLeft size={} className="mr-4" />
      Go Back
    </button>
  );
}
src/components/SignOutButton.jsx

import React from 'react';
import { LogOut } from 'lucide-react';

export default function SignOutButton({ setCurrentScreen }) {
  const handleSignOut = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userId');
    setCurrentScreen('home');
  };

  return (
    <button 
      onClick={handleSignOut}
      className="absolute top-6 right-6 flex items-center bg-red-100 text-red-900 px-5 py-3 rounded-2xl shadow-md border-4 border-red-300 hover:bg-red-200 transition-colors font-bold text-xl z-50"
    >
      <LogOut size={24} className="mr-3" />
      Sign Out
    </button>
  );
}
