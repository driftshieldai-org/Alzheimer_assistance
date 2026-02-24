import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Firestore } from '@google-cloud/firestore';

const router = express.Router();

// Initialize Firestore
// Note: When deployed to Cloud Run, this automatically uses the service account credentials!
const db = new Firestore();

// --- SIGNUP ROUTE: Now uses userId instead of email ---
router.post('/signup', async (req, res) => {
  try {
    const { name, userId, password } = req.body; // Changed from email to userId

    // 1. Validation
    if (!name || !userId || !password) { // Validate userId
      return res.status(400).json({ message: 'Please provide name, User ID, and password.' });
    }

    // Normalize userId (e.g., to lowercase) for consistent storage/lookup
    const normalizedUserId = userId.toLowerCase();

    // 2. Reference the user document in Firestore using their userId as the ID
    const userRef = db.collection('users').doc(normalizedUserId);
    const userDoc = await userRef.get();

    // 3. Check if user already exists
    if (userDoc.exists) {
      return res.status(400).json({ message: 'User ID is already taken. Please choose another.' });
    }

    // 4. Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 5. Save the new user to Firestore
    await userRef.set({
      name: name,
      userId: normalizedUserId, // Store userId
      password: hashedPassword,
      createdAt: Firestore.FieldValue.serverTimestamp()
    });

    // 6. Generate JWT Token (payload now contains userId)
    const token = jwt.sign(
      { userId: normalizedUserId, name: name }, // JWT Payload uses userId
      process.env.JWT_SECRET || 'fallback_secret_for_dev',
      { expiresIn: '30d' }
    );

    // 7. Send Success Response
    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        name: name,
        userId: normalizedUserId,
      }
    });

  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ message: 'Server error during signup.' });
  }
});

// --- LOGIN ROUTE: Now uses userId instead of email ---
router.post('/login', async (req, res) => {
  try {
    const { userId, password } = req.body; // Changed from email to userId

    // 1. Validation
    if (!userId || !password) { // Validate userId
      return res.status(400).json({ message: 'Please provide User ID and password.' });
    }

    const normalizedUserId = userId.toLowerCase();
    const userRef = db.collection('users').doc(normalizedUserId);
    const userDoc = await userRef.get();

    // 2. Check if user exists
    if (!userDoc.exists) {
      return res.status(400).json({ message: 'Invalid credentials. Please check User ID or password.' });
    }

    const userData = userDoc.data();

    // 3. Compare passwords (hashed vs. provided)
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials. Please check User ID or password.' });
    }

    // 4. Generate a JWT Token (payload now contains userId)
    const token = jwt.sign(
      { userId: normalizedUserId, name: userData.name }, // JWT Payload uses userId
      process.env.JWT_SECRET || 'fallback_secret_for_dev',
      { expiresIn: '30d' }
    );

    // 5. Send success response
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        name: userData.name,
        userId: normalizedUserId,
      }
    });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

export default router;
