import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/authRoutes.js';

// Load environment variables
dotenv.config();

const app = express();

// Middleware
// CORS allows your React frontend (running on port 5173) to talk to this backend
app.use(cors()); 
// Allows Express to understand JSON data sent from React
app.use(express.json()); 

// Routes
app.use('/api/auth', authRoutes);

// Basic health check route for Google Cloud Run
app.get('/health', (req, res) => {
  res.status(200).send('Backend is running healthily!');
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
