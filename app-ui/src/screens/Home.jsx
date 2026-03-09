import React from 'react';
import { Brain } from 'lucide-react';

export default function Home({ setCurrentScreen }) {
  return (
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
}
