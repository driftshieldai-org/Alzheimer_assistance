import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { Firestore } from '@google-cloud/firestore';
import { protect } from '../middleware/authMiddleware.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

const db = new Firestore({ projectId: process.env.GCP_PROJECT_ID });
const storage = new Storage({ projectId: process.env.GCP_PROJECT_ID });

const bucketName = process.env.GCS_BUCKET_NAME;
const bucket = storage.bucket(bucketName);

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

router.post('/upload', protect, upload.single('photo'), async (req, res) => {
  try {
    const { description, photoDate } = req.body;
    const userId = req.user.userId;

    if (!req.file) {
      return res.status(400).json({ message: 'No photo file provided.' });
    }
    if (!description || !photoDate) {
      return res.status(400).json({ message: 'Photo description and date are required.' });
    }

    const fileExtension = req.file.originalname.split('.').pop();
    // Corrected fileName construction to include user ID and proper uuid/extension
    const fileName = `photos/${userId}/${uuidv4()}.${fileExtension}`; 
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
      // *** REMOVED: await blob.makePublic(); ***
      // We are not making the image publicly accessible anymore.
      // The 'imageUrl' in Firestore will now store the GCS object name/path.

      // 4. Save photo metadata to Firestore
      const photoRef = db.collection('users').doc(userId).collection('photos').doc();
        
      await photoRef.set({
        userId: userId,
        description: description,
        photoDate: photoDate,
        // Store the GCS object name (fileName) instead of a public URL
        imageUrl: fileName, 
        filename: fileName, // Keeping filename for consistency in your existing code
        uploadedAt: Firestore.FieldValue.serverTimestamp()
      });

      res.status(200).json({ 
        message: 'Photo uploaded and details saved successfully!', 
        // Return the GCS object name as the reference
        gcsObjectName: fileName, 
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
