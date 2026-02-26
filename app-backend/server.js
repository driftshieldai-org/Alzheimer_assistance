import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import expressWs from 'express-ws'; // NEW: WebSocket integration
import authRoutes from './routes/authRoutes.js';
import photoRoutes from './routes/photoRoutes.js';
import liveRoutes from './routes/liveRoutes.js'; 

dotenv.config();

const app = express();

// IMPORTANT: Apply express-ws to your app instance BEFORE defining routes
const wsInstance = expressWs(app); // This modifies the 'app' object adding .ws

// Middleware
app.use(cors()); 
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/photos', photoRoutes);
// For WebSocket routes, you use app.ws directly or pass the wsInstance
//app.use('/api/live', liveRoutes); 
liveRoutes(app);

// Basic health check route for Google Cloud Run
app.get('/health', (req, res) => {
  res.status(200).send('Backend is running healthily!');
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
