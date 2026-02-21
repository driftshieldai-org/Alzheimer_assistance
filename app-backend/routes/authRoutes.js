import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Firestore } from '@google-cloud/firestore';

const router = express.Router();


// Initialize Firestore
// Note: When deployed to Cloud Run, this automatically uses the service account credentials!
const db = new Firestore();

router.post('/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 1. Validation
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Please provide all fields.' });
    }

    // Convert email to lowercase to prevent duplicate accounts (e.g., John@v. john@)
    const normalizedEmail = email.toLowerCase();

    // 2. Reference the user document in Firestore using their email as the ID
    const userRef = db.collection('users').doc(normalizedEmail);
    const userDoc = await userRef.get();

    // 3. Check if user already exists
    if (userDoc.exists) {
      return res.status(400).json({ message: 'User already exists with this email.' });
    }

    // 4. Hash the password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 5. Save the new user to Firestore
    await userRef.set({
      name: name,
      email: normalizedEmail,
      password: hashedPassword, // Store the gibberish hash, NEVER the plain text
      createdAt: Firestore.FieldValue.serverTimestamp() // Let Google stamp the exact time
    });

    // 6. Generate JWT Token
    const token = jwt.sign(
      { email: normalizedEmail, name: name },
      process.env.JWT_SECRET || 'fallback_secret_for_dev',
      { expiresIn: '30d' }
    );

    // 7. Send Success Response
    res.status(201).json({
      message: 'User created successfully',
      token,
      user: {
        name: name,
        email: normalizedEmail,
      }
    });

  } catch (error) {
    console.error('Signup Error:', error);
    res.status(500).json({ message: 'Server error during signup.' });
  }
});

// --- NEW: LOGIN ROUTE ---
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Validation
    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide email and password.' });
    }

    const normalizedEmail = email.toLowerCase();
    const userRef = db.collection('users').doc(normalizedEmail);
    const userDoc = await userRef.get();

    // 2. Check if user exists
    if (!userDoc.exists) {
      return res.status(400).json({ message: 'Invalid credentials. Please check email or password.' });
    }

    const userData = userDoc.data();

    // 3. Compare passwords (hashed vs. provided)
    const isMatch = await bcrypt.compare(password, userData.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials. Please check email or password.' });
    }

    // 4. Generate a JWT Token
    const token = jwt.sign(
      { email: normalizedEmail, name: userData.name },
      process.env.JWT_SECRET || 'fallback_secret_for_dev',
      { expiresIn: '30d' }
    );

    // 5. Send success response
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        name: userData.name,
        email: normalizedEmail,
      }
    });

  } catch (error) {
    console.error('Login Error:', error);
    res.status(500).json({ message: 'Server error during login.' });
  }
});

export default router;
