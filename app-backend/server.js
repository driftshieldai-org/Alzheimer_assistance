import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes.js';
import photoRoutes from './routes/photoRoutes.js'; // NEW

dotenv.config();

const app = express();

// Middleware
app.use(cors()); 
app.use(express.json()); 

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/photos', photoRoutes); // NEW: Photo upload routes

// Basic health check route for Google Cloud Run
app.get('/health', (req, res) => {
  res.status(200).send('Backend is running healthily!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
