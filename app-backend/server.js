import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes.js';
import photoRoutes from './routes/photoRoutes.js';
import liveRoutes from './routes/liveRoutes.js'; // NEW

// Load environment variables
dotenv.config();

const app = express();

// Middleware
app.use(cors()); 
app.use(express.json({ limit: '10mb' })); // Increase JSON body limit for base64 images
// For file uploads (which `multer` handles), ensure express.urlencoded isn't interfering negatively
app.use(express.urlencoded({ extended: true, limit: '10mb' }));


// Routes
app.use('/api/auth', authRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/live', liveRoutes); // NEW: Live processing routes

// Basic health check route for Google Cloud Run
app.get('/health', (req, res) => {
  res.status(200).send('Backend is running healthily!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
