import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import { protect } from '../middleware/authMiddleware.js'; // Import our new middleware
import { v4 as uuidv4 } from 'uuid'; // For unique filenames

const router = express.Router();

const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

const bucketName = process.env.GCS_BUCKET_NAME; // Get bucket name from env var
const bucket = storage.bucket(bucketName);

// Configure Multer to store file in memory (only for Cloud Storage uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // Limit files to 5MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Protect this route with our authentication middleware
router.post('/upload', protect, upload.single('photo'), async (req, res) => {
  try {
    const { description, photoDate } = req.body;
    const userId = req.user.userId; // Get userId from the authenticated request

    // 1. Basic Validation
    if (!req.file) {
      return res.status(400).json({ message: 'No photo file provided.' });
    }
    if (!description || !photoDate) {
      return res.status(400).json({ message: 'Photo description and date are required.' });
    }

    // 2. Generate a unique filename for Cloud Storage
    const fileExtension = req.file.originalname.split('.').pop();
    const fileName = `photos/${userId}/${uuidv4()}.${fileExtension}`; // user_id/unique_id.ext
    const blob = bucket.file(fileName);
    const blobStream = blob.createWriteStream({
      resumable: false,
      metadata: {
        contentType: req.file.mimetype,
      }
    });

    blobStream.on('error', (err) => {
      console.error('GCS Upload Error:', err);
      res.status(500).json({ message: 'Failed to upload photo to storage.' });
    });

    blobStream.on('finish', async () => {
      // 3. Make the image publicly accessible (optional, depends on app needs)
      await blob.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;

      // 4. Save photo metadata to Firestore
      const photoRef = db.collection('users').doc(userId).collection('photos').doc(); // Auto-generate photo ID
      
      await photoRef.set({
        userId: userId,
        description: description,
        photoDate: photoDate,
        imageUrl: publicUrl,
        filename: fileName,
        uploadedAt: Firestore.FieldValue.serverTimestamp()
      });

      res.status(200).json({ 
        message: 'Photo uploaded and details saved successfully!', 
        imageUrl: publicUrl,
        photoId: photoRef.id
      });
    });

    blobStream.end(req.file.buffer);

  } catch (error) {
    console.error('Photo Upload Error:', error);
    if (error.message === 'Only image files are allowed!') {
        return res.status(400).json({ message: error.message });
    }
    res.status(500).json({ message: 'Server error during photo upload.' });
  }
});

export default router;
