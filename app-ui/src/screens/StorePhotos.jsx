import React, { useState, useRef, useCallback, useEffect } from 'react';
import Webcam from 'react-webcam';
import { ArrowLeft, Camera as CameraIcon, CheckCircle, ImageIcon, Mic, Upload, X } from 'lucide-react';
import SignOutButton from '../components/SignOutButton';
import BackButton from '../components/BackButton';

export default function StorePhotos({ setCurrentScreen }) {
  const [photoFile, setPhotoFile] = useState(null); 
  const [photoDescription, setPhotoDescription] = useState('');
  const [photoDate, setPhotoDate] = useState('');
  const [photoUploadErrorMsg, setPhotoUploadErrorMsg] = useState('');
  const [isPhotoUploading, setIsPhotoUploading] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  
  const [isCameraActive, setIsCameraActive] = useState(false); 
  const [capturedImageSrc, setCapturedImageSrc] = useState(null);
  const [isListening, setIsListening] = useState(false);

  const fileInputRef = useRef(null);
  const webcamRefCapture = useRef(null); 
  const speechRecognitionRef = useRef(null);
  const originalTextRef = useRef('');
  const videoConstraintsCapture = { facingMode: "environment" };
  
  useEffect(() => {
    let timer;
    if (showSuccess) {
      timer = setTimeout(() => {
        setShowSuccess(false);
        setCurrentScreen('dashboard');
      }, 2000);
    }
    return () => clearTimeout(timer);
  }, [showSuccess, setCurrentScreen]);

  const startListening = (e) => {
    e.preventDefault();
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser. Please type instead.");
      return;
    }
    originalTextRef.current = photoDescription;
    setIsListening(true);
    speechRecognitionRef.current = new SpeechRecognition();
    speechRecognitionRef.current.continuous = true;
    speechRecognitionRef.current.interimResults = true;
    speechRecognitionRef.current.onresult = (event) => {
      let currentTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        currentTranscript += event.results[i][0].transcript;
      }
      const space = originalTextRef.current ? ' ' : '';
      setPhotoDescription(originalTextRef.current + space + currentTranscript);
    };
    speechRecognitionRef.current.onerror = () => setIsListening(false);
    speechRecognitionRef.current.onend = () => setIsListening(false);
    speechRecognitionRef.current.start();
  };

  const stopListening = (e) => {
    e.preventDefault();
    if (speechRecognitionRef.current) speechRecognitionRef.current.stop();
    setIsListening(false);
  };

  const handlePhotoUpload = async (e) => {
    e.preventDefault();
    setIsPhotoUploading(true);
    setPhotoUploadErrorMsg('');

    let photoToSend = photoFile;
    if (capturedImageSrc) {
      try {
        const response = await fetch(capturedImageSrc);
        const blob = await response.blob();
        photoToSend = new File([blob], `captured_${Date.now()}.jpeg`, { type: blob.type });
      } catch (error) {
        setPhotoUploadErrorMsg('Failed to process captured image.');
        setIsPhotoUploading(false);
        return;
      }
    }
     
    if (!photoToSend || !photoDescription || !photoDate) {
      setPhotoUploadErrorMsg('Please provide photo, description, and date.');
      setIsPhotoUploading(false);
      return;
    }

    const token = localStorage.getItem('token');
    if (!token) {
      setPhotoUploadErrorMsg('You must be logged in.');
      setCurrentScreen('login');
      return;
    }

        
    const formData = new FormData();
    formData.append('photo', photoToSend);
    formData.append('description', photoDescription);
    formData.append('photoDate', photoDate);

    try {
      const response = await fetch('/api/photos/upload', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
      if (response.ok) {
        setShowSuccess(true);
      } else {
        const data = await response.json();
        setPhotoUploadErrorMsg(data.message || 'Upload failed.');
      }
    } catch (err) {
      setPhotoUploadErrorMsg('Server error. Failed to upload.');
    } finally {
      setIsPhotoUploading(false);
    }
  };

  const capturePhoto = useCallback(() => {
    const imageSrc = webcamRefCapture.current.getScreenshot({ width: 1280, height: 720 }); 
    setCapturedImageSrc(imageSrc);
    setPhotoFile(null); 
    setPhotoUploadErrorMsg('');
  }, [webcamRefCapture]);

  return (
    <div className="flex flex-col items-center min-h-screen p-6 pt-10 animate-in fade-in relative">
      <SignOutButton setCurrentScreen={setCurrentScreen} />
      <h2 className="text-5xl font-extrabold text-blue-900 mt-8 mb-8 text-center">Store A Photo</h2>
      <div className="w-full max-w-2xl flex flex-col space-y-8">
        
        {photoUploadErrorMsg && (
          <div className="bg-red-100 text-red-900 p-6 rounded-2xl text-2xl font-bold border-4 border-red-300 text-center animate-in fade-in">
            {photoUploadErrorMsg}
          </div>
        )}

        {!isCameraActive && !photoFile && !capturedImageSrc && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
            <button onClick={() => fileInputRef.current.click()} className="flex flex-col items-center justify-center bg-blue-100 border-4 border-blue-300 text-blue-900 p-8 rounded-2xl shadow-md hover:bg-blue-200">
              <Upload size={64} className="mb-4" />
              <span className="text-3xl font-bold">Upload from Device</span>
            </button>
            <button onClick={() => setIsCameraActive(true)} className="flex flex-col items-center justify-center bg-green-100 border-4 border-green-300 text-green-900 p-8 rounded-2xl shadow-md hover:bg-green-200">
              <CameraIcon size={64} className="mb-4 text-green-900" />
              <span className="text-3xl font-bold text-green-900">Take a Photo Now</span>
            </button>
          </div>
        )}

        {isCameraActive && !capturedImageSrc && (
          <div className="bg-slate-800 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-slate-900 shadow-2xl space-y-6">
            <Webcam audio={false} ref={webcamRefCapture} screenshotFormat="image/jpeg" videoConstraints={{ videoConstraintsCapture }} className="rounded-xl w-full max-w-2xl aspect-video object-cover" />
            <div className="flex w-full justify-around space-x-4">
              <button onClick={capturePhoto} className="flex-1 bg-green-700 text-white text-3xl font-bold py-6 rounded-2xl flex items-center justify-center">
                <CameraIcon size={32} className="mr-4" /> Capture Photo
              </button>
              <button onClick={() => setIsCameraActive(false)} className="flex-1 bg-red-100 text-red-900 text-3xl font-bold py-6 rounded-2xl flex items-center justify-center">
                <ArrowLeft size={32} className="mr-4" /> Cancel
              </button>
            </div>
          </div>
        )}

        {capturedImageSrc && (
          <div className="bg-slate-100 rounded-3xl p-4 flex flex-col items-center justify-center border-8 border-blue-500 shadow-2xl space-y-6">
            <h3 className="text-3xl font-bold text-blue-900 mt-2">Captured Photo Preview:</h3>
            <img src={capturedImageSrc} alt="Captured" className="rounded-xl max-w-full h-auto max-h-96 object-contain border-4 border-blue-300" />
            <div className="flex w-full justify-around space-x-4">
              <button onClick={() => setCapturedImageSrc(null)} className="flex-1 bg-orange-500 text-white text-3xl font-bold py-6 rounded-2xl flex items-center justify-center">
                <ArrowLeft size={32} className="mr-4" /> Retake Photo
              </button>
              <button onClick={handlePhotoUpload} disabled={isPhotoUploading || !photoDescription || !photoDate} className="flex-1 bg-blue-700 text-white text-3xl font-bold py-6 rounded-2xl flex items-center justify-center disabled:opacity-70">
                {isPhotoUploading ? 'Uploading...' : 'Use & Save Photo'}
              </button>
            </div>
          </div>
        )}

        {photoFile && !isCameraActive && !capturedImageSrc && (
          <div className="bg-blue-50 border-8 border-dashed border-blue-300 rounded-3xl p-12 flex flex-col items-center justify-center shadow-md">
            <ImageIcon size={64} className="text-blue-800 mb-4" />
            <span className="text-3xl font-bold text-blue-900 text-center">{photoFile.name}</span>
            <button onClick={() => { setPhotoFile(null); if(fileInputRef.current) fileInputRef.current.value = null; }} className="mt-6 px-6 py-3 bg-red-500 text-white text-xl font-bold rounded-xl hover:bg-red-600">
              Remove Photo
            </button>
          </div>
        )}

        <input type="file" accept="image/*" onChange={(e) => e.target.files && setPhotoFile(e.target.files[0])} ref={fileInputRef} className="hidden" />

        {(photoFile || capturedImageSrc || (!photoFile && !capturedImageSrc && !isCameraActive)) && (
          <>
            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 flex justify-between items-end">
                <span>Who or what is in this photo?</span>
                <span className="text-xl text-blue-600 font-medium pb-1">(Hold mic to speak)</span>
              </label>
              <div className="relative">
                <textarea rows={3} value={photoDescription} onChange={(e) => setPhotoDescription(e.target.value)} placeholder="Type or speak details for this picture..." className="w-full text-3xl p-6 pr-24 pt-6 border-4 border-blue-300 rounded-2xl outline-none bg-white text-blue-900 resize-none" />
                {photoDescription && (
                  <button onClick={() => setPhotoDescription('')} className="absolute right-4 top-4 p-3 bg-slate-100 text-slate-500 hover:bg-red-100 hover:text-red-600 rounded-full">
                    <X size={32} />
                  </button>
                )}
                <button onMouseDown={startListening} onMouseUp={stopListening} onMouseLeave={stopListening} onTouchStart={startListening} onTouchEnd={stopListening} className={`absolute right-4 bottom-4 p-4 rounded-full shadow-lg ${isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-blue-200 text-blue-800'}`}>
                  <Mic size={40} />
                </button>
              </div>
            </div>
            <div>
              <label className="text-3xl font-bold text-blue-900 mb-4 block">Date of photo</label>
              <input type="date" value={photoDate} onChange={(e) => setPhotoDate(e.target.value)} className="w-full text-3xl p-6 border-4 border-blue-300 rounded-2xl outline-none bg-white text-blue-900" />
            </div>
          </>
        )}

        {(photoFile && !capturedImageSrc) && (
          <div className="flex flex-col space-y-6 pt-6">
            <button onClick={handlePhotoUpload} disabled={isPhotoUploading || !photoDescription || !photoDate} className="w-full bg-green-700 text-white text-4xl font-extrabold py-8 rounded-2xl shadow-xl disabled:opacity-70">
              {isPhotoUploading ? 'Uploading...' : 'Save Photo'}
            </button>
          </div>
        )}

        {!(isCameraActive && !capturedImageSrc) && (
          <div className="flex w-full justify-center mt-2">
            <BackButton onClick={() => setCurrentScreen('dashboard')} />
          </div>
        )}
      </div>

      {showSuccess && (
        <div className="fixed inset-0 bg-blue-950/90 flex flex-col items-center justify-center z-50 p-6 animate-in fade-in" onClick={() => { setShowSuccess(false); setCurrentScreen('dashboard'); }}>
          <div className="bg-white rounded-3xl p-12 max-w-2xl w-full flex flex-col items-center text-center shadow-2xl border-8 border-green-500">
            <CheckCircle size={120} className="text-green-600 mb-8" />
            <h2 className="text-5xl font-extrabold text-blue-900 leading-tight">Information has been stored safely!</h2>
          </div>
        </div>
      )}
    </div>
  );
}
