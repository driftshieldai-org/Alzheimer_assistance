import React from 'react';
import { Camera, Video } from 'lucide-react';
import SignOutButton from '../components/SignOutButton';

export default function Dashboard({ setCurrentScreen }) {
  return (
    <div className="flex flex-col items-center min-h-screen p-6 pt-12 animate-in fade-in relative">
      <SignOutButton setCurrentScreen={setCurrentScreen} />
      
      <h2 className="text-4xl md:text-5xl font-extrabold text-blue-900 mt-16 mb-12 text-center max-w-3xl leading-tight">
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
}
