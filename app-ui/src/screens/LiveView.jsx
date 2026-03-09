import React, { useState, useEffect, useRef } from 'react';
import Webcam from 'react-webcam';
import { Mic, StopCircle, Video } from 'lucide-react';
import SignOutButton from '../components/SignOutButton';
import BackButton from '../components/BackButton';
import { AUDIO_WORKLET_CODE, initPlaybackContext, clearAudioQueue, playPcmAudio } from '../utils/audioUtils';

const BACKEND_API_BASE = "https://alzheimer-backend-902738993392.us-central1.run.app";

export default function LiveView({ setCurrentScreen }) {
  const [isLiveAssistanceActive, setIsLiveAssistanceActive] = useState(false);
  const [liveVideoError, setLiveVideoError] = useState('');
  const [aiTextResponse, setAiTextResponse] = useState('');
  
  const webcamRefLive = useRef(null); 
  const wsRef = useRef(null); 
  const frameIntervalRef = useRef(null); 
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);

  // Automatically cleans up stream if the user navigates away
  useEffect(() => {
    return () => {
      stopLiveAssistance();
    };
  }, []);

  const startMicCapture = async () => {
    try {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      micStreamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const blob = new Blob([AUDIO_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);

      const workletNode = new AudioWorkletNode(audioCtx, 'audio-processor');
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (event) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
        const { type, buffer } = event.data;
        if (type === 'audio' && buffer) {
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          wsRef.current.send(JSON.stringify({ type: "audio", audioBase64: window.btoa(binary) }));
        }
      };

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(workletNode);
    } catch (err) {
      setLiveVideoError("Microphone access failed: " + err.message);
    }
  };

  const sendVideoFrame = () => {
    if (!webcamRefLive.current || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    try {
      const imageSrc = webcamRefLive.current.getScreenshot({ width: 640, height: 480 });
      if (imageSrc) {
        const base64Data = imageSrc.split(',')[1];
        wsRef.current.send(JSON.stringify({ type: "frame", frameBase64: base64Data }));
      }
    } catch (err) {
      console.error("Error capturing frame:", err);
    }
  };
  
  const startLiveAssistance = async () => {
    const ctx = initPlaybackContext();
    if (ctx.state === 'suspended') await ctx.resume();
     
    const token = localStorage.getItem('token');
    if (!token) {
      setLiveVideoError("Please log in to use live assistance.");
      setCurrentScreen('login');
      return;
    }

    setIsLiveAssistanceActive(true);
    setLiveVideoError('');
    setAiTextResponse('');
    clearAudioQueue();

    const wsUrl = `wss://${new URL(BACKEND_API_BASE).host}/api/live/ws/live/process-stream?token=${token}`;
    wsRef.current = new WebSocket(wsUrl);

    wsRef.current.onopen = () => {
      startMicCapture();
      frameIntervalRef.current = setInterval(sendVideoFrame, 2000);
    };

    wsRef.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "audioResponse" && data.audioBase64) playPcmAudio(data.audioBase64);
        if (data.type === "textResponse" && data.text) setAiTextResponse(prev => prev + data.text);
        if (data.type === "interrupted") clearAudioQueue();
        if (data.error) setLiveVideoError(`AI Error: ${data.error}`);
      } catch (err) {}
    };

    wsRef.current.onerror = () => {
      setLiveVideoError("Connection error. Please try again.");
      stopLiveAssistance();
    };

    wsRef.current.onclose = () => {
      if (isLiveAssistanceActive) stopLiveAssistance();
    };
  };
  
  const stopLiveAssistance = () => {
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    if (wsRef.current) wsRef.current.close();
    if (workletNodeRef.current) workletNodeRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(track => track.stop());
    
    frameIntervalRef.current = null;
    wsRef.current = null;
    workletNodeRef.current = null;
    audioContextRef.current = null;
    micStreamRef.current = null;

    clearAudioQueue();
    setIsLiveAssistanceActive(false);
    setAiTextResponse('');
  };

  return (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 bg-slate-100 animate-in fade-in relative">
      <SignOutButton setCurrentScreen={setCurrentScreen} />
      <h2 className="text-5xl font-extrabold text-blue-900 mt-8 mb-8 text-center">Live Assistance</h2>
      
      {liveVideoError && (
        <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center mb-8">
          {}
        </div>
      )}

      {isLiveAssistanceActive ? (
        <>
          <div className="w-full max-w-3xl bg-slate-800 aspect-video rounded-3xl flex flex-col items-center justify-center shadow-2xl border-8 border-slate-900 mb-10 overflow-hidden relative">
            <Webcam audio={} ref={} screenshotFormat="image/jpeg" videoConstraints={{ facingMode: "environment" }} className="rounded-xl w-full h-full object-cover" />
            <div className="absolute top-6 right-6 flex items-center bg-black/50 px-4 py-2 rounded-full">
              <div className="w-6 h-6 rounded-full bg-red-500 animate-pulse mr-3"></div>
              <span className="text-white text-xl font-bold">LIVE STREAM</span>
            </div>
          </div>
          <div className="flex flex-col items-center justify-center space-y-6 mb-12 p-8 bg-blue-50 rounded-3xl border-4 border-blue-200 w-full max-w-3xl">
            <div className="flex items-center space-x-6 text-blue-800">
              <Mic size={} className="bg-blue-200 p-3 rounded-full animate-pulse" />
              <div className="flex space-x-2">
                <div className="w-4 h-12 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-4 h-16 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-4 h-10 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                <div className="w-4 h-14 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '450ms' }}></div>
              </div>
            </div>
            <span className="text-3xl font-bold text-blue-900 text-center">Listening and analyzing context in real time...</span>
            {aiTextResponse && (
              <p className="text-2xl text-blue-800 text-center mt-4 p-4 bg-white rounded-xl">
                {}
              </p>
            )}
          </div>
          <button onClick={} className="w-full max-w-3xl bg-red-700 text-white text-5xl font-extrabold py-10 rounded-3xl shadow-2xl hover:bg-red-800 active:bg-red-900 border-8 border-red-900 transition-all mt-auto mb-6 flex justify-center items-center">
            <StopCircle size={} className="mr-6" /> Stop Live Assistance
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center p-6 space-y-8 w-full max-w-3xl">
          <button onClick={} className="w-full bg-teal-600 text-white text-5xl font-extrabold py-12 rounded-3xl shadow-2xl hover:bg-teal-700 active:bg-teal-800 border-8 border-teal-800 transition-all">
            <Video size={} className="inline mr-6" /> Start Live Assistance
          </button>
          <BackButton onClick={() => setCurrentScreen('dashboard')} />
        </div>
      )}
    </div>
  );
}
