import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { protect } from '../middleware/authMiddleware.js';
import aiSimulator from '../utils/aiSimulator.js'; // Our AI simulation
import multer from 'multer'; // For parsing image data

const router = express.Router();
const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });
const bucketName = process.env.GCS_BUCKET_NAME;
const bucket = storage.bucket(bucketName);

// Multer config for base64 image coming from frontend
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// Endpoint to process a single live frame from the user's camera
router.post('/process-frame', protect, upload.single('frame'), async (req, res) => {
  try {
    const userId = req.user.userId; // Get user ID from authenticated JWT
    
    if (!req.file) {
      return res.status(400).json({ message: 'No image frame provided.' });
    }

    // `req.file.buffer` contains the image data (e.g., JPEG buffer)
    const liveFrameBuffer = req.file.buffer;

    // 1. Fetch user's reference photos metadata from Firestore
    const photosSnapshot = await db.collection('users').doc(userId).collection('photos').get();
    const referencePhotosMetadata = photosSnapshot.docs.map(doc => doc.data());

    // 2. Generate signed URLs for AI Agent to access reference photos (if needed)
    // For our simulator, we're not actually sending to an external AI service yet,
    // so this step is conceptual. A real AI service might need direct access.
    const referencePhotoUrls = await Promise.all(referencePhotosMetadata.map(async (photo) => {
      // In a real scenario, this is where you'd sign the URL for a limited time
      // const [url] = await bucket.file(photo.filename).getSignedUrl({
      //   action: 'read',
      //   expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      // });
      return photo.imageUrl; // For now, just return the public URL
    }));

    // 3. Call the AI Simulator (pass live frame buffer and reference photos)
    const aiResponse = await aiSimulator.processLiveFrame(
      liveFrameBuffer, 
      userId, 
      referencePhotosMetadata
    );

    // 4. Send AI's generated audio back to the frontend
    res.status(200).json({ 
      message: 'Frame processed', 
      description: aiResponse.text,
      audio: aiResponse.audioBase64 
    });

  } catch (error) {
    console.error('Live Frame Processing Error:', error);
    res.status(500).json({ message: 'Server error during live frame processing.' });
  }
});

export default router;
