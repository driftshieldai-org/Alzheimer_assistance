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
